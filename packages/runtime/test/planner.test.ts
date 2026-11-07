import { defaultSettings } from '@commandos/contracts';
import type { ModelGateway, StreamRequest } from '@commandos/providers';
import { createDefaultRegistry, defineTool, ToolError, uiPress } from '@commandos/tools';
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { deepPlanToPlanInput, runDeepPlanner } from '../src/planner/deep';
import { plannerTools, strictify, stripNulls } from '../src/planner/functions';
import { runStandardPlanner } from '../src/planner/standard';
import { StreamingArrayElements } from '../src/planner/stream-json';
import { makeExecutor } from './helpers';
import { finalState, summarize } from '../src/runtime';

describe('strict function schemas', () => {
  it('closes objects, requires every property and makes optional ones nullable', () => {
    const s = strictify(
      z.toJSONSchema(z.object({ path: z.string(), limit: z.number().default(5), tags: z.array(z.string()).optional() }), { io: 'input' }) as Record<string, unknown>,
    );
    expect(s).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'limit', 'tags'],
      properties: { path: { type: 'string' }, limit: { type: ['number', 'null'] }, tags: { type: ['array', 'null'] } },
    });
    expect(JSON.stringify(s)).not.toContain('"default"');
  });

  it('falls back to non-strict for records', () => {
    expect(() => strictify(z.toJSONSchema(z.object({ m: z.record(z.string(), z.string()) })) as Record<string, unknown>)).toThrow();
  });

  it('exposes every registry tool through one strict schedule function plus finish', () => {
    const { tools, toolIds, jsonArgs } = plannerTools(createDefaultRegistry());
    expect(tools.map((t) => t.name)).toEqual(['schedule', 'finish']);
    expect(tools.every((t) => t.strict)).toBe(true);
    expect(toolIds.get('fs_organize')).toBe('fs.organize');
    expect(toolIds.get('screenshots_find')).toBe('screenshots.find');
    for (const name of toolIds.keys()) expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    // tools whose args strict mode cannot express travel as args_json; typed ones do not
    expect(jsonArgs.has('data_select')).toBe(true);
    expect(jsonArgs.has('fs_mkdir')).toBe(false);
    const variants = (tools[0]!.parameters as { properties: { tasks: { items: { properties: { call: { anyOf: unknown[] } } } } } }).properties.tasks.items.properties.call.anyOf;
    expect(variants).toHaveLength(toolIds.size);
  });

  it('strips nulls so defaults apply', () => {
    expect(stripNulls({ a: null, b: [1, null, { c: null, d: 2 }] })).toEqual({ b: [1, null, { d: 2 }] });
  });
});

