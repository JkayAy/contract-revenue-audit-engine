import { Queue, type JobsOptions } from 'bullmq';
import { getRedisClient } from './redis';

export const AUDIT_QUEUE_NAME = 'contract-audit';
export const AUDIT_DLQ_NAME = 'contract-audit-dlq';

export interface AuditJobPayload {
    organizationId: string;
    contractId: string;
    envelopeId: string;
    eventType: string;
    receivedAt: string;
    rawPayload: Record<string, unknown>;
}

export interface DeadLetterPayload extends AuditJobPayload {
    failedReason: string;
    attemptsMade: number;
    failedAt: string;
}

const defaultJobOptions: JobsOptions = {
    attempts: 5,
    backoff: {
          type: 'exponential',
          delay: 2000,
    },
    removeOnComplete: {
          age: 60 * 60 * 24 * 7,
          count: 1000,
    },
    removeOnFail: false,
};

let auditQueue: Queue<AuditJobPayload> | undefined;
let auditDeadLetterQueue: Queue<DeadLetterPayload> | undefined;

export function getAuditQueue(): Queue<AuditJobPayload> {
    if (!auditQueue) {
          auditQueue = new Queue<AuditJobPayload>(AUDIT_QUEUE_NAME, {
                  connection: getRedisClient(),
                  defaultJobOptions,
          });
    }
    return auditQueue;
}

export function getAuditDeadLetterQueue(): Queue<DeadLetterPayload> {
    if (!auditDeadLetterQueue) {
          auditDeadLetterQueue = new Queue<DeadLetterPayload>(AUDIT_DLQ_NAME, {
                  connection: getRedisClient(),
                  defaultJobOptions: {
                            attempts: 1,
                            removeOnComplete: false,
                            removeOnFail: false,
                  },
          });
    }
    return auditDeadLetterQueue;
}

/**
 * Enqueue a validated webhook event for asynchronous audit processing.
 * The jobId is derived from the envelope id so retried webhook deliveries
 * naturally deduplicate at the queue level as a secondary safety net,
 * in addition to the Redis idempotency lock applied at the route handler.
 */
export async function enqueueAuditJob(payload: AuditJobPayload): Promise<string> {
    const queue = getAuditQueue();
    const job = await queue.add('audit-contract', payload, {
          jobId: `${payload.organizationId}:${payload.envelopeId}`,
    });
    return job.id ?? `${payload.organizationId}:${payload.envelopeId}`;
}

/**
 * Move a permanently failed job payload to the dead-letter queue so it can
 * be inspected and manually replayed by an operator, instead of being
 * silently dropped after BullMQ exhausts its retry attempts.
 */
export async function sendToDeadLetterQueue(
    payload: AuditJobPayload,
    failedReason: string,
    attemptsMade: number
  ): Promise<void> {
    const dlq = getAuditDeadLetterQueue();
    await dlq.add('dead-letter', {
          ...payload,
          failedReason,
          attemptsMade,
          failedAt: new Date().toISOString(),
    });
}
