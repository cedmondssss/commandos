import type { RunEvent, RunState, TaskState } from '@commandos/contracts';

export function ms(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(v / 60_000)}m ${Math.round((v % 60_000) / 1000)}s`;
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relative(at: number, t0: number): string {
  const d = (at - t0) / 1000;
  return `+${d.toFixed(d < 10 ? 2 : 1)}s`;
}

export const TASK_STATE_STYLE: Record<TaskState, { label: string; dot: string; text: string; ring: string }> = {
  pending: { label: 'pending', dot: 'bg-zinc-500', text: 'text-zinc-400', ring: 'ring-zinc-700' },
  ready: { label: 'ready', dot: 'bg-sky-400', text: 'text-sky-300', ring: 'ring-sky-700' },
  awaiting_approval: { label: 'needs approval', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', ring: 'ring-amber-500' },
  running: { label: 'running', dot: 'bg-indigo-400 animate-pulse', text: 'text-indigo-300', ring: 'ring-indigo-500' },
  verifying: { label: 'verifying', dot: 'bg-violet-400 animate-pulse', text: 'text-violet-300', ring: 'ring-violet-500' },
  succeeded: { label: 'verified', dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'ring-emerald-600' },
  failed: { label: 'failed', dot: 'bg-rose-500', text: 'text-rose-300', ring: 'ring-rose-600' },
  skipped: { label: 'skipped', dot: 'bg-zinc-600', text: 'text-zinc-400', ring: 'ring-zinc-700' },
  cancelled: { label: 'cancelled', dot: 'bg-zinc-600', text: 'text-zinc-400', ring: 'ring-zinc-700' },
  denied: { label: 'denied', dot: 'bg-rose-400', text: 'text-rose-300', ring: 'ring-rose-700' },
};

export const RUN_STATE_STYLE: Record<RunState, string> = {
  created: 'bg-zinc-700 text-zinc-200',
  routing: 'bg-sky-900/60 text-sky-200',
  planning: 'bg-sky-900/60 text-sky-200',
  running: 'bg-indigo-900/60 text-indigo-200',
  succeeded: 'bg-emerald-900/60 text-emerald-200',
  failed: 'bg-rose-900/60 text-rose-200',
  partial: 'bg-amber-900/60 text-amber-200',
  cancelled: 'bg-zinc-800 text-zinc-300',
  stopped: 'bg-rose-950 text-rose-200',
  undone: 'bg-zinc-800 text-zinc-300',
};

/** One-line human description of an event for the activity log (null = not shown). */
export function describeEvent(e: RunEvent): { icon: string; text: string; tone: 'muted' | 'ok' | 'warn' | 'err' | 'info' } | null {
  switch (e.type) {
    case 'run_created':
      return { icon: '›', text: `${e.source === 'voice' ? 'Heard' : 'Command'}: “${e.command}”${e.dryRun ? ' (dry run)' : ''}`, tone: 'info' };
    case 'route':
      return {
        icon: '⇢',
        text: `Routed to ${e.decision.mode.toUpperCase()} · ${e.decision.intent} via ${e.decision.via} (${Math.round(e.latencyMs)} ms) — ${e.decision.reason}`,
        tone: 'info',
      };
    case 'task_added':
      return { icon: '+', text: `Planned ${e.task.id}: ${e.task.title} [${e.task.tool}]`, tone: 'muted' };
    case 'task_state': {
      if (e.state === 'pending' || e.state === 'ready') return null;
      const tone = e.state === 'succeeded' ? 'ok' : e.state === 'failed' || e.state === 'denied' ? 'err' : e.state === 'awaiting_approval' ? 'warn' : 'muted';
      const extra = e.error ?? e.detail;
      return { icon: '●', text: `${e.taskId} ${TASK_STATE_STYLE[e.state].label}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}${extra ? ` — ${extra}` : ''}`, tone };
    }
    case 'verification':
      return {
        icon: e.ok ? '✓' : '✗',
        text: `${e.taskId}: ${e.checks.filter((c) => c.ok).length}/${e.checks.length} checks passed${e.ok ? '' : ` — ${e.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')}`}`,
        tone: e.ok ? 'ok' : 'err',
      };
    case 'policy':
      if (e.decision.action === 'allow') return null;
      return { icon: '⚑', text: `${e.taskId}: policy ${e.decision.action.replace('_', ' ')} — ${e.decision.reasons.join('; ')}`, tone: e.decision.action === 'deny' ? 'err' : 'warn' };
    case 'approval_requested':
      return { icon: '?', text: `Approval needed: ${e.approval.title}`, tone: 'warn' };
    case 'approval_resolved':
      return { icon: e.decision === 'approved' ? '✓' : '✗', text: `Approval ${e.decision} (${e.by})`, tone: e.decision === 'approved' ? 'ok' : 'warn' };
    case 'model_call':
      return {
        icon: '◆',
        text: `${e.call.model} (${e.call.effort}) for ${e.call.purpose}: ${Math.round(e.call.latencyMs)} ms${e.call.outputTokens ? `, ${e.call.outputTokens} out tok` : ''}${e.call.ok ? '' : ` — ${e.call.error}`}`,
        tone: e.call.ok ? 'muted' : 'err',
      };
    case 'narration':
      return { icon: '·', text: e.text, tone: 'muted' };
    case 'log':
      return e.level === 'debug' ? null : { icon: e.level === 'error' ? '!' : 'i', text: e.message, tone: e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'muted' };
    case 'run_state':
      return e.summary ? { icon: '■', text: `Run ${e.state}: ${e.summary}`, tone: e.state === 'succeeded' ? 'ok' : e.state === 'failed' ? 'err' : 'info' } : null;
    case 'undo':
      return { icon: '↺', text: `Undo ${e.ok ? 'complete' : 'incomplete'}: ${e.steps} step(s)${e.failures.length ? ` — ${e.failures.join('; ')}` : ''}`, tone: e.ok ? 'ok' : 'warn' };
    case 'metric':
      return e.unit === 'ms' ? { icon: '⏱', text: `${e.name.replaceAll('_', ' ')}: ${ms(e.value)}`, tone: 'muted' } : null;
    case 'trace':
    case 'task_output':
      return null;
  }
}
