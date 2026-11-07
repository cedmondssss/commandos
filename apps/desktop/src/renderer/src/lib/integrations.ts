import type { RunEvent } from '@commandos/contracts';
import { isTerminal, type RunUi, type TaskUi } from './store';

export const ANCHOR_EXAMPLE = 'Use Anchor Browser to open https://example.com, read the page title and take a screenshot. Do not submit anything.';
export const MEMORY_EXAMPLE = 'Find my five latest screenshots in ~/CommandOS-Demo/Screenshots, sort them into categories, put them in a folder called Sorted and write a report.';
export const MEMORY_REPLAY_EXAMPLE = 'Do the same for ~/CommandOS-Demo/Inbox2.';

export const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const str = (value: unknown) => typeof value === 'string' ? value : null;

/** External viewer links accept only Anchor's known HTTPS origins, never a CDP URL. */
export function anchorViewerUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['live.anchorbrowser.io', 'anchorforge.io'].includes(url.hostname)) return null;
    if ([...url.searchParams.keys()].some((key) => /api.?key|authorization|cdp|wss/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

export function browserEvidence(run: RunUi) {
  const tasks = run.order.map((id) => run.tasks[id]).filter((task): task is TaskUi => task !== undefined);
  const sessionFor = (task: TaskUi) => {
    const explicit = str(task.view.args.sessionId);
    if (explicit) return explicit;
    const binding = task.view.bind.find((bind) => bind.arg === 'sessionId');
    const source = binding && /^([A-Za-z][A-Za-z0-9_-]*)\.output\.sessionId$/.exec(binding.from)?.[1];
    return source ? str(record(run.tasks[source]?.output).sessionId) : null;
  };
  const cleanup = run.events.some((e) => e.type === 'log' && record(e.data).activity === 'cleanup' && Number(record(e.data).browsers) > 0);
  const cleanupFailed = run.events.some((e) => e.type === 'log' && record(e.data).activity === 'cleanup_failed' && record(e.data).provider === 'browser');
  return tasks.filter((task) => task.view.tool === 'web.open' && (record(task.output).provider === 'anchor' || (!task.output && task.view.args.provider === 'anchor'))).map((task) => {
    const output = record(task.output);
    const sessionId = str(output.sessionId);
    const closing = sessionId ? tasks.find((other) => other.view.tool === 'web.close' && sessionFor(other) === sessionId && ['running', 'verifying', 'succeeded'].includes(other.state)) : undefined;
    const closed = (closing?.state === 'succeeded' && record(closing.output).closed === true) || cleanup;
    const active = Boolean(sessionId) && !closed && !closing && !isTerminal(run.state);
    const screenshot = sessionId ? tasks.findLast((other) => other.view.tool === 'web.screenshot' && sessionFor(other) === sessionId && typeof record(other.output).path === 'string') : undefined;
    return {
      taskId: task.view.id, sessionId, remoteId: str(output.anchorSessionId), url: str(output.url) ?? str(task.view.args.url), title: str(output.title),
      viewer: anchorViewerUrl(output.liveViewUrl), active, closed,
      state: closed ? 'Closed' : closing ? 'Closing' : cleanupFailed ? 'Cleanup failed' : active ? 'Live' : sessionId ? 'Run ended' : task.state === 'failed' ? 'Failed' : 'Starting',
      screenshotTaskId: screenshot?.view.id ?? null,
      actions: sessionId ? tasks.filter((other) => sessionFor(other) === sessionId && other.view.tool.startsWith('web.')) : [],
    };
  });
}

export interface MemoryActivity { at: number; action: string; message: string; procedureId: string | null; memoryId: string | null; sessionId: string | null; score: number | null }
export function memoryEvidence(run: RunUi): MemoryActivity[] {
  return run.events.flatMap((e): MemoryActivity[] => {
    if (e.type !== 'log' && e.type !== 'narration') return [];
    const data = e.type === 'log' ? record(e.data) : {};
    const message = e.type === 'log' ? e.message : e.text;
    const structured = data.provider === 'surrealdb';
    if (!structured && !/^memory:|^Reusing procedure .* from SurrealDB memory/.test(message)) return [];
    const legacyAction = /^Reusing procedure/.test(message) ? 'recalled' : /saved verified procedure|verified again/.test(message) ? 'saved' : /failed|stale|not configured/.test(message) ? 'failed' : 'info';
    const source = record(data.source);
    return [{
      at: e.at, action: str(data.activity) ?? legacyAction, message,
      procedureId: str(data.procedureId) ?? /\b(proc_[A-Za-z0-9_-]+)/.exec(message)?.[1] ?? null,
      memoryId: str(data.memoryId) ?? /SurrealDB Agent Memory \(([^)]+)\)/.exec(message)?.[1] ?? null,
      sessionId: str(source.sessionId), score: typeof data.score === 'number' ? data.score : null,
    }];
  });
}

export function timelineEvidence(run: RunUi, now = Date.now()) {
  const end = run.finishedAt ?? now;
  const tasks = run.order.flatMap((id) => {
    const task = run.tasks[id];
    return task?.startedAt === undefined ? [] : [{ id, label: task.view.title, tool: task.view.tool, start: task.startedAt, end: ['succeeded', 'failed', 'skipped', 'cancelled', 'denied'].includes(task.state) ? task.endedAt ?? end : end, state: task.state, kind: 'tool' }];
  });
  const models = run.events.flatMap((event: RunEvent, i) => event.type === 'model_call' ? [{ id: `model-${i}`, label: event.call.purpose, tool: event.call.model, start: Math.max(run.createdAt, event.at - event.call.latencyMs), end: event.at, state: event.call.ok ? 'succeeded' : /cancel/i.test(event.call.error ?? '') ? 'cancelled' : 'failed', kind: 'model' }] : []);
  return [...tasks, ...models].sort((a, b) => a.start - b.start);
}
