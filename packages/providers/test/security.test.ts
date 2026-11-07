import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { MemorySecretError, ProcedureMemory } from '../src/memory';
import { RedactingExporter } from '../src/telemetry';

describe('memory secret filter', () => {
  it('refuses to store secrets before making any request', async () => {
    // unroutable endpoint: the call must fail on the guard, not on the network
    const mem = new ProcedureMemory({ endpoint: 'http://127.0.0.1:9', context: 'ctx', apiKey: 'sp-test' }, 'tester');
    await expect(
      mem.rememberOutcome({ intent: 'x', command: 'my password: hunter2hunter2', success: true, summary: '', runId: 'r', durationMs: 1 }),
    ).rejects.toBeInstanceOf(MemorySecretError);
    await expect(
      mem.rememberOutcome({ intent: 'x', command: 'deploy with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', success: true, summary: '', runId: 'r', durationMs: 1 }),
    ).rejects.toBeInstanceOf(MemorySecretError);
  });
});

describe('telemetry redaction', () => {
  it('scrubs secrets, home paths and image payloads from exported spans', async () => {
    const captured: ReadableSpan[] = [];
    const inner: SpanExporter = {
      export: (spans, cb) => {
        captured.push(...spans);
        cb({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => {},
    };
    const exporter = new RedactingExporter(inner);
    const span = {
      name: 'tool',
      kind: SpanKind.INTERNAL,
      spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }),
      parentSpanContext: undefined,
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: SpanStatusCode.ERROR, message: `failed with key sk-proj-${'a'.repeat(30)}` },
      attributes: {
        'input.value': `cat ${process.env.HOME}/notes.txt with token=abc123 and data:image/png;base64,${'A'.repeat(200)}`,
        'llm.api_key': 'sk-live-should-not-appear',
      },
      links: [],
      events: [],
      duration: [0, 1],
      ended: true,
      resource: {} as ReadableSpan['resource'],
      instrumentationScope: { name: 't' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
    await new Promise<void>((r) => exporter.export([span], () => r()));
    const out = captured[0] as ReadableSpan;
    const input = String(out.attributes['input.value']);
    expect(input).toContain('~/notes.txt');
    expect(input).not.toContain(String(process.env.HOME));
    expect(input).toContain('token=[REDACTED]');
    expect(input).toContain('[REDACTED_BINARY]');
    expect(out.attributes['llm.api_key']).toBe('[REDACTED]');
    expect(out.status.message).not.toContain('sk-proj-');
    expect(exporter.stats.spans).toBe(1);
  });
});
