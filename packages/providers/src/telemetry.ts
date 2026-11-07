import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OpenAIInstrumentation } from '@arizeai/openinference-instrumentation-openai';
import { OpenInferenceSpanKind, SEMRESATTRS_PROJECT_NAME, SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import { type Attributes, type AttributeValue, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import OpenAI from 'openai';
import { redactText } from './redaction';

export const ARIZE_OTLP_ENDPOINT = 'https://otlp.arize.com/v1/traces';
export { OpenInferenceSpanKind, SemanticConventions };

const MAX_ATTR_CHARS = 16_000;

function redactAttr(v: AttributeValue | undefined): AttributeValue | undefined {
  if (typeof v === 'string') return redactText(v, { maxLength: MAX_ATTR_CHARS });
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? redactText(x, { maxLength: MAX_ATTR_CHARS }) : x)) as AttributeValue;
  return v;
}

export function redactAttributes(attrs: Attributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (/api[_-]?key|authorization|password|secret|token(?!s)/i.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = redactAttr(v);
  }
  return out;
}

function redactSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status.message ? { ...span.status, message: redactText(span.status.message) } : span.status,
    attributes: redactAttributes(span.attributes),
    links: span.links,
    events: span.events.map((e) => ({ ...e, attributes: e.attributes ? redactAttributes(e.attributes) : undefined })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export interface ExportStats {
  batches: number;
  spans: number;
  failures: number;
  lastError?: string;
  lastSuccessAt?: string;
}

/** Redacts every span before handing it to the wrapped exporter and records export outcomes. */
export class RedactingExporter implements SpanExporter {
  readonly stats: ExportStats = { batches: 0, spans: 0, failures: 0 };

  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans.map(redactSpan), (result) => {
      this.stats.batches++;
      if (result.code === ExportResultCode.SUCCESS) {
        this.stats.spans += spans.length;
        this.stats.lastSuccessAt = new Date().toISOString();
      } else {
        this.stats.failures++;
        this.stats.lastError = result.error?.message ?? 'export failed';
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** Writes redacted spans as JSON lines locally so runs have trace evidence even without Arize. */
export class JsonlSpanExporter implements SpanExporter {
  constructor(private readonly file: string) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const lines = spans
      .map((s) => {
        const ctx = s.spanContext();
        return JSON.stringify({
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId: s.parentSpanContext?.spanId,
          name: s.name,
          kind: s.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND],
          start: hrToMs(s.startTime),
          end: hrToMs(s.endTime),
          durationMs: hrToMs(s.duration),
          status: s.status,
          attributes: redactAttributes(s.attributes),
        });
      })
      .join('\n');
    mkdir(dirname(this.file), { recursive: true })
      .then(() => appendFile(this.file, `${lines}\n`))
      .then(
        () => resultCallback({ code: ExportResultCode.SUCCESS }),
        (error: Error) => resultCallback({ code: ExportResultCode.FAILED, error }),
      );
  }

  async shutdown(): Promise<void> {}
}

function hrToMs(t: [number, number]): number {
  return t[0] * 1000 + t[1] / 1e6;
}

export interface TelemetryOptions {
  projectName: string;
  arize?: { spaceId: string; apiKey: string } | null;
  localTraceFile?: string | null;
}

export interface Telemetry {
  readonly arizeEnabled: boolean;
  readonly arizeStats: ExportStats | null;
  readonly localTraceFile: string | null;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

let active: Telemetry | null = null;

/**
 * Registers the global tracer provider and OpenAI auto-instrumentation. Must run before any
 * OpenAI client is constructed. Safe to call once per process.
 */
export function initTelemetry(opts: TelemetryOptions): Telemetry {
  if (active) return active;
  const processors: SpanProcessor[] = [];
  let arizeExporter: RedactingExporter | null = null;
  if (opts.arize) {
    arizeExporter = new RedactingExporter(
      new OTLPTraceExporter({
        url: ARIZE_OTLP_ENDPOINT,
        headers: { 'arize-space-id': opts.arize.spaceId, 'arize-api-key': opts.arize.apiKey },
      }),
    );
    processors.push(new BatchSpanProcessor(arizeExporter, { scheduledDelayMillis: 1000 }));
  }
  if (opts.localTraceFile) {
    processors.push(new BatchSpanProcessor(new JsonlSpanExporter(opts.localTraceFile), { scheduledDelayMillis: 500 }));
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.projectName,
      [SEMRESATTRS_PROJECT_NAME]: opts.projectName,
    }),
    spanProcessors: processors,
  });
  provider.register();

  const instrumentation = new OpenAIInstrumentation({
    traceConfig: { hideInputImages: true, base64ImageMaxLength: 0 },
  });
  instrumentation.manuallyInstrument(OpenAI as unknown as Parameters<OpenAIInstrumentation['manuallyInstrument']>[0]);
  registerInstrumentations({ instrumentations: [instrumentation] });

  active = {
    arizeEnabled: arizeExporter !== null,
    arizeStats: arizeExporter?.stats ?? null,
    localTraceFile: opts.localTraceFile ?? null,
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
  return active;
}

export function getTelemetry(): Telemetry | null {
  return active;
}

export const tracer = () => trace.getTracer('commandos', '0.1.0');

/** Runs `fn` inside an active span with an OpenInference span kind; records errors and status. */
export async function withSpan<T>(
  name: string,
  kind: OpenInferenceSpanKind,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { attributes: { [SemanticConventions.OPENINFERENCE_SPAN_KIND]: kind, ...attrs } },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

export function spanJson(value: unknown): string {
  try {
    return redactText(JSON.stringify(value), { maxLength: MAX_ATTR_CHARS });
  } catch {
    return '[unserializable]';
  }
}