describe('external-action verification boundaries', () => {
  it('stops without another model turn when observation of a dispatched action fails', async () => {
    const press = defineTool({ ...uiPress, run: vi.fn(async () => ({ pressed: { ref: '1:0', role: 'AXButton', label: 'Delete this repository', value: null, enabled: true, frame: null }, effectConfirmed: false as const })) });
    const read = defineTool({ id: 'browser.readPage', title: 'Verify result', description: 'Read-only fixture', tier: 3, args: z.object({}), output: z.object({ text: z.string() }), effectClass: 'read', effects: ['ui_read'], risk: 'none', idempotent: true, defaultTimeoutMs: 1000,
      run: async () => { throw new ToolError('page_not_ready', 'Confirmation did not arrive. Last observed page: deletion confirmation is still open.'); } });
    const h = await makeExecutor([press, read], { onApproval: (broker, id) => broker.respond(id, 'approve') });
    const seen: StreamRequest[] = [];
    const gateway = scriptedGateway([[{ name: 'schedule', args: { tasks: [
      { task_id: 'press', call: { tool: 'ui_press', args: { bundleId: 'com.google.Chrome', target: { ref: '1:0' }, expectLabel: 'Delete this repository' } } },
      { task_id: 'verify', depends_on: ['press'], call: { tool: 'browser_readPage', args: {} } },
    ] } }]], seen);
    const result = await runStandardPlanner('Delete the fixture repository', DECISION, { runId: 'fixture', signal: h.controller.signal, executor: h.executor, registry: h.registry, models: gateway, settings: h.settings, emit: (event) => h.events.push(event) });
    expect(result).toMatchObject({ outcome: 'needs_user', turns: 1, summary: expect.stringContaining('external result was not confirmed') });
    expect(result.summary).toContain('deletion confirmation is still open');
    expect(seen).toHaveLength(1); expect(press.run).toHaveBeenCalledTimes(1);
  });

  it('preserves the last observed page and disabled-control reason at the turn limit', async () => {
    const press = defineTool({ ...uiPress, run: async () => { throw new ToolError('disabled_element', 'The final Delete control is disabled; no press was sent.'); } });
    const read = defineTool({ id: 'browser.readPage', title: 'Observe dialog', description: 'Read-only fixture', tier: 3, args: z.object({}), output: z.object({ title: z.string(), url: z.string(), text: z.string() }), effectClass: 'read', effects: ['ui_read'], risk: 'none', idempotent: true, defaultTimeoutMs: 1000,
      run: async () => ({ title: 'Repository settings', url: 'https://github.com/example/fixture/settings', text: 'Delete example/fixture. Repository confirmation is still open.' }) });
    const h = await makeExecutor([press, read], { onApproval: (broker, id) => broker.respond(id, 'approve') });
    const turns = Array.from({ length: 12 }, (_, index) => [{ name: 'schedule', args: { tasks: index === 0
      ? [{ task_id: 'press', call: { tool: 'ui_press', args: { bundleId: 'com.google.Chrome', target: { ref: '1:0' }, expectLabel: 'Delete this repository' } } }]
      : [{ task_id: `read${index}`, call: { tool: 'browser_readPage', args: {} } }] } }]);
    const result = await runStandardPlanner('Delete the fixture repository', DECISION, { runId: 'fixture', signal: h.controller.signal, executor: h.executor, registry: h.registry, models: scriptedGateway(turns, []), settings: h.settings, emit: (event) => h.events.push(event) });
    expect(result.outcome).toBe('needs_user'); expect(result.summary).toContain('disabled; no press was sent');
    expect(result.summary).toContain('Repository confirmation is still open');
    expect(h.executor.get('press')?.state).toBe('failed');
  });
});

