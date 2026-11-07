import type {
  AppStatus,
  ApprovalRequest,
  CheckResult,
  ModelCall,
  PolicyDecision,
  RouteDecision,
  RunEvent,
  RunSnapshot,
  RunState,
  TaskState,
  TaskView,
  VoiceEvent,
  VoiceState,
} from '@commandos/contracts';
import { useSyncExternalStore } from 'react';

export interface TaskUi {
  view: TaskView;
  state: TaskState;
  attempt: number;
  error?: string;
  detail?: string;
  output?: unknown;
  checks?: CheckResult[];
  policy?: PolicyDecision;
  startedAt?: number;
  endedAt?: number;
}

export interface RunUi {
  runId: string;
  command: string;
  source: string;
  dryRun: boolean;
  createdAt: number;
  state: RunState;
  summary?: string;
  decision?: RouteDecision;
  routeLatencyMs?: number;
  tasks: Record<string, TaskUi>;
  order: string[];
  events: RunEvent[];
  traceId?: string;
  metrics: Record<string, number>;
  modelCalls: ModelCall[];
  undo?: { ok: boolean; steps: number; failures: string[] };
  finishedAt?: number;
}

export interface VoiceUi {
  state: VoiceState;
  detail?: string;
  partial: string;
  level: number;
  transcripts: Array<{ text: string; at: number; ms?: number }>;
  speaking?: string;
  error?: string;
}

export interface UiState {
  runs: Record<string, RunUi>;
  runOrder: string[];
  selectedRunId: string | null;
  approvals: Record<string, ApprovalRequest>;
  voice: VoiceUi;
  status: AppStatus | null;
}

const TERMINAL: RunState[] = ['succeeded', 'failed', 'partial', 'cancelled', 'stopped', 'undone'];
export const isTerminal = (s: RunState) => TERMINAL.includes(s);

function emptyRun(e: Extract<RunEvent, { type: 'run_created' }>): RunUi {
  return {
    runId: e.runId,
    command: e.command,
    source: e.source,
    dryRun: e.dryRun,
    createdAt: e.at,
    state: 'created',
    tasks: {},
    order: [],
    events: [],
    metrics: {},
    modelCalls: [],
  };
}

function reduceRun(run: RunUi, e: RunEvent): RunUi {
  const events = run.events.length >= 3000 ? [...run.events.slice(-2500), e] : [...run.events, e];
  const next: RunUi = { ...run, events };
  const patchTask = (id: string, patch: Partial<TaskUi>) => {
    const cur = next.tasks[id];
    if (cur) next.tasks = { ...next.tasks, [id]: { ...cur, ...patch } };
  };
  switch (e.type) {
    case 'run_state':
      next.state = e.state;
      if (e.summary) next.summary = e.summary;
      if (isTerminal(e.state)) next.finishedAt = e.at;
      break;
    case 'route':
      next.decision = e.decision;
      next.routeLatencyMs = e.latencyMs;
      break;
    case 'trace':
      next.traceId = e.traceId;
      break;
    case 'task_added':
      next.tasks = { ...next.tasks, [e.task.id]: { view: e.task, state: 'pending', attempt: 0 } };
      next.order = [...next.order, e.task.id];
      break;
    case 'task_state': {
      const cur = next.tasks[e.taskId];
      patchTask(e.taskId, {
        state: e.state,
        attempt: e.attempt,
        ...(e.error ? { error: e.error } : {}),
        ...(e.detail ? { detail: e.detail } : {}),
        ...(e.state === 'running' && !cur?.startedAt ? { startedAt: e.at } : {}),
        ...(['succeeded', 'failed', 'skipped', 'cancelled', 'denied'].includes(e.state) ? { endedAt: e.at } : {}),
      });
      break;
    }
    case 'task_output':
      patchTask(e.taskId, { output: e.output });
      break;
    case 'verification':
      patchTask(e.taskId, { checks: e.checks });
      break;
    case 'policy':
      patchTask(e.taskId, { policy: e.decision });
      break;
    case 'metric':
      next.metrics = { ...next.metrics, [e.name]: e.value };
      break;
    case 'model_call':
      next.modelCalls = [...next.modelCalls, e.call];
      break;
    case 'undo':
      next.undo = { ok: e.ok, steps: e.steps, failures: e.failures };
      break;
    default:
      break;
  }
  return next;
}

class Store {
  private state: UiState = {
    runs: {},
    runOrder: [],
    selectedRunId: null,
    approvals: {},
    voice: { state: 'idle', partial: '', level: 0, transcripts: [] },
    status: null,
  };
  private listeners = new Set<() => void>();
  private scheduled = false;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.state;

  private commit(next: UiState): void {
    this.state = next;
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const l of this.listeners) l();
    });
  }

  applyRunEvent(e: RunEvent): void {
    const s = this.state;
    let run = s.runs[e.runId];
    let runOrder = s.runOrder;
    let selectedRunId = s.selectedRunId;
    if (e.type === 'run_created') {
      run = emptyRun(e);
      if (!runOrder.includes(e.runId)) runOrder = [e.runId, ...runOrder];
      selectedRunId = e.runId;
    }
    if (!run) return;
    let approvals = s.approvals;
    if (e.type === 'approval_requested') approvals = { ...approvals, [e.approval.id]: e.approval };
    if (e.type === 'approval_resolved' && approvals[e.approvalId]) {
      approvals = { ...approvals };
      delete approvals[e.approvalId];
    }
    this.commit({ ...s, runs: { ...s.runs, [e.runId]: reduceRun(run, e) }, runOrder, selectedRunId, approvals });
  }

  applyVoiceEvent(e: VoiceEvent): void {
    const v = this.state.voice;
    let next: VoiceUi = v;
    switch (e.type) {
      case 'state':
        next = { ...v, state: e.state, detail: e.detail, ...(e.state === 'listening' ? { error: undefined } : {}), ...(e.state === 'idle' ? { level: 0 } : {}) };
        break;
      case 'partial':
        next = { ...v, partial: e.text };
        break;
      case 'committed':
        next = { ...v, partial: '', transcripts: [...v.transcripts.slice(-49), { text: e.text, at: e.at, ms: e.metrics.utteranceToCommitMs }] };
        break;
      case 'level':
        next = { ...v, level: e.rms };
        break;
      case 'speaking':
        next = { ...v, speaking: e.text };
        break;
      case 'error':
        next = { ...v, error: e.message };
        break;
    }
    this.commit({ ...this.state, voice: next });
  }

  applyStatus(status: AppStatus): void {
    this.commit({ ...this.state, status });
  }

  loadSnapshot(snap: RunSnapshot): void {
    let run: RunUi | undefined;
    for (const e of snap.events) {
      if (e.type === 'run_created') run = emptyRun(e);
      else if (run) run = reduceRun(run, e);
    }
    if (!run) return;
    run = { ...run, state: snap.summary.state, ...(snap.summary.summary ? { summary: snap.summary.summary } : {}) };
    const runOrder = this.state.runOrder.includes(run.runId) ? this.state.runOrder : [run.runId, ...this.state.runOrder];
    this.commit({ ...this.state, runs: { ...this.state.runs, [run.runId]: run }, runOrder, selectedRunId: run.runId });
  }

  select(runId: string | null): void {
    this.commit({ ...this.state, selectedRunId: runId });
  }

  clearVoiceError(): void {
    this.commit({ ...this.state, voice: { ...this.state.voice, error: undefined } });
  }
}

export const store = new Store();

export function useUi<T>(selector: (s: UiState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
}
