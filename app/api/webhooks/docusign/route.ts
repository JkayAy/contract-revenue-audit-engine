import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { acquireIdempotencyLock } from '@/lib/redis';
import { enqueueAuditJob, sendToDeadLetterQueue, type AuditJobPayload } from '@/lib/queue';

export const runtime = 'nodejs';

interface DocuSignWebhookBody {
    event: string;
    data: {
      envelopeId: string;
      envelopeSummary?: {
        status?: string;
        customFields?: {
          textCustomFields?: Array<{ name: string; value: string }>;
        };
      };
    };
}

function timingSafeEqualHex(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'hex');
    const bufferB = Buffer.from(b, 'hex');

  if (bufferA.length !== bufferB.length) {
        return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
    const secret = process.env.DOCUSIGN_WEBHOOK_SECRET;

  if (!secret) {
        throw new Error('DOCUSIGN_WEBHOOK_SECRET is not configured.');
  }

  if (!signatureHeader) {
        return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  try {
        return timingSafeEqualHex(expected, signatureHeader.replace(/^sha256=/, ''));
  } catch {
        return false;
  }
}

function extractCustomField(
    body: DocuSignWebhookBody,
    fieldName: string
  ): string | undefined {
    const fields = body.data.envelopeSummary?.customFields?.textCustomFields ?? [];
    return fields.find((field) => field.name === fieldName)?.value;
}

/**
 * Inbound webhook gateway for DocuSign Connect events.
 *
 * Responsibilities:
 * 1. Verify the HMAC SHA-256 signature so only genuine DocuSign
 *    requests are accepted.
 * 2. De-duplicate deliveries using a Redis idempotency lock, since
 *    webhook providers may redeliver the same event multiple times.
 * 3. Enqueue a normalized job payload onto the BullMQ audit queue for
 *    asynchronous processing by the worker process.
 * 4. On any unrecoverable failure after the signature check passes,
 *    persist the payload to a dead-letter queue instead of dropping it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
    const rawBody = await request.text();
    const signatureHeader = request.headers.get('x-docusign-signature-1');

  let isValidSignature: boolean;
    try {
          isValidSignature = verifySignature(rawBody, signatureHeader);
    } catch (error) {
          console.error('[docusign-webhook] signature verification misconfigured', error);
          return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

  if (!isValidSignature) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: DocuSignWebhookBody;
    try {
          body = JSON.parse(rawBody) as DocuSignWebhookBody;
    } catch {
          return NextResponse.json({ error: 'Malformed JSON payload' }, { status: 400 });
    }

  const envelopeId = body?.data?.envelopeId;
    if (!envelopeId) {
          return NextResponse.json({ error: 'Missing envelopeId' }, { status: 400 });
    }

  const organizationId = extractCustomField(body, 'organizationId');
    const contractId = extractCustomField(body, 'contractId');

  if (!organizationId || !contractId) {
        return NextResponse.json(
          { error: 'Missing organizationId or contractId custom fields' },
          { status: 400 }
              );
  }

  const idempotencyKey = `docusign:${envelopeId}:${body.event}`;
    const lockAcquired = await acquireIdempotencyLock(idempotencyKey);

  if (!lockAcquired) {
        return NextResponse.json({ status: 'duplicate-ignored' }, { status: 200 });
  }

  const payload: AuditJobPayload = {
        organizationId,
        contractId,
        envelopeId,
        eventType: body.event,
        receivedAt: new Date().toISOString(),
        rawPayload: body as unknown as Record<string, unknown>,
  };

  try {
        const jobId = await enqueueAuditJob(payload);
        return NextResponse.json({ status: 'queued', jobId }, { status: 202 });
  } catch (error) {
        console.error('[docusign-webhook] failed to enqueue audit job', error);

      try {
              await sendToDeadLetterQueue(
                        payload,
                        error instanceof Error ? error.message : 'Unknown enqueue failure',
                        0
                      );
      } catch (dlqError) {
              console.error('[docusign-webhook] failed to write to dead-letter queue', dlqError);
      }

      return NextResponse.json({ error: 'Failed to enqueue audit job' }, { status: 500 });
  }
}