describe('long GitHub deletion finalization', () => {
  function deletionHarness(deletes: boolean) {
    let deleted = false;
    const initialDelete = defineTool({
      id: 'ui.press', title: 'Press UI element', description: 'Fixture GitHub control', tier: 3,
      args: z.object({ expectLabel: z.string(), bundleId: z.literal('com.google.Chrome').default('com.google.Chrome') }), output: z.object({ pressed: z.object({ label: z.string() }) }),
      effectClass: 'external', effects: ['ui_input'], risk: 'high', idempotent: false, defaultTimeoutMs: 1000,
      run: async (a, ctx) => {
        if (ctx.taskId === 'offscreen') throw new ToolError('not_visible', 'The button is outside the viewport; no click was sent.');
        if (ctx.taskId === 'final-delete' && deletes) deleted = true;
        return { pressed: { label: a.expectLabel } };
      },
    });
    const setValue = defineTool({
      id: 'ui.setValue', title: 'Fill confirmation', description: 'Fill fixture', tier: 3,
      args: z.object({ value: z.string() }), output: z.object({ readBack: z.string() }),
      effectClass: 'reversible_local', effects: ['ui_input'], risk: 'low', idempotent: false, defaultTimeoutMs: 1000,
      run: async (a) => ({ readBack: a.value }),
    });
    const find = defineTool({
      id: 'ui.find', title: 'Find control', description: 'Find fixture', tier: 3,
      args: z.object({}), output: z.object({ elements: z.array(z.object({ label: z.string(), enabled: z.boolean() })) }),
      effectClass: 'read', effects: ['ui_read'], risk: 'none', idempotent: true, defaultTimeoutMs: 1000,
      run: async () => ({ elements: [{ label: 'Delete this repository', enabled: true }] }),
    });
    const readPage = defineTool({
      id: 'browser.readPage', title: 'Read GitHub page', description: 'Read fixture', tier: 3,
      args: z.object({}), output: z.object({ title: z.string(), url: z.string(), text: z.string() }),
      effectClass: 'read', effects: ['ui_read'], risk: 'none', idempotent: true, defaultTimeoutMs: 1000,
      run: async () => deleted
        ? { title: 'Your repositories', url: 'https://github.com/Soulemane12', text: 'Your repository "Soulemane12/HackBU" was successfully deleted.' }
        : { title: 'General - GitHub', url: 'https://github.com/Soulemane12/HackBU/settings', text: 'Delete Soulemane12/HackBU\nTo confirm, type "Soulemane12/HackBU" in the box below\nDelete this repository' },
    });
    return { tools: [initialDelete, setValue, find, readPage], get deleted() { return deleted; } };
  }

  it.each([false, true])('reports a verified recovered deletion without masking unrelated failures (unrelated=%s)', async (unrelated) => {
    const fixture = deletionHarness(true);
    const snapshot = defineTool({ id: 'ui.snapshot', title: 'Observe', description: 'Fixture snapshot', tier: 3, args: z.object({}), output: z.object({ text: z.string() }), effectClass: 'read', effects: ['ui_read'], risk: 'none', idempotent: true, defaultTimeoutMs: 1000, run: async () => ({ text: 'Dialog' }) });
    const fail = defineTool({ ...snapshot, id: 'test.unrelated', run: async () => { throw new ToolError('failure', 'An unrelated required action failed'); } });
    const h = await makeExecutor([...fixture.tools, snapshot, fail], { onApproval: (broker, id) => broker.respond(id, 'approve') });
    const press = (id: string) => ({ task_id: id, call: { tool: 'ui_press', args: { expectLabel: 'Delete this repository' } } });
    const page = (id: string) => ({ task_id: id, call: { tool: 'browser_readPage', args: {} } });
    const gateway = scriptedGateway([
      [{ name: 'schedule', args: { tasks: [page('settings'), { ...press('offscreen'), depends_on: ['settings'] }, { task_id: 'skipped-snapshot', depends_on: ['offscreen'], call: { tool: 'ui_snapshot', args: {} } }, ...(unrelated ? [{ task_id: 'unrelated', call: { tool: 'test_unrelated', args: {} } }] : [])] } }],
      [{ name: 'schedule', args: { tasks: [press('replacement'), { task_id: 'replacement-snapshot', depends_on: ['replacement'], call: { tool: 'ui_snapshot', args: {} } }] } }],
      [{ name: 'schedule', args: { tasks: [{ task_id: 'name', call: { tool: 'ui_setValue', args: { value: 'Soulemane12/HackBU' } } }, { task_id: 'enabled', depends_on: ['name'], call: { tool: 'ui_find', args: {} } }, { ...press('final-delete'), depends_on: ['enabled'] }, { ...page('verified'), depends_on: ['final-delete'] }] } }],
    ], []);
    const answer = await runStandardPlanner('Create a repository called HackBU, then delete the repository', DECISION, { runId: 'recover', signal: h.controller.signal, executor: h.executor, registry: h.registry, models: gateway, settings: h.settings, emit: (e) => h.events.push(e) });
    const result = await h.executor.done();
    expect(answer.resolvedTaskIds).toEqual(['offscreen', 'skipped-snapshot']);
    expect(finalState(result, false, undefined, answer)).toBe(unrelated ? 'partial' : 'succeeded');
    expect(finalState(result, true, 'emergency stop', answer)).toBe('stopped');
    if (!unrelated) expect(summarize(result, false, answer)).toContain('Completed after recovery');
    expect(h.executor.get('offscreen')?.state).toBe('failed'); // preserve the original evidence
  });

  it.each([true, false])('reserves final steps after the exact GitHub confirmation and only succeeds on page evidence (deleted=%s)', async (deletes) => {
    const fixture = deletionHarness(deletes);
    const h = await makeExecutor(fixture.tools, { onApproval: (broker, id) => broker.respond(id, 'approve') });
    const pageTask = (id: string) => ({ task_id: id, call: { tool: 'browser_readPage', args: {} } });
    const turns: Array<Array<{ name: string; args: unknown }>> = Array.from({ length: 10 }, (_, i) => [{ name: 'schedule', args: { tasks: i === 0
      ? [{ task_id: 'open-delete-dialog', call: { tool: 'ui_press', args: { expectLabel: 'Delete this repository' } } }]
      : [pageTask(`read-${i}`)] } }]);
    turns.push([{ name: 'schedule', args: { tasks: [
      { task_id: 'confirm-name', call: { tool: 'ui_setValue', args: { value: 'Soulemane12/HackBU' } } },
      { task_id: 'final-control', depends_on: ['confirm-name'], call: { tool: 'ui_find', args: {} } },
      { task_id: 'confirmation-page', depends_on: ['final-control'], call: { tool: 'browser_readPage', args: {} } },
    ] } }]);
    turns.push([{ name: 'finish', args: { outcome: 'needs_user', summary: 'planner reached its normal turn limit' } }]);
    turns.push([{ name: 'schedule', args: { tasks: [
      { task_id: 'final-delete', call: { tool: 'ui_press', args: { expectLabel: 'Delete this repository' } } },
      { task_id: 'verify-delete', depends_on: ['final-delete'], call: { tool: 'browser_readPage', args: {} } },
    ], finish: { outcome: 'done', summary: 'Deleted HackBU.' } } }]);
    const result = await runStandardPlanner('Create a repository called HackBU, then delete the repository', DECISION, {
      runId: 'github-delete-fixture', signal: h.controller.signal, executor: h.executor, registry: h.registry,
      models: scriptedGateway(turns, []), settings: defaultSettings(), emit: (e) => h.events.push(e),
    });
    expect(result.turns).toBe(13);
    expect(fixture.deleted).toBe(deletes);
    if (deletes) expect(result).toMatchObject({ outcome: 'done', summary: 'GitHub confirmed Soulemane12/HackBU was deleted.' });
    else expect(result).toMatchObject({ outcome: 'needs_user', summary: expect.stringContaining('still shows the deletion confirmation') });
  });
});

