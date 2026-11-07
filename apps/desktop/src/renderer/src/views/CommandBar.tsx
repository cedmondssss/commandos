import { useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalCard } from '../components/ApprovalCard';
import { ActionDetails } from '../components/ActionDetails';
import { CommandInput } from '../components/CommandInput';
import { StopButton } from '../components/StopButton';
import { UndoRunButton } from '../components/UndoRunButton';
import { Button, cx } from '../components/ui';
import { invoke } from '../lib/api';
import { RUN_STATE_STYLE } from '../lib/format';
import { isTerminal, type TaskUi, useUi } from '../lib/store';

const STEP_ICON: Record<TaskUi['state'], { icon: string; tone: string }> = {
  pending: { icon: '·', tone: 'text-zinc-500' },
  ready: { icon: '·', tone: 'text-sky-300' },
  running: { icon: '◌', tone: 'text-indigo-300 animate-pulse' },
  verifying: { icon: '◌', tone: 'text-violet-300 animate-pulse' },
  awaiting_approval: { icon: '⏸', tone: 'text-amber-300 animate-pulse' },
  succeeded: { icon: '✓', tone: 'text-emerald-300' },
  failed: { icon: '✗', tone: 'text-rose-300' },
  denied: { icon: '⊘', tone: 'text-rose-300' },
  skipped: { icon: '–', tone: 'text-zinc-500' },
  cancelled: { icon: '–', tone: 'text-zinc-500' },
};

function StepRow({ task }: { task: TaskUi }) {
  const s = STEP_ICON[task.state];
  return (
    <div className="flex items-start gap-2 px-1 text-[12.5px] leading-snug">
      <span className={cx('w-3 shrink-0 text-center font-semibold', s.tone)}>{s.icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cx(task.state === 'skipped' || task.state === 'pending' ? 'text-zinc-400' : 'text-fg')}>{task.view.title ?? task.view.tool}</span>
        {(task.state === 'failed' || task.state === 'denied') && task.error ? <span className="block truncate text-[11.5px] text-rose-300/90">{task.error}</span> : null}
        {task.state === 'running' && task.detail ? <span className="block truncate text-[11.5px] text-muted">{task.detail}</span> : null}
        {task.policy?.explanation ? <details className="mt-1 text-[11px]">
          <summary className="cursor-pointer text-muted">What happens & why</summary>
          <div className="mt-1 rounded-lg bg-black/20 p-2"><ActionDetails explanation={task.policy.explanation} compact /></div>
        </details> : null}
      </span>
    </div>
  );
}

/**
 * See-through overlay (⌥Space focuses it): input, live steps, approvals and the answer, floating
 * above the app CommandOS is driving. It sizes its window to its content.
 */
export function CommandBar() {
  const runs = useUi((s) => s.runs);
  const runOrder = useUi((s) => s.runOrder);
  const approvals = useUi((s) => s.approvals);
  const voice = useUi((s) => s.voice);
  const [collapsed, setCollapsed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const latest = runOrder[0] ? runs[runOrder[0]] : undefined;
  const pending = useMemo(() => Object.values(approvals).sort((a, b) => a.createdAt - b.createdAt)[0], [approvals]);
  const steps = useMemo(() => (latest ? latest.order.flatMap((id) => (latest.tasks[id] ? [latest.tasks[id]] : [])) : []), [latest]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let last = 0;
    const fit = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height !== last) {
        last = height;
        void invoke('window.fitBar', { height: Math.max(40, Math.min(1200, height)) }).catch(() => {});
      }
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={root}
      className="drag flex w-screen flex-col gap-2 rounded-[20px] border border-white/15 bg-[#0b0d12]/60 p-3 text-fg shadow-2xl [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]"
    >
      <div className="flex items-center gap-2">
        <span className="pl-1 text-[12px] font-semibold tracking-wide text-fg/80">CommandOS</span>
        {latest ? <span className={cx('rounded-md px-1.5 py-0.5 text-[10.5px] font-medium', RUN_STATE_STYLE[latest.state])}>{latest.state}</span> : null}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" className="no-drag" title={collapsed ? 'Show steps' : 'Hide steps'} onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? '▾' : '▴'}
          </Button>
          <Button size="sm" variant="ghost" className="no-drag" onClick={() => void invoke('window.show', { which: 'main' })}>
            Dashboard
          </Button>
          <Button size="sm" variant="ghost" className="no-drag" aria-label="Hide overlay" title="Hide overlay (⌥Space to reopen)" onClick={() => void invoke('window.hideBar', {})}>
            ×
          </Button>
          <StopButton />
        </span>
      </div>
      <CommandInput autoFocus large listenOnShortcut showDryRun={false} overlay />
      {voice.state === 'error' || voice.error ? <div className="truncate px-1 text-[12px] text-rose-300">{voice.error ?? voice.detail}</div> : null}
      {pending ? (
        <div className="no-drag">
          <ApprovalCard approval={pending} compact />
        </div>
      ) : null}
      {!collapsed && latest ? (
        <div className="no-drag flex flex-col gap-1.5">
          <div className="truncate px-1 text-[11.5px] text-muted">“{latest.command}”</div>
          {steps.length ? <div className="flex max-h-[300px] flex-col gap-1 overflow-y-auto">{steps.map((t) => <StepRow key={t.view.id} task={t} />)}</div> : null}
          {isTerminal(latest.state) && latest.summary ? (
            <div className="selectable rounded-xl bg-white/[0.06] px-2.5 py-2 text-[13px] leading-snug text-fg">{latest.summary}</div>
          ) : null}
        </div>
      ) : null}
      {latest && <div className="no-drag"><UndoRunButton key={latest.runId} run={latest} /></div>}
      {!latest && !pending ? <div className="px-1 text-[11.5px] text-muted">⌥Space type · ⌃⌥Space talk · ⌃⌥Esc stop everything</div> : null}
    </div>
  );
}
