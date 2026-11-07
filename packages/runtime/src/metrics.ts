import type { RouteDecision, RunEvent, RunMetrics } from '@commandos/contracts';

/** Derives per-run performance and correctness metrics from the event stream. */
export function computeMetrics(runId: string, events: RunEvent[], extra: { speechToTranscriptMs?: number } = {}): RunMetrics {
  const created = events.find((e) => e.type === 'run_created');
  const t0 = created?.at ?? events[0]?.at ?? 0;
  let decision: RouteDecision | undefined;
  let routerMs: number | undefined;
  let firstRunningAt: number | undefined;
  let firstAddedAt: number | undefined;
  let endAt: number | undefined;
  let modelCalls = 0;
  let modelLatencyMs = 0;
  let planningModelCalls = 0;
  const runningSince = new Map<string, { at: number; tool: string }>();
  const toolOf = new Map<string, string>();
  const toolLatencyMs: Record<string, number> = {};
  let toolCalls = 0;
  let retries = 0;
  const finalStates = new Map<string, string>();
  const verifiedOk = new Set<string>();
  const verifiedFail = new Set<string>();
  const failedOnce = new Set<string>();
  let finalRunState: string | undefined;

  for (const e of events) {
    switch (e.type) {
      case 'route':
        decision = e.decision;
        routerMs = e.latencyMs;
        break;
      case 'task_added':
        toolOf.set(e.task.id, e.task.tool);
        firstAddedAt ??= e.at;
        break;
      case 'task_state': {
        if (e.state === 'running') {
          firstRunningAt ??= e.at;
          toolCalls++;
          if (e.attempt > 1) {
            retries++;
            failedOnce.add(e.taskId);
          }
          runningSince.set(e.taskId, { at: e.at, tool: toolOf.get(e.taskId) ?? 'unknown' });
        } else if (e.state !== 'verifying') {
          const started = runningSince.get(e.taskId);
          if (started && (e.state === 'succeeded' || e.state === 'failed' || e.state === 'cancelled')) {
            toolLatencyMs[started.tool] = (toolLatencyMs[started.tool] ?? 0) + (e.at - started.at);
            runningSince.delete(e.taskId);
          }
        }
        if (e.state === 'failed') failedOnce.add(e.taskId);
        finalStates.set(e.taskId, e.state);
        break;
      }
      case 'verification':
        (e.ok ? verifiedOk : verifiedFail).add(e.taskId);
        break;
      case 'model_call':
        modelCalls++;
        modelLatencyMs += e.call.latencyMs;
        if (e.call.purpose.startsWith('route') || e.call.purpose.startsWith('plan')) planningModelCalls++;
        break;
      case 'run_state':
        if (['succeeded', 'failed', 'partial', 'cancelled', 'stopped'].includes(e.state)) {
          endAt = e.at;
          finalRunState = e.state;
        }
        break;
      default:
        break;
    }
  }

  const states = [...finalStates.values()];
  const tasksSucceeded = states.filter((s) => s === 'succeeded').length;
  const tasksFailed = states.filter((s) => s === 'failed').length;
  const recoveredTasks = [...failedOnce].filter((id) => finalStates.get(id) === 'succeeded').length;
  const deterministic = decision?.mode === 'fast' && decision.via !== 'router';
  return {
    runId,
    ...(decision ? { mode: decision.mode } : {}),
    ...(extra.speechToTranscriptMs !== undefined ? { speechToTranscriptMs: extra.speechToTranscriptMs } : {}),
    ...(routerMs !== undefined ? { routerMs } : {}),
    ...(firstAddedAt !== undefined ? { planningMs: firstAddedAt - t0 } : {}),
    ...(firstRunningAt !== undefined ? { timeToFirstActionMs: firstRunningAt - t0 } : {}),
    ...(endAt !== undefined ? { totalMs: endAt - t0 } : {}),
    modelCalls,
    modelLatencyMs,
    toolCalls,
    toolLatencyMs,
    tasksSucceeded,
    tasksFailed,
    tasksVerified: [...verifiedOk].filter((id) => !verifiedFail.has(id) || finalStates.get(id) === 'succeeded').length,
    retries,
    recoveredTasks,
    unnecessaryModelCalls: deterministic ? planningModelCalls : 0,
    // The runtime permits success with historical failures only when deterministic goal evidence
    // resolves every failed branch. Keep tasksFailed as the honest attempt count.
    verifiedSuccess: finalRunState === 'succeeded' && states.length > 0,
  };
}