/**
 * Scripted stream: plays function-call events like the real Responses stream, with the arguments
 * arriving in small delta chunks.
 */
function scriptedGateway(turns: Array<Array<{ name: string; args: unknown }>>, seen: StreamRequest[], argsDoneAt: number[] = []): ModelGateway {
  let turn = 0;
  return {
    async stream(req: StreamRequest) {
      seen.push({ ...req, input: [...req.input] });
      const calls = turns[turn++] ?? [];
      const output: Response['output'] = [];
      for (const [i, c] of calls.entries()) {
        const id = `fc_${turn}_${i}`;
        const call_id = `call_${turn}_${i}`;
        const item = { type: 'function_call' as const, id, call_id, name: c.name, arguments: '', status: 'in_progress' as const };
        req.onEvent?.({ type: 'response.output_item.added', item, output_index: i, sequence_number: 0 } as ResponseStreamEvent);
        const args = JSON.stringify(c.args);
        for (let at = 0; at < args.length; at += 24) {
          await new Promise((r) => setTimeout(r, 4));
          if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
          req.onEvent?.({ type: 'response.function_call_arguments.delta', item_id: id, output_index: i, delta: args.slice(at, at + 24), sequence_number: 0 } as ResponseStreamEvent);
        }
        argsDoneAt.push(performance.now());
        req.onEvent?.({ type: 'response.function_call_arguments.done', item_id: id, output_index: i, arguments: args, sequence_number: 0 } as ResponseStreamEvent);
        output.push({ ...item, arguments: args, status: 'completed' });
      }
      await new Promise((r) => setTimeout(r, 40));
      const response = { id: `resp_${turn}`, output, output_text: '', status: 'completed', usage: null } as unknown as Response;
      return { response, call: { purpose: req.purpose, tier: req.tier, model: 'scripted', effort: 'low', latencyMs: 1, ok: true } };
    },
  } as unknown as ModelGateway;
}

function echoTool(started: Array<{ task: string; at: number }>) {
  return defineTool({
    id: 'test.echo',
    title: 'echo',
    description: 'returns its input',
    tier: 1,
    args: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
    effectClass: 'read',
    effects: [],
    risk: 'none',
    idempotent: true,
    defaultTimeoutMs: 2000,
    async run(a, ctx) {
      started.push({ task: ctx.taskId, at: performance.now() });
      if (a.text === 'fail') throw new Error('asked to fail');
      return { text: a.text.toUpperCase() };
    },
  });
}

