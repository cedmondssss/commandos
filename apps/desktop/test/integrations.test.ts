import { describe, expect, it } from 'vitest';
import type { RunUi, TaskUi } from '../src/renderer/src/lib/store';
import { anchorViewerUrl, browserEvidence, memoryEvidence, timelineEvidence } from '../src/renderer/src/lib/integrations';

function task(id: string, tool: string, args: Record<string, unknown>, output?: unknown): TaskUi {
  return { view: { id, tool, title: tool, args, dependsOn: [], bind: [], postconditions: [], tier: 1, effectClass: 'read', risk: 'none' }, state: 'succeeded', attempt: 1, output };
}
function run(tasks: TaskUi[]): RunUi {
  return { runId: 'run_test', command: 'Read a page', source: 'text', dryRun: false, createdAt: 1000, state: 'running', tasks: Object.fromEntries(tasks.map((t) => [t.view.id, t])), order: tasks.map((t) => t.view.id), events: [], metrics: {}, modelCalls: [] };
}
const open = () => task('open', 'web.open', { provider: 'anchor' }, { provider: 'anchor', sessionId: 'web_a', anchorSessionId: 'remote-a', liveViewUrl: 'https://live.anchorbrowser.io/inspector.html?sessionId=remote-a', url: 'https://example.com' });

describe('integration evidence in the dashboard', () => {
  it('embeds only known Anchor HTTPS viewers and never credential or CDP endpoints', () => {
    expect(anchorViewerUrl('https://live.anchorbrowser.io/inspector.html?sessionId=test')).toContain('sessionId=test');
    for (const url of ['https://live.anchorbrowser.io.evil.test/', 'https://evil.test/', 'http://live.anchorbrowser.io/', 'https://user@live.anchorbrowser.io/', 'https://live.anchorbrowser.io:444/', 'wss://connect.anchorbrowser.io/', 'https://live.anchorbrowser.io/?apiKey=test', 'https://anchorforge.io/?wss=private']) expect(anchorViewerUrl(url), url).toBeNull();
  });

  it('follows session bindings, keeps the captured screenshot after close, and does not show a stale live iframe', () => {
    const shot = task('shot', 'web.screenshot', { sessionId: '' }, { path: '/fixture/web.png' });
    shot.view.bind = [{ arg: 'sessionId', from: 'open.output.sessionId' }];
    const close = task('close', 'web.close', { sessionId: '' }, { closed: true });
    close.view.bind = [{ arg: 'sessionId', from: 'open.output.sessionId' }];
    const current = run([open(), shot]);
    expect(browserEvidence(current)[0]).toMatchObject({ active: true, closed: false, screenshotTaskId: 'shot', remoteId: 'remote-a' });
    current.tasks.close = close; current.order.push('close');
    expect(browserEvidence(current)[0]).toMatchObject({ active: false, closed: true, state: 'Closed', screenshotTaskId: 'shot' });
  });

  it('distinguishes local browser work, finished runs and failed cleanup from a live Anchor session', () => {
    expect(browserEvidence(run([task('open', 'web.open', { provider: 'local' }, { provider: 'local', sessionId: 'local' })]))).toEqual([]);
    const current = run([open()]); current.state = 'stopped';
    expect(browserEvidence(current)[0]).toMatchObject({ active: false, closed: false, state: 'Run ended' });
    current.events.push({ type: 'log', runId: current.runId, at: 2000, level: 'warn', message: 'cleanup failed', data: { activity: 'cleanup_failed', provider: 'browser' } });
    expect(browserEvidence(current)[0]).toMatchObject({ state: 'Cleanup failed', closed: false });
  });

  it('isolates memory data by selected run and supports saved historical logs', () => {
    const current = run([]);
    current.events.push({ type: 'log', runId: current.runId, at: 2000, level: 'info', message: 'memory: saved verified procedure proc_saved to SurrealDB Agent Memory (record1)' });
    current.events.push({ type: 'log', runId: current.runId, at: 2100, level: 'info', message: 'memory: recalled verified procedure proc_saved', data: { provider: 'surrealdb', activity: 'recalled', procedureId: 'proc_saved', memoryId: 'record1', score: 0.91, source: { sessionId: 'source1' } } });
    expect(memoryEvidence(current)).toEqual([expect.objectContaining({ action: 'saved', procedureId: 'proc_saved', memoryId: 'record1' }), expect.objectContaining({ action: 'recalled', sessionId: 'source1', score: 0.91 })]);
    expect(memoryEvidence(run([]))).toEqual([]);
  });

  it('uses actual task and model timestamps for the timeline, including cancellation', () => {
    const read = task('read', 'web.extract', {}); read.startedAt = 1200; read.endedAt = 1500;
    const current = run([read]);
    current.events.push({ type: 'model_call', runId: current.runId, at: 1900, call: { model: 'test-model', tier: 'fast', effort: 'low', purpose: 'route', latencyMs: 700, ok: false, error: 'cancelled: hedge' } });
    expect(timelineEvidence(current, 2500)).toEqual([expect.objectContaining({ id: 'read', start: 1200, end: 1500 }), expect.objectContaining({ kind: 'model', start: 1200, end: 1900, state: 'cancelled' })]);
  });
});
