import { useCallback, useEffect, useState } from 'react';
import type { Diagnostics } from '@commandos/contracts';
import { Badge, Button, cx, Empty, Panel } from '../components/ui';
import { invoke } from '../lib/api';
import { ANCHOR_EXAMPLE, browserEvidence, MEMORY_EXAMPLE, MEMORY_REPLAY_EXAMPLE, memoryEvidence, record, str, timelineEvidence } from '../lib/integrations';
import { ms, TASK_STATE_STYLE } from '../lib/format';
import { isTerminal, type RunUi, useUi } from '../lib/store';

type Section = 'anchor' | 'memory' | 'arize' | 'other';
const external = 'inline-flex items-center rounded-lg border border-line px-3 py-1.5 text-xs text-fg hover:bg-white/8';

function Copy({ value, label = 'Copy ID' }: { value: string; label?: string }) {
  const [result, setResult] = useState('');
  return <Button size="sm" variant="ghost" onClick={() => {
    void navigator.clipboard.writeText(value).then(() => setResult('Copied'), () => setResult('Select the text to copy'));
  }}>{result || label}</Button>;
}

function Screenshot({ runId, taskId }: { runId: string; taskId: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setImage(null); setError(null);
    void invoke('run.image', { runId, taskId }).then((r) => { if (current) setImage(r.dataUrl); }, (e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [runId, taskId]);
  if (error) return <Empty>Screenshot unavailable: {error}</Empty>;
  if (!image) return <Empty>Loading captured screenshot…</Empty>;
  return <img src={image} alt="Browser screenshot captured during the selected run" className="mx-auto max-h-[560px] w-full object-contain" />;
}

function LiveBrowser({ runId, sessionId, onFrame }: { runId: string; sessionId: string; onFrame: (image: string) => void }) {
  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState('Connecting to the remote browser…');
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await invoke('browser.preview', { runId, sessionId });
        if (!current) return;
        if (result.dataUrl) { setImage(result.dataUrl); onFrame(result.dataUrl); setStatus(''); }
        else setStatus(result.state === 'closed' ? 'Browser session ended.' : 'Waiting for the remote page…');
        if (result.state === 'closed') return;
      } catch { if (current) setStatus('Preview temporarily unavailable. The task can continue.'); }
      if (current) timer = setTimeout(() => void read(), 1000);
    };
    void read();
    return () => { current = false; clearTimeout(timer); };
  }, [runId, sessionId, onFrame]);
  return <div aria-label="Anchor Browser live preview">
    {image ? <img src={image} alt="Live remote Anchor Browser page" className="mx-auto max-h-[560px] w-full object-contain" /> : <Empty>{status}</Empty>}
    {image && status && <p className="px-4 py-2 text-xs text-muted" role="status">{status}</p>}
  </div>;
}

