import { useState } from 'react';
import { invoke } from '../lib/api';
import { ms, RUN_STATE_STYLE } from '../lib/format';
import { isTerminal, type RunUi } from '../lib/store';
import { Badge, Button, Mono } from './ui';
import { UndoRunButton } from './UndoRunButton';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-20">
      <div className="text-[10.5px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-[14px] font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}

export function RunHeader({ run }: { run: RunUi }) {
  const [msg, setMsg] = useState<string | null>(null);
  const done = isTerminal(run.state);
  const tasks = Object.values(run.tasks);
  const verified = tasks.filter((t) => t.state === 'succeeded').length;
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={RUN_STATE_STYLE[run.state]}>{run.state}</Badge>
        {run.decision && (
          <>
            <Badge className="bg-indigo-950 text-indigo-200">{run.decision.mode.toUpperCase()}</Badge>
            <Badge>{run.decision.intent}</Badge>
            <Badge>via {run.decision.via}</Badge>
          </>
        )}
        {run.dryRun && <Badge className="bg-sky-950 text-sky-200">dry run</Badge>}
        {run.source === 'voice' && <Badge className="bg-rose-950 text-rose-200">voice</Badge>}
        <span className="ml-auto flex gap-2">
          {!done && (
            <Button size="sm" variant="ghost" onClick={() => void invoke('run.cancel', { runId: run.runId })}>
              Cancel
            </Button>
          )}
          {done && ['failed', 'partial', 'stopped', 'cancelled'].includes(run.state) && (
            <Button
              size="sm"
              variant="ghost"
              title="Restore verified steps from checkpoints and re-run the rest"
              onClick={() =>
                void invoke('run.resume', { runId: run.runId }).then(
                  (r) => setMsg(`Resumed as ${r.runId}`),
                  (e: Error) => setMsg(e.message),
                )
              }
            >
              ⟳ Resume
            </Button>
          )}
          <UndoRunButton key={run.runId} run={run} onMessage={setMsg} />
        </span>
      </div>
      <p className="selectable mt-2 text-[15px] font-medium text-fg">“{run.command}”</p>
      {run.summary && <p className="selectable mt-1 text-[13px] text-muted">{run.summary}</p>}
      {msg && <p className="mt-1 text-[12px] text-amber-200">{msg}</p>}
      <div className="mt-3 flex flex-wrap gap-6">
        <Stat label="first action" value={ms(run.metrics.time_to_first_action)} />
        <Stat label="router" value={ms(run.routeLatencyMs)} />
        <Stat label="total" value={ms(run.metrics.total_duration ?? (done ? undefined : Date.now() - run.createdAt))} />
        <Stat label="model calls" value={String(run.modelCalls.length)} />
        <Stat label="verified steps" value={`${verified}/${tasks.length}`} />
        {run.metrics.speech_to_transcript !== undefined && <Stat label="speech → text" value={ms(run.metrics.speech_to_transcript)} />}
      </div>
      {run.traceId && (
        <div className="mt-2 text-[11px] text-muted">
          trace <Mono className="selectable text-zinc-400">{run.traceId}</Mono>
        </div>
      )}
    </div>
  );
}