const task = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ task_id: id, title: id, depends_on: [], bind: [], call: { tool: 'test_echo', args: { text } }, ...extra });
const DECISION = { mode: 'standard', intent: 'general', confidence: 0.9, via: 'router', reason: 'test', slots: {}, needsFullPreview: false } as const;

describe('STANDARD planner loop', () => {
  it('never retries an uncertain external action even when a retry policy requested it', async () => {
    const send = vi.fn(async () => { throw new ToolError('send_unverified', 'Check Sent before retrying.'); });
    const tool = defineTool({ ...echoTool([]), effectClass: 'external' as const, effects: ['external_send'],
      risk: 'high' as const, idempotent: false, run: send,
    });
    const h = await makeExecutor([tool], { onApproval: (broker, id) => broker.respond(id, 'approve') });
    h.executor.addTask({ id: 'send', tool: tool.id, args: { text: 'test' }, retry: { maxAttempts: 3, backoffMs: 0 } });
    h.executor.seal();
    expect((await h.executor.done()).failed).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.executor.get('send')?.errorCode).toBe('send_unverified');
  });

  it.each([true, false])('stops on an uncertain send without another model turn or send, finish included: %s', async (withFinish) => {
    const send = vi.fn(async () => { throw new ToolError('send_unverified', 'Gmail did not confirm sending. Check Sent before retrying.'); });
    const tool = defineTool({ id: 'test.send', title: 'Send', description: 'Test-only uncertain external send', tier: 3,
      args: z.object({ to: z.string() }), output: z.object({ sent: z.boolean() }),
      effectClass: 'external', effects: ['external_send'], risk: 'high', idempotent: false, defaultTimeoutMs: 1000,
      recipients: (a) => [a.to], run: send,
    });
    const h = await makeExecutor([tool], { onApproval: (broker, id) => broker.respond(id, 'approve') });
    const seen: StreamRequest[] = [];
    const schedule = { tasks: [{ task_id: 'send', title: 'Send', depends_on: [], bind: [], call: { tool: 'test_send', args: { to: 'me@example.com' } } }],
      ...(withFinish ? { finish: { outcome: 'done', summary: 'Sent' } } : {}),
    };
    const gateway = scriptedGateway([[{ name: 'schedule', args: schedule }], [{ name: 'schedule', args: schedule }]], seen);
    const result = await runStandardPlanner('Send the photo to myself', DECISION, { runId: 'run_test', signal: h.controller.signal,
      executor: h.executor, registry: h.registry, models: gateway, settings: defaultSettings(), emit: (e) => h.events.push(e),
    });
    expect(result).toMatchObject({ outcome: 'needs_user', turns: 1, summary: expect.stringContaining('Check Sent') });
    expect(h.executor.get('send')).toMatchObject({ state: 'failed', errorCode: 'send_unverified', attempt: 1 });
    expect(seen).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('dispatches each scheduled task as soon as its JSON streams in, then feeds results back', async () => {
    const started: Array<{ task: string; at: number }> = [];
    const h = await makeExecutor([echoTool(started)]);
    const seen: StreamRequest[] = [];
    const argsDoneAt: number[] = [];
    const gateway = scriptedGateway(
      [
        [
          {
            name: 'schedule',
            args: {
              tasks: [
                task('t1', 'hello'),
                task('t2', '', { depends_on: ['t1'], bind: [{ arg: 'text', from: 't1.output.text' }] }),
                { task_id: 'big', title: 'padding so the stream runs on', depends_on: [], bind: [], call: { tool: 'test_echo', args: { text: 'p'.repeat(400) } } },
              ],
              finish: null,
            },
          },
        ],
        [{ name: 'finish', args: { outcome: 'done', summary: 'echoed twice' } }],
      ],
      seen,
      argsDoneAt,
    );
    const result = await runStandardPlanner('echo hello twice', DECISION, {
      runId: 'run_test',
      signal: h.controller.signal,
      executor: h.executor,
      registry: h.registry,
      models: gateway,
      settings: defaultSettings(),
      emit: (e) => h.events.push(e),
    });
    await h.executor.done();
    expect(result).toMatchObject({ outcome: 'done', turns: 2 });
    expect(h.executor.outputOf('t2')).toEqual({ text: 'HELLO' });
    // t1 and t2 started while the schedule call was still streaming its later tasks
    const firstCallDone = argsDoneAt[0]!;
    expect(started.find((s) => s.task === 't1')!.at).toBeLessThan(firstCallDone);
    expect(started.find((s) => s.task === 't2')!.at).toBeLessThan(firstCallDone);
    // turn 2 received one function_call_output for the schedule call, with a result per task
    const outputs = seen[1]!.input.filter((i) => (i as { type?: string }).type === 'function_call_output') as Array<{ output: string }>;
    expect(outputs).toHaveLength(1);
    const { tasks } = JSON.parse(outputs[0]!.output) as { tasks: Array<Record<string, unknown>> };
    expect(tasks.map((t) => t.task_id)).toEqual(['t1', 't2', 'big']);
    expect(tasks[0]).toMatchObject({ task_id: 't1', state: 'succeeded', output: { text: 'HELLO' } });
    expect(tasks[1]).toMatchObject({ task_id: 't2', state: 'succeeded', output: { text: 'HELLO' } });
  });

  it('finishes in one turn when the schedule call carries finish and every task succeeds', async () => {
    const started: Array<{ task: string; at: number }> = [];
    const h = await makeExecutor([echoTool(started)]);
    const seen: StreamRequest[] = [];
    const gateway = scriptedGateway([[{ name: 'schedule', args: { tasks: [task('t1', 'a'), task('t2', 'b')], finish: { outcome: 'done', summary: 'echoed a and b' } } }]], seen);
    const result = await runStandardPlanner('echo a and b', DECISION, {
      runId: 'run_test',
      signal: h.controller.signal,
      executor: h.executor,
      registry: h.registry,
      models: gateway,
      settings: defaultSettings(),
      emit: (e) => h.events.push(e),
    });
    expect(result).toMatchObject({ outcome: 'done', summary: 'echoed a and b', turns: 1 });
    expect(seen).toHaveLength(1);
    expect(started.map((s) => s.task).sort()).toEqual(['t1', 't2']);
  });

  it('gives the model one more turn when a task fails after finish was proposed', async () => {
    const started: Array<{ task: string; at: number }> = [];
    const h = await makeExecutor([echoTool(started)]);
    const seen: StreamRequest[] = [];
    const gateway = scriptedGateway(
      [
        [{ name: 'schedule', args: { tasks: [task('t1', 'fail')], finish: { outcome: 'done', summary: 'claimed too early' } } }],
        [{ name: 'schedule', args: { tasks: [task('t2', 'retry')], finish: { outcome: 'done', summary: 'recovered with t2' } } }],
      ],
      seen,
    );
    const result = await runStandardPlanner('echo something', DECISION, {
      runId: 'run_test',
      signal: h.controller.signal,
      executor: h.executor,
      registry: h.registry,
      models: gateway,
      settings: defaultSettings(),
      emit: (e) => h.events.push(e),
    });
    expect(result).toMatchObject({ outcome: 'done', summary: 'recovered with t2', turns: 2 });
    const fed = seen[1]!.input.filter((i) => (i as { type?: string }).type === 'function_call_output') as Array<{ output: string }>;
    expect(JSON.parse(fed[0]!.output).tasks[0]).toMatchObject({ task_id: 't1', state: 'failed' });
  });
});

describe('fail fast', () => {
  it('stops the stream at the first rejected task and hands the next turn to the main model', async () => {
    const started: Array<{ task: string; at: number }> = [];
    const h = await makeExecutor([echoTool(started)]);
    const seen: StreamRequest[] = [];
    const gateway = scriptedGateway(
      [
        [
          {
            name: 'schedule',
            args: {
              tasks: [
                task('t1', 'one'),
                task('t2', 'two', { depends_on: ['nope'] }),
                { task_id: 'big', title: 'never reached', depends_on: [], bind: [], call: { tool: 'test_echo', args: { text: 'p'.repeat(2000) } } },
              ],
              finish: { outcome: 'done', summary: 'too early' },
            },
          },
        ],
        [{ name: 'schedule', args: { tasks: [task('t3', 'two')], finish: { outcome: 'done', summary: 'echoed one and two' } } }],
      ],
      seen,
    );
    const result = await runStandardPlanner('echo one and two', DECISION, {
      runId: 'run_test',
      signal: h.controller.signal,
      executor: h.executor,
      registry: h.registry,
      models: gateway,
      settings: defaultSettings(),
      emit: (e) => h.events.push(e),
      tier: 'fast',
    });
    expect(result).toMatchObject({ outcome: 'done', summary: 'echoed one and two', turns: 2 });
    expect(h.executor.get('big')).toBeUndefined();
    expect(h.executor.get('t1')?.state).toBe('succeeded');
    expect(seen.map((r) => r.tier)).toEqual(['fast', 'main']);
    const note = (seen[1]!.input.at(-1) as { role: string; content: Array<{ text: string }> }).content[0]!.text;
    expect(note).toMatch(/stopped your last call early: task t2 was rejected: task t2 depends on unknown task nope/);
    expect(note).toMatch(/"task_id":"t1","state":"succeeded"/);
    expect(note).toMatch(/"task_id":"t2","state":"rejected"/);
  });
});

describe('streaming array extraction', () => {
  it('yields each element of the named top-level array as soon as it closes', () => {
    const x = new StreamingArrayElements('tasks');
    const json = JSON.stringify({ note: '{[not]}', tasks: [{ a: '}', b: [1, { c: '"]' }] }, { d: 'x\\"y' }], other: [{ e: 1 }] });
    const got: string[] = [];
    for (let i = 0; i < json.length; i += 3) got.push(...x.feed(json.slice(i, i + 3)));
    expect(got.map((g) => JSON.parse(g))).toEqual([{ a: '}', b: [1, { c: '"]' }] }, { d: 'x\\"y' }]);
  });
});

describe('DEEP plan conversion', () => {
  it('repairs a late invalid binding without starting tasks or poisoning their ids', async () => {
    const started: Array<{ task: string; at: number }> = [];
    const h = await makeExecutor([echoTool(started)]);
    const t = (id: string, from?: string) => ({ id, tool: 'test.echo', title: id, args_json: JSON.stringify({ text: from ? '' : 'hello' }),
      depends_on: from ? ['t1'] : [], bind: from ? [{ arg: 'text', from }] : [], postconditions_json: '[]',
    });
    let calls = 0;
    const parse = vi.fn(async (req: { instructions: string }) => {
      expect(req.instructions).toContain('output:');
      expect(h.executor.records()).toHaveLength(0);
      expect(started).toHaveLength(0);
      return { data: { goal: 'echo', risks: [], assumptions: [], tasks: [t('t1'), t('t2', ++calls === 1 ? 't1.output.missing' : 't1.output.text')] } };
    });
    const result = await runDeepPlanner('echo hello twice', { ...DECISION, mode: 'deep' }, {
      runId: 'run_test', signal: h.controller.signal, executor: h.executor, registry: h.registry,
      models: { parse } as unknown as ModelGateway, settings: defaultSettings(), emit: (e) => h.events.push(e),
    });
    expect(result.repairs).toBe(1);
    expect((await h.executor.done()).succeeded).toBe(2);
    expect(started.map((s) => s.task)).toEqual(['t1', 't2']);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('parses args_json and typed postconditions, rejecting malformed ones', () => {
    const plan = deepPlanToPlanInput({
      goal: 'g',
      assumptions: [],
      risks: [],
      tasks: [
        { id: 't1', tool: 'fs.mkdir', title: 'mk', args_json: '{"path":"~/Desktop/x"}', depends_on: [], bind: [], postconditions_json: '[{"kind":"file_exists","path":"~/Desktop/x"}]' },
      ],
    });
    expect(plan.tasks[0]).toMatchObject({ args: { path: '~/Desktop/x' }, postconditions: [{ kind: 'file_exists' }] });
    expect(() =>
      deepPlanToPlanInput({ goal: 'g', assumptions: [], risks: [], tasks: [{ id: 't1', tool: 'x', title: 'x', args_json: '{bad', depends_on: [], bind: [], postconditions_json: '[]' }] }),
    ).toThrow(/not valid JSON/);
    expect(() =>
      deepPlanToPlanInput({ goal: 'g', assumptions: [], risks: [], tasks: [{ id: 't1', tool: 'x', title: 'x', args_json: '{}', depends_on: [], bind: [], postconditions_json: '[{"kind":"nope"}]' }] }),
    ).toThrow(/invalid postconditions/);
  });
});