function AnchorPanel({ run, onDraft }: { run?: RunUi; onDraft: (text: string) => void }) {
  const sessions = run ? browserEvidence(run) : [];
  const [selected, setSelected] = useState<string | null>(null);
  const session = sessions.find((s) => s.sessionId === selected) ?? sessions.at(-1);
  const [showCapture, setShowCapture] = useState(false);
  const [lastFrame, setLastFrame] = useState<{ runId: string; sessionId: string; image: string } | null>(null);
  const rememberFrame = useCallback((image: string) => {
    if (run && session?.sessionId) setLastFrame({ runId: run.runId, sessionId: session.sessionId, image });
  }, [run?.runId, session?.sessionId]);
  useEffect(() => setShowCapture(false), [run?.runId, session?.sessionId]);
  return <div className="space-y-3">
    <Panel title="Anchor Browser · cloud browser" actions={<Button size="sm" variant="ghost" onClick={() => onDraft(ANCHOR_EXAMPLE)}>Try a read-only browser task</Button>}>
      {!session ? <div className="space-y-2 px-4 py-8 text-sm text-muted">
        <p>No Anchor session in {run ? 'this run' : 'the dashboard yet'}.</p>
        <p>Ask CommandOS to use Anchor Browser for a web task. Its browser will appear here as it works.</p>
        <p className="text-xs">Your signed-in Chrome and Qwen attachment tasks use the browser on your Mac; they do not create an Anchor cloud session.</p>
      </div> : <>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Badge className={session.active ? 'bg-emerald-950 text-emerald-300' : 'bg-white/8 text-muted'}>{session.state}</Badge>
          <span className="text-xs text-muted">Read-only preview · refreshes while active</span>
          {sessions.length > 1 && <select aria-label="Anchor session" className="rounded border border-line bg-panel-2 px-2 py-1 text-xs" value={session.sessionId ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {sessions.map((s) => <option key={s.taskId} value={s.sessionId ?? ''}>{s.title || s.sessionId || s.taskId}</option>)}
          </select>}
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{session.title || session.url}</span>
          {session.active && session.viewer && <a className={external} href={session.viewer} target="_blank" rel="noreferrer">Open live view ↗</a>}
          {session.screenshotTaskId && session.active && <Button size="sm" variant="ghost" onClick={() => setShowCapture((s) => !s)}>{showCapture ? 'Show live view' : 'Show screenshot'}</Button>}
        </div>
        <div className="overflow-hidden border-y border-line bg-bg">
          {session.active && session.sessionId && run && !showCapture ? <LiveBrowser key={`${run.runId}:${session.sessionId}`} runId={run.runId} sessionId={session.sessionId} onFrame={rememberFrame} />
            : session.screenshotTaskId && run ? <Screenshot key={`${run.runId}:${session.screenshotTaskId}`} runId={run.runId} taskId={session.screenshotTaskId} />
              : lastFrame?.runId === run?.runId && lastFrame?.sessionId === session.sessionId ? <img src={lastFrame.image} alt="Last remote browser frame before the session ended" className="mx-auto max-h-[560px] w-full object-contain" />
              : <Empty>{session.active ? 'Anchor did not provide an embeddable live view for this session.' : session.closed ? 'Session closed. This run did not capture a screenshot.' : 'The run ended. A live browser is no longer shown.'}</Empty>}
        </div>
        <div className="selectable flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 text-xs text-muted">
          {session.remoteId && <span>Anchor session <code className="text-fg">{session.remoteId}</code></span>}
          {session.sessionId && <span>Run session <code>{session.sessionId}</code></span>}
          {session.closed && <span>Session closed; captured evidence stays available.</span>}
        </div>
        <div className="divide-y divide-line">
          {session.actions.map((task) => <div key={task.view.id} className="flex items-center gap-3 px-4 py-2 text-xs">
            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', TASK_STATE_STYLE[task.state].dot)} />
            <span className="min-w-0 flex-1">{task.view.title}</span>
            <span className={TASK_STATE_STYLE[task.state].text}>{TASK_STATE_STYLE[task.state].label}</span>
          </div>)}
        </div>
      </>}
    </Panel>
  </div>;
}

function MemoryPanel({ run, onDraft }: { run?: RunUi; onDraft: (text: string) => void }) {
  const events = run ? memoryEvidence(run) : [];
  const procedure = events.findLast((e) => e.procedureId);
  return <Panel title="SurrealDB · procedure memory" actions={<a className={external} href="https://studio.surrealdb.com" target="_blank" rel="noreferrer">Open Studio ↗</a>}>
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
      <Button size="sm" variant="ghost" onClick={() => onDraft(MEMORY_EXAMPLE)}>1. Organize demo screenshots</Button>
      <Button size="sm" variant="ghost" onClick={() => onDraft(MEMORY_REPLAY_EXAMPLE)}>2. Reuse for another folder</Button>
      <span className="text-xs text-muted">Examples fill the command box. Press Run when ready.</span>
    </div>
    {procedure && <div className="selectable grid gap-2 border-b border-line px-4 py-4 text-sm sm:grid-cols-2">
      <div><div className="text-xs text-muted">Verified procedure</div><code>{procedure.procedureId}</code></div>
      <div><div className="text-xs text-muted">Cloud memory record</div><code className="break-all">{procedure.memoryId ?? 'Not present in this event'}</code></div>
      {procedure.sessionId && <div><div className="text-xs text-muted">Source session</div><code className="break-all">{procedure.sessionId}</code></div>}
      {procedure.score !== null && <div><div className="text-xs text-muted">Recall score</div><span>{procedure.score.toFixed(2)}</span></div>}
    </div>}
    {!events.length ? <Empty>Saved and recalled procedures will appear here as SurrealDB responds. For the example, finish the first run and wait for “saved verified procedure” before starting the second.</Empty>
      : <ol className="selectable divide-y divide-line" aria-label="SurrealDB activity">{events.map((e, i) => <li key={`${e.at}-${i}`} className="flex items-start gap-3 px-4 py-3">
        <span className="w-16 shrink-0 text-right font-mono text-xs text-muted">+{ms(e.at - (run?.createdAt ?? e.at))}</span>
        <div className="min-w-0 flex-1"><Badge className={/failed|stale/.test(e.action) ? 'bg-rose-950 text-rose-300' : e.action === 'saving' ? 'bg-indigo-950 text-indigo-300' : 'bg-emerald-950 text-emerald-300'}>{e.action.replaceAll('_', ' ')}</Badge><p className="mt-1 break-words text-sm text-fg">{e.message}</p></div>
      </li>)}</ol>}
  </Panel>;
}

function TracePanel({ run, diagnostics }: { run?: RunUi; diagnostics: Diagnostics | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run || isTerminal(run.state)) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [run?.runId, run?.state]);
  const rows = run ? timelineEvidence(run, now) : [];
  const extent = Math.max(1, ...rows.map((row) => row.end - (run?.createdAt ?? row.start)));
  const stats = diagnostics?.telemetry.exportStats;
  return <Panel title="Arize AX · tracing" actions={<a className={external} href="https://app.arize.com" target="_blank" rel="noreferrer">Open Arize ↗</a>}>
    <div className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge>{diagnostics?.telemetry.arize ? 'Export enabled' : diagnostics ? 'Export not configured' : 'Checking export…'}</Badge>
        <span className="text-muted">Project <span className="text-fg">{diagnostics?.telemetry.projectName ?? 'commandos'}</span></span>
        {stats && <span className="text-muted">Runtime totals: {stats.spans} spans accepted · {stats.failures} export failures</span>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted">Trace ID</span><code className="selectable break-all text-sm">{run?.traceId ?? 'No trace in the selected run'}</code>
        {run?.traceId && <Copy value={run.traceId} label="Copy trace ID" />}
      </div>
      <p className="text-xs text-muted">Search this trace ID in Arize. The timeline below uses this run’s local task and model events; export totals cover the runtime and do not confirm this particular trace is visible in Arize.</p>
    </div>
    <div className="border-t border-line px-4 py-3">
      <div className="mb-3 flex items-center justify-between text-xs text-muted"><span>Run timeline · tools and model calls</span><span>0 → {ms(extent)}</span></div>
      {!rows.length ? <Empty>Start a command to see its execution timeline.</Empty> : <ol className="space-y-2" aria-label="Run timeline">{rows.map((row) => <li key={row.id} className="grid grid-cols-[minmax(130px,230px)_minmax(100px,1fr)_70px] items-center gap-3 text-xs">
        <div className="min-w-0"><div className="truncate text-fg" title={row.label}>{row.label}</div><div className="truncate text-muted">{row.tool}</div></div>
        <div className="relative h-5 rounded bg-white/4" aria-label={`${row.kind}: ${row.label}, ${ms(row.end - row.start)}, ${row.state}`}>
          <div className={cx('absolute top-1 h-3 min-w-1 rounded-sm', row.state === 'failed' ? 'bg-rose-400/70' : row.state === 'cancelled' ? 'bg-zinc-500/60' : row.kind === 'model' ? 'bg-violet-400/70' : 'bg-indigo-400/70')} style={{ left: `${Math.max(0, (row.start - run!.createdAt) / extent * 100)}%`, width: `${Math.min(100, Math.max(0.3, (row.end - row.start) / extent * 100))}%` }} />
        </div><span className="text-right tabular-nums text-muted">{ms(row.end - row.start)}</span>
      </li>)}</ol>}
    </div>
  </Panel>;
}

function OtherPanel({ run }: { run?: RunUi }) {
  const voice = useUi((s) => s.voice);
  const sandboxes = run?.order.map((id) => run.tasks[id]).filter((task) => task?.view.tool.startsWith('sandbox.')) ?? [];
  return <div className="grid gap-3 lg:grid-cols-2">
    <Panel title="ElevenLabs · voice"><div className="space-y-2 p-4 text-sm"><Badge>{voice.state}</Badge><p className="selectable">{voice.partial || voice.transcripts.at(-1)?.text || 'Press Control + Option + Space and speak a command.'}</p><p className="text-xs text-muted">{run?.source === 'voice' ? 'The selected run started from a voice command.' : 'Live microphone activity is shown here. The selected run did not start from voice.'}</p></div></Panel>
    <Panel title="OpenAI · model calls"><div className="p-4 text-sm">{!run?.modelCalls.length ? <p className="text-muted">No model calls recorded in this run. Recognized commands can execute directly.</p> : <ul className="space-y-2">{run.modelCalls.map((call, i) => <li key={i} className="flex justify-between gap-3"><span>{call.model} · {call.purpose}</span><span className="shrink-0 text-muted">{ms(call.latencyMs)}</span></li>)}</ul>}</div></Panel>
    <Panel title="Daytona · sandbox activity"><div className="p-4 text-sm">{!sandboxes.length ? <p className="text-muted">This task does not use Daytona. Sandbox steps appear when a command needs isolated execution.</p> : <ul className="space-y-2">{sandboxes.map((task) => task && <li key={task.view.id}><div className="flex justify-between gap-3"><span>{task.view.title}</span><span className={TASK_STATE_STYLE[task.state].text}>{TASK_STATE_STYLE[task.state].label}</span></div>{str(record(task.output).sandboxId) && <code className="selectable break-all text-xs text-muted">{str(record(task.output).sandboxId)}</code>}</li>)}</ul>}</div></Panel>
  </div>;
}

export function IntegrationSummary({ run, onOpen }: { run: RunUi; onOpen: () => void }) {
  const sessions = browserEvidence(run);
  const memory = memoryEvidence(run);
  return <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs text-muted">
    <span>Integrations in this run</span>
    {sessions.length > 0 && <Badge>Anchor · {sessions.at(-1)?.state}</Badge>}
    {memory.length > 0 && <Badge>SurrealDB · {memory.at(-1)?.action.replaceAll('_', ' ')}</Badge>}
    {run.traceId && <Badge>Run trace available</Badge>}
    {run.modelCalls.length > 0 && <Badge>OpenAI · {run.modelCalls.length} calls</Badge>}
    <Button size="sm" variant="ghost" className="ml-auto" onClick={onOpen}>View integrations →</Button>
  </div>;
}

export function IntegrationsView({ onDraft }: { onDraft: (text: string) => void }) {
  const run = useUi((s) => s.selectedRunId ? s.runs[s.selectedRunId] : undefined);
  const [section, setSection] = useState<Section>('anchor');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  useEffect(() => {
    let current = true;
    const load = () => void invoke('diagnostics.get', {}).then((value) => { if (current) setDiagnostics(value); }, () => {});
    load();
    const timer = setInterval(load, 4000);
    return () => { current = false; clearInterval(timer); };
  }, []);
  return <div className="space-y-4">
    <div><h1 className="text-lg font-semibold">Integration activity</h1><p className="mt-1 text-sm text-muted">{run ? 'Live activity and recorded evidence for the selected run.' : 'Run a command to watch its tools work and inspect the evidence afterward.'}</p></div>
    {run && <div className="selectable truncate text-sm text-fg" title={run.command}>“{run.command}”</div>}
    <nav className="flex flex-wrap gap-2" aria-label="Integration details">{([['anchor', 'Anchor Browser'], ['memory', 'SurrealDB memory'], ['arize', 'Arize trace'], ['other', 'Voice & other tools']] as const).map(([id, label]) => <Button key={id} size="sm" variant={section === id ? 'primary' : 'ghost'} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</Button>)}</nav>
    {section === 'anchor' && <AnchorPanel run={run} onDraft={onDraft} />}
    {section === 'memory' && <MemoryPanel run={run} onDraft={onDraft} />}
    {section === 'arize' && <TracePanel run={run} diagnostics={diagnostics} />}
    {section === 'other' && <OtherPanel run={run} />}
  </div>;
}
