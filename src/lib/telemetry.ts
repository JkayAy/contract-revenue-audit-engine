/**
 * telemetry.ts
 *
 * OpenTelemetry instrumentation for the contract-revenue-audit-engine.
 *
 * Exports a single `tracer` instance and a convenience `withSpan` helper
 * for wrapping async functions in traced spans.  The OTLP exporter is
 * configured via environment variables so the same code works locally
 * (exporting to a local Jaeger / Grafana Tempo instance) and in
 * production (exporting to Grafana Cloud or a self-hosted collector).
 *
 * Call `initTelemetry()` once at process start - in worker.ts before
 * `startWorker()` and in the Next.js instrumentation.ts file.
 *
 * Required packages:
 *   @opentelemetry/sdk-node
 *   @opentelemetry/auto-instrumentations-node
 *   @opentelemetry/exporter-trace-otlp-http
 *   @opentelemetry/api
 *
 * Environment variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. http://localhost:4318  (default)
 *   OTEL_SERVICE_NAME             e.g. contract-audit-engine
 *   OTEL_SERVICE_VERSION          e.g. 1.0.0
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, type Tracer, SpanStatusCode, type Span } from '@opentelemetry/api';

let _sdk: NodeSDK | null = null;

/** Initialise the OpenTelemetry SDK. Idempotent - safe to call multiple times. */
export function initTelemetry(): void {
  if (_sdk) return;

  const exporter = new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`
        : 'http://localhost:4318/v1/traces',
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
      ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS)
      : {},
  });

  _sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]:
        process.env.OTEL_SERVICE_NAME ?? 'contract-audit-engine',
      [SemanticResourceAttributes.SERVICE_VERSION]:
        process.env.OTEL_SERVICE_VERSION ?? '1.0.0',
    }),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  _sdk.start();

  process.on('SIGTERM', () => {
    _sdk
      ?.shutdown()
      .then(() => console.info('[telemetry] SDK shut down successfully'))
      .catch((err) => console.error('[telemetry] SDK shutdown error', err));
  });
}

/** Shared tracer for the audit engine. */
export const tracer: Tracer = trace.getTracer(
  'contract-audit-engine',
  process.env.OTEL_SERVICE_VERSION ?? '1.0.0',
);

/**
 * Wrap an async function in an OpenTelemetry span.
 *
 * Sets the span status to OK on success, ERROR on exception, and always
 * ends the span so it is never leaked.
 *
 * @example
 * const result = await withSpan('audit.extractClauses', { contractId }, () =>
 *   extractContractClauses(contractText),
 * );
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
