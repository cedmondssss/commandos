import { useMemo, useState } from 'react';
import { ActivityLog } from '../components/ActivityLog';
import { ApprovalCard } from '../components/ApprovalCard';
import { ActionDetails } from '../components/ActionDetails';
import { CommandInput } from '../components/CommandInput';
import { DagView } from '../components/DagView';
import { RunHeader } from '../components/RunHeader';
import { StopButton } from '../components/StopButton';
import { Badge, Button, cx, Empty, Panel } from '../components/ui';
import { invoke } from '../lib/api';
import { clock, ms, RUN_STATE_STYLE, TASK_STATE_STYLE } from '../lib/format';
import { store, useUi } from '../lib/store';
import { DiagnosticsView } from './DiagnosticsView';
import { HistoryView } from './HistoryView';
import { SettingsView } from './SettingsView';
import { IntegrationSummary, IntegrationsView } from './IntegrationsView';
import { SafetyLabView } from './SafetyLabView';

type Tab = 'live' | 'safety' | 'integrations' | 'approvals' | 'history' | 'settings' | 'diagnostics';

function TaskInspector() {
  const runId = useUi((s) => s.selectedRunId);
  const run = useUi((s) => (s.selectedRunId ? s.runs[s.selectedRunId] : undefined));
  const [selected, setSelected] = useState<string | null>(null);
  if (!run || !runId) return null;
  const ids = run.order;
  const selectedId = selected && run.tasks[selected] ? selected : ids[0];
  const task = selectedId ? run.tasks[selectedId] : undefined;
  return (
    <Panel title="Tasks">
      <div className="flex max-h-[340px] min-h-0">
        <ul className="w-56 shrink-0 overflow-y-auto border-r border-line py-1">
          {ids.map((id) => {
            const t = run.tasks[id];
            if (!t) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setSelected(id)}
                  className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-white/5', selectedId === id && 'bg-white/8')}
                >
                  <span className={cx('h-2 w-2 shrink-0 rounded-full', TASK_STATE_STYLE[t.state].dot)} />
                  <span className="truncate">{t.view.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="selectable min-w-0 flex-1 overflow-y-auto p-3 text-[12px]">
          {!task ? (
            <Empty>Select a task to see its arguments, output, policy decision and verification checks.</Empty>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12.5px] text-fg">{task.view.tool}</span>
                <Badge className={cx('bg-white/6', TASK_STATE_STYLE[task.state].text)}>{TASK_STATE_STYLE[task.state].label}</Badge>
                {task.startedAt && task.endedAt && <Badge>{ms(task.endedAt - task.startedAt)}</Badge>}
                {task.attempt > 1 && <Badge className="bg-amber-950 text-amber-200">attempt {task.attempt}</Badge>}
              </div>
              {task.error && <p className="text-rose-300">{task.error}</p>}
              {task.detail && <p className="text-muted">{task.detail}</p>}
              {task.policy?.explanation ? <ActionDetails explanation={task.policy.explanation} /> : <p className="text-muted">Permission and data-sharing details appear after the step’s arguments are resolved and checked.</p>}
              {task.policy && (
                <details>
                  <summary className="cursor-pointer text-muted">Technical policy decision</summary>
                  <p>
                    {task.policy.action} · {task.policy.effectClass} · risk {task.policy.risk}
                    {task.policy.reasons.length ? ` — ${task.policy.reasons.join('; ')}` : ''}
                  </p>
                </details>
              )}
              {task.checks && (
                <div>
                  <h4 className="mb-1 text-[11px] uppercase tracking-wider text-muted">verification</h4>
                  <ul className="space-y-0.5">
                    {task.checks.map((c, i) => (
                      <li key={`${i}-${c.label}`} className={c.ok ? 'text-emerald-300' : 'text-rose-300'}>
                        {c.ok ? '✓' : '✗'} {c.label}
                        {c.detail ? <span className="text-muted"> ({c.detail})</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <h4 className="mb-1 text-[11px] uppercase tracking-wider text-muted">arguments</h4>
                <pre className="overflow-x-auto rounded-lg bg-black/30 p-2 text-zinc-300">{JSON.stringify(task.view.args, null, 2)}</pre>
                {task.view.bind.length > 0 && (
                  <p className="mt-1 text-muted">bound: {task.view.bind.map((b) => `${b.arg} ← ${b.from}`).join(', ')}</p>
                )}
              </div>
              {task.output !== undefined && (
                <div>
                  <h4 className="mb-1 text-[11px] uppercase tracking-wider text-muted">output</h4>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-black/30 p-2 text-zinc-300">{JSON.stringify(task.output, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

function LiveView({ onIntegrations }: { onIntegrations: () => void }) {
  const run = useUi((s) => (s.selectedRunId ? s.runs[s.selectedRunId] : undefined));
  const voice = useUi((s) => s.voice);
  if (!run) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-[15px] text-fg">Speak or type a command to start.</p>
        <p className="max-w-lg text-[13px] text-muted">
          Try “Find my five latest screenshots, rename them based on their contents, and put them in a folder called Sorted, then write a report.”
        </p>
        {voice.transcripts.length > 0 && <p className="text-[12px] text-muted">Last heard: “{voice.transcripts.at(-1)?.text}”</p>}
      </div>
    );
  }
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_380px] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <div className="col-span-2">
        <RunHeader run={run} />
        <div className="mt-2"><IntegrationSummary run={run} onOpen={onIntegrations} /></div>
      </div>
      <Panel title="Plan (live DAG)" className="flex min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <DagView run={run} />
        </div>
      </Panel>
      <Panel title="Activity" className="flex min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <ActivityLog run={run} />
        </div>
      </Panel>
      <div className="col-span-2">
        <TaskInspector />
      </div>
    </div>
  );
}

function RunList() {
  const runs = useUi((s) => s.runs);
  const runOrder = useUi((s) => s.runOrder);
  const selected = useUi((s) => s.selectedRunId);
  if (!runOrder.length) return <p className="px-3 py-2 text-[12px] text-muted">No runs this session.</p>;
  return (
    <ul className="space-y-0.5 px-1.5">
      {runOrder.map((id) => {
        const r = runs[id];
        if (!r) return null;
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => store.select(id)}
              className={cx('w-full rounded-lg px-2 py-1.5 text-left hover:bg-white/5', selected === id && 'bg-white/8')}
            >
              <div className="truncate text-[12.5px] text-fg">{r.command}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                <span className={cx('rounded px-1', RUN_STATE_STYLE[r.state])}>{r.state}</span>
                {clock(r.createdAt)}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function Dashboard() {
  const [tab, setTab] = useState<Tab>('live');
  const [draft, setDraft] = useState<{ text: string; key: number }>();
  const approvals = useUi((s) => s.approvals);
  const status = useUi((s) => s.status);
  const pending = useMemo(() => Object.values(approvals).sort((a, b) => a.createdAt - b.createdAt), [approvals]);
  const tabs: Array<[Tab, string]> = [
    ['live', 'Live'],
    ['safety', 'Safety Lab'],
    ['integrations', 'Integrations'],
    ['approvals', `Approvals${pending.length ? ` (${pending.length})` : ''}`],
    ['history', 'History'],
    ['settings', 'Settings'],
    ['diagnostics', 'Diagnostics'],
  ];
  return (
    <div className="flex h-screen w-screen bg-bg text-fg">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel/60">
        <div className="drag h-12 shrink-0" />
        <div className="px-4 pb-3">
          <div className="text-[15px] font-semibold">CommandOS</div>
          <div className="text-[11px] text-muted">voice-driven Mac agent</div>
        </div>
        <nav className="space-y-0.5 px-1.5">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cx('w-full rounded-lg px-2.5 py-1.5 text-left text-[13px]', tab === id ? 'bg-accent/20 text-fg' : 'text-muted hover:bg-white/5')}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="mt-4 px-4 pb-1 text-[11px] uppercase tracking-wider text-muted">This session</div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <RunList />
        </div>
        <div className="border-t border-line p-3 text-[11px] text-muted">
          runtime: <span className={status?.runtime === 'ready' ? 'text-emerald-300' : 'text-amber-300'}>{status?.runtime ?? 'starting'}</span>
          {' · '}helper: <span className={status?.helper?.running ? 'text-emerald-300' : 'text-amber-300'}>{status?.helper?.running ? 'running' : 'offline'}</span>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <div className="no-drag min-w-0 flex-1">
            <CommandInput draft={draft} />
          </div>
          <StopButton all />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {tab === 'live' && (
            <>
              {pending.length > 0 && (
                <div className="mb-3 space-y-2">
                  {pending.map((a) => (
                    <ApprovalCard key={a.id} approval={a} />
                  ))}
                </div>
              )}
              <LiveView onIntegrations={() => setTab('integrations')} />
            </>
          )}
          {tab === 'approvals' &&
            (pending.length ? (
              <div className="space-y-3">
                {pending.map((a) => (
                  <ApprovalCard key={a.id} approval={a} />
                ))}
              </div>
            ) : (
              <Empty>No actions are waiting for your approval.</Empty>
            ))}
          {tab === 'history' && <HistoryView onOpen={() => setTab('live')} />}
          {tab === 'integrations' && <IntegrationsView onDraft={(text) => setDraft({ text, key: Date.now() })} />}
          {tab === 'settings' && <SettingsView />}
          {tab === 'safety' && <SafetyLabView />}
          {tab === 'diagnostics' && <DiagnosticsView />}
        </div>
      </main>
    </div>
  );
}
