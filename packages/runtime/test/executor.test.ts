import { defineTool, ToolError } from '@commandos/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TaskValidationError, topoSort } from '../src/executor';
import { makeExecutor, statesOf } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records start/end timestamps so tests can prove concurrency and ordering. */
function timedTool(id: string, log: Array<{ id: string; task: string; start: number; end: number }>, opts: { ms?: number; resources?: string[] } = {}) {
  return defineTool({
    id,
    title: id,
    description: 'test tool',
    tier: 1,
    args: z.object({ value: z.number().default(0), label: z.string().default('') }),
    output: z.object({ value: z.number(), label: z.string() }),
    effectClass: 'read',
    effects: [],
    risk: 'none',
    idempotent: true,
    defaultTimeoutMs: 5_000,
    resources: () => opts.resources ?? [],
    async run(a, ctx) {
      const start = performance.now();
      await sleep(opts.ms ?? 60);
      log.push({ id, task: ctx.taskId, start, end: performance.now() });
      return { value: a.value + 1, label: a.label };
    },
  });
}

describe('RunExecutor', () => {
  it('runs independent tasks concurrently and dependents after their dependencies', async () => {
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const tool = timedTool('t.step', log, { ms: 120 });
    const h = await makeExecutor([tool]);
    h.executor.addPlan({
      goal: 'parallel',
      tasks: [
        { id: 'a', tool: 't.step', args: { value: 1 } },
        { id: 'b', tool: 't.step', args: { value: 10 } },
        { id: 'c', tool: 't.step', args: { value: 0 }, dependsOn: ['a', 'b'], bind: [{ arg: 'value', from: 'b.output.value' }] },
      ],
    });
    h.executor.seal();
    const result = await h.executor.done();
    expect(result.succeeded).toBe(3);
    const a = log.find((l) => l.task === 'a')!;
    const b = log.find((l) => l.task === 'b')!;
    const c = log.find((l) => l.task === 'c')!;
    expect(a.start).toBeLessThan(b.end); // overlap
    expect(b.start).toBeLessThan(a.end);
    expect(c.start).toBeGreaterThanOrEqual(Math.max(a.end, b.end));
    expect(h.executor.outputOf('c')).toEqual({ value: 12, label: '' }); // bound b.value=11, +1
  });

  it('serializes tasks that share a resource lock', async () => {
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const tool = timedTool('t.ui', log, { ms: 80, resources: ['ui:frontmost'] });
    const h = await makeExecutor([tool]);
    h.executor.addPlan({ goal: 'locks', tasks: [{ id: 'x', tool: 't.ui', args: {} }, { id: 'y', tool: 't.ui', args: {} }] });
    h.executor.seal();
    await h.executor.done();
    const [first, second] = [...log].sort((p, q) => p.start - q.start);
    expect(second!.start).toBeGreaterThanOrEqual(first!.end);
  });

  it('fails a task whose verification fails and skips its dependents', async () => {
    const lying = defineTool({
      id: 't.lie',
      title: 'lie',
      description: 'claims success but verification disagrees',
      tier: 1,
      args: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effectClass: 'read',
      effects: [],
      risk: 'none',
      idempotent: false,
      defaultTimeoutMs: 1000,
      async run() {
        return { ok: true };
      },
      async verify() {
        return [{ label: 'file really exists', ok: false, detail: 'it does not' }];
      },
    });
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const h = await makeExecutor([lying, timedTool('t.step', log)]);
    h.executor.addPlan({ goal: 'verify', tasks: [{ id: 'lie', tool: 't.lie', args: {} }, { id: 'after', tool: 't.step', args: {}, dependsOn: ['lie'] }] });
    h.executor.seal();
    const result = await h.executor.done();
    expect(statesOf(h.events, 'lie')).toContain('verifying');
    expect(h.executor.get('lie')!.state).toBe('failed');
    expect(h.executor.get('lie')!.error).toMatch(/verification failed: file really exists/);
    expect(h.executor.get('after')!.state).toBe('skipped');
    expect(result.failed).toBe(1);
    expect(log).toHaveLength(0);
  });

  it('evaluates typed postconditions against the output', async () => {
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const h = await makeExecutor([timedTool('t.step', log, { ms: 1 })]);
    h.executor.addPlan({
      goal: 'post',
      tasks: [
        { id: 'ok', tool: 't.step', args: { value: 4 }, postconditions: [{ kind: 'output_equals', path: 'value', value: 5 }] },
        { id: 'bad', tool: 't.step', args: { value: 4 }, postconditions: [{ kind: 'output_equals', path: 'value', value: 99 }] },
      ],
    });
    h.executor.seal();
    await h.executor.done();
    expect(h.executor.get('ok')!.state).toBe('succeeded');
    expect(h.executor.get('bad')!.state).toBe('failed');
  });

  it('retries idempotent tools on transient errors', async () => {
    let calls = 0;
    const flaky = defineTool({
      id: 't.flaky',
      title: 'flaky',
      description: 'fails once',
      tier: 1,
      args: z.object({}),
      output: z.object({ calls: z.number() }),
      effectClass: 'read',
      effects: [],
      risk: 'none',
      idempotent: true,
      defaultTimeoutMs: 1000,
      async run() {
        calls++;
        if (calls === 1) throw new ToolError('busy', 'temporarily unavailable', true);
        return { calls };
      },
    });
    const h = await makeExecutor([flaky]);
    h.executor.addTask({ id: 'f', tool: 't.flaky', args: {} });
    h.executor.seal();
    const r = await h.executor.done();
    expect(r.succeeded).toBe(1);
    expect(calls).toBe(2);
    expect(statesOf(h.events, 'f').filter((s) => s === 'running')).toHaveLength(2);
  });

  it('enforces task timeouts', async () => {
    const slow = defineTool({
      id: 't.slow',
      title: 'slow',
      description: 'never finishes in time',
      tier: 1,
      args: z.object({}),
      output: z.object({}),
      effectClass: 'read',
      effects: [],
      risk: 'none',
      idempotent: false,
      defaultTimeoutMs: 50,
      async run() {
        await sleep(2000);
        return {};
      },
    });
    const h = await makeExecutor([slow]);
    h.executor.addTask({ id: 's', tool: 't.slow', args: {} });
    h.executor.seal();
    const started = Date.now();
    await h.executor.done();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(h.executor.get('s')!.state).toBe('failed');
    expect(h.executor.get('s')!.error).toMatch(/timed out/);
  });

  it('asks for approval and runs only when approved', async () => {
    const del = defineTool({
      id: 't.delete',
      title: 'delete',
      description: 'deletes',
      tier: 1,
      args: z.object({}),
      output: z.object({ done: z.boolean() }),
      effectClass: 'reversible_local',
      effects: ['fs_delete'],
      risk: 'medium',
      idempotent: false,
      defaultTimeoutMs: 1000,
      async run() {
        return { done: true };
      },
    });
    const approved = await makeExecutor([del], { onApproval: (b, id) => setTimeout(() => b.respond(id, 'approve'), 10) });
    approved.executor.addTask({ id: 'd', tool: 't.delete', args: {} });
    approved.executor.seal();
    await approved.executor.done();
    expect(statesOf(approved.events, 'd')).toEqual(['pending', 'ready', 'awaiting_approval', 'running', 'verifying', 'succeeded']);

    const denied = await makeExecutor([del], { onApproval: (b, id) => setTimeout(() => b.respond(id, 'deny'), 10) });
    denied.executor.addTask({ id: 'd', tool: 't.delete', args: {} });
    denied.executor.seal();
    await denied.executor.done();
    expect(denied.executor.get('d')!.state).toBe('denied');
  });

  it('denies writes outside the allowed folders without asking', async () => {
    const write = defineTool({
      id: 't.write',
      title: 'write',
      description: 'writes a path',
      tier: 1,
      args: z.object({ path: z.string() }),
      output: z.object({}),
      effectClass: 'reversible_local',
      effects: ['fs_write'],
      risk: 'low',
      idempotent: false,
      defaultTimeoutMs: 1000,
      paths: (a) => ({ read: [], write: [a.path] }),
      async run() {
        return {};
      },
    });
    const h = await makeExecutor([write]);
    h.executor.addTask({ id: 'w', tool: 't.write', args: { path: '/etc/hosts' } });
    h.executor.seal();
    await h.executor.done();
    expect(h.executor.get('w')!.state).toBe('denied');
    expect(h.events.some((e) => e.type === 'approval_requested')).toBe(false);
  });

  it('cancels pending and running work when the run is aborted', async () => {
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const h = await makeExecutor([timedTool('t.step', log, { ms: 500 })]);
    h.executor.addPlan({ goal: 'cancel', tasks: [{ id: 'a', tool: 't.step', args: {} }, { id: 'b', tool: 't.step', args: {}, dependsOn: ['a'] }] });
    h.executor.seal();
    setTimeout(() => h.controller.abort(new Error('cancelled by user')), 50);
    const r = await h.executor.done();
    expect(r.cancelled).toBe(2);
  });

  it('dry run executes read-only steps and previews changes', async () => {
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const change = defineTool({
      id: 't.change',
      title: 'change',
      description: 'changes things',
      tier: 1,
      args: z.object({}),
      output: z.object({}),
      effectClass: 'reversible_local',
      effects: ['fs_write'],
      risk: 'low',
      idempotent: false,
      defaultTimeoutMs: 1000,
      preview: () => ({ summary: 'would change 3 files', details: [] }),
      async run() {
        throw new Error('must not run in dry run');
      },
    });
    const h = await makeExecutor([timedTool('t.step', log, { ms: 1 }), change], { dryRun: true });
    h.executor.addPlan({ goal: 'dry', tasks: [{ id: 'read', tool: 't.step', args: {} }, { id: 'write', tool: 't.change', args: {}, dependsOn: ['read'] }] });
    h.executor.seal();
    await h.executor.done();
    expect(h.executor.get('read')!.state).toBe('succeeded');
    expect(h.executor.get('write')!.state).toBe('skipped');
  });

  it('rejects invalid plans before running anything', async () => {
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const h = await makeExecutor([timedTool('t.step', log)]);
    expect(() => h.executor.addPlan({ goal: 'g', tasks: [{ id: 'a', tool: 'nope', args: {} }] })).toThrow(TaskValidationError);
    expect(() =>
      h.executor.addPlan({ goal: 'g', tasks: [{ id: 'a', tool: 't.step', args: {}, dependsOn: ['b'] }, { id: 'b', tool: 't.step', args: {}, dependsOn: ['a'] }] }),
    ).toThrow(/cycle/);
    expect(() => h.executor.addPlan({ goal: 'g', tasks: [{ id: 'a', tool: 't.step', args: { value: 'x' } }] })).toThrow(/invalid args/);
    expect(() => h.executor.addPlan({ goal: 'g', tasks: [{ id: 'b', tool: 't.step', args: {}, bind: [{ arg: 'value', from: 'zz.output.value' }] }] })).toThrow(
      /unknown task zz/,
    );
    expect(log).toHaveLength(0);
  });

  it.each(['binding', 'condition'] as const)('rejects a late %s schema error atomically, then accepts corrected task ids', async (kind) => {
    const run = vi.fn(async () => ({ result: { internalUrls: ['https://example.com/a'] } }));
    const source = defineTool({ ...timedTool('web.agentTask', []), output: z.object({ result: z.unknown() }), run, verify: undefined, summarize: undefined });
    const h = await makeExecutor([source, timedTool('t.step', [], { ms: 0 })]);
    const sourceTask = { id: 'source', tool: source.id, args: {}, ...(kind === 'condition' ? { postconditions: [{ kind: 'output_truthy' as const, path: 'output.internalUrls' }] } : {}) };
    expect(() => h.executor.addPlan({ goal: 'bad plan', tasks: [sourceTask, { id: 'sink', tool: 't.step', args: {},
      bind: [{ arg: 'label', from: kind === 'binding' ? 'source.output.text' : 'source.output.result' }],
    }] })).toThrow(/does not exist/);
    await Promise.resolve();
    expect(h.executor.records()).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    h.executor.addPlan({ goal: 'corrected', tasks: [{ id: 'source', tool: source.id, args: {}, postconditions: [{ kind: 'output_count', path: 'output.result.internalUrls', op: 'eq', value: 1 }] }] });
    h.executor.seal();
    expect((await h.executor.done()).failed).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('treats a binding as a dependency even when dependsOn omits it', async () => {
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const h = await makeExecutor([timedTool('t.step', log, { ms: 50 })]);
    h.executor.addTask({ id: 'a', tool: 't.step', args: { value: 7 } });
    const b = h.executor.addTask({ id: 'b', tool: 't.step', args: { value: 0 }, bind: [{ arg: 'value', from: 'a.output.value' }] });
    expect(b.spec.dependsOn).toEqual(['a']);
    h.executor.seal();
    await h.executor.done();
    const [first, second] = log;
    expect(first?.task).toBe('a');
    expect(second?.task).toBe('b');
    expect(second!.start).toBeGreaterThanOrEqual(first!.end);
    expect(h.executor.outputOf('b')).toMatchObject({ value: 9 });
  });

  it('accepts tasks incrementally while earlier ones run', async () => {
    const log: Array<{ id: string; task: string; start: number; end: number }> = [];
    const h = await makeExecutor([timedTool('t.step', log, { ms: 100 })]);
    h.executor.addTask({ id: 'first', tool: 't.step', args: { value: 1 } });
    await sleep(20);
    h.executor.addTask({ id: 'second', tool: 't.step', args: {}, dependsOn: ['first'], bind: [{ arg: 'value', from: 'first.output.value' }] });
    h.executor.seal();
    await h.executor.done();
    expect(h.executor.outputOf('second')).toEqual({ value: 3, label: '' });
  });

  it('topoSort orders dependencies first', () => {
    const order = topoSort([
      { id: 'c', tool: 'x', args: {}, dependsOn: ['b'], bind: [], preconditions: [], postconditions: [] },
      { id: 'a', tool: 'x', args: {}, dependsOn: [], bind: [], preconditions: [], postconditions: [] },
      { id: 'b', tool: 'x', args: {}, dependsOn: ['a'], bind: [], preconditions: [], postconditions: [] },
    ]).map((t) => t.id);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
