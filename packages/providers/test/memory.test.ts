import { describe, expect, it, vi } from 'vitest';
import { Transport } from '@surrealdb/memory';
import { ProcedureMemory } from '../src/memory';

describe('hosted memory compatibility', () => {
  it('writes run outcomes using a category accepted by the hosted API', async () => {
    const mem = new ProcedureMemory({ endpoint: 'http://127.0.0.1:9', context: 'test', apiKey: 'test' }, 'tester');
    vi.spyOn(mem, 'ensureScopes').mockResolvedValue(undefined);
    const write = vi.spyOn(mem.client, 'remember').mockResolvedValue({ sessionId: 's', turnId: 't' } as Awaited<ReturnType<typeof mem.client.remember>>);
    await mem.rememberOutcome({ intent: 'file_operations', command: 'list files', success: true, summary: 'listed', runId: 'r', durationMs: 10 });
    expect(write.mock.calls[0]?.[1]).toMatchObject({ infer: 'none', memoryCategory: 'context', labels: ['kind=outcome', 'intent=file_operations', 'result=success'] });
  });

  it('retrieves the original turn when semantic search splits a large procedure JSON record', async () => {
    const mem = new ProcedureMemory({ endpoint: 'http://127.0.0.1:9', context: 'test', apiKey: 'test' }, 'tester');
    vi.spyOn(mem, 'ensureScopes').mockResolvedValue(undefined);
    const procedure = { kind: 'commandos.procedure', version: 1, id: 'proc_large', intent: 'file_operations', command: 'Organize this folder', summary: 'Long report '.repeat(300), mode: 'plan', template: null, slots: null, tasks: [], parameters: [], fingerprint: { tools: {}, apps: {}, sites: {}, os: '25' }, stats: { successes: 1, failures: 0, avgMs: 1, lastVerifiedAt: '2026-10-16' }, runId: 'run_a', status: 'active', updatedAt: '2026-10-16' };
    const text = `COMMANDOS_PROCEDURE_V1 ${JSON.stringify(procedure)}`;
    const hits = [0, 1].map((part) => ({ id: `chunk_${part}`, source: 'memory_chunk' as const, score: 0.9, text: text.slice(part * 800, (part + 1) * 800), resource: { kind: 'session' as const, sessionId: 's', turnId: 't' } }));
    vi.spyOn(mem.client, 'recall').mockResolvedValue({ hits } as Awaited<ReturnType<typeof mem.client.recall>>);
    const source = vi.spyOn(Transport.prototype, 'requestJson').mockResolvedValue({ turns: [{ id: 'memory_turn:t', content: text }] });
    try {
      const recalled = await mem.recallProcedures('Organize this folder');
      expect(recalled).toHaveLength(1);
      expect(recalled[0]?.procedure).toEqual(procedure);
      expect(source).toHaveBeenCalledTimes(1);
      expect(source.mock.calls[0]?.[1]).toContain('/sessions/s/turns');
    } finally { source.mockRestore(); }
  });
});
