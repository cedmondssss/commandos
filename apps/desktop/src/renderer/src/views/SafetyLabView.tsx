import { safetyScore, type SafetyCase, type SafetyReport } from '@commandos/contracts';
import { useEffect, useState } from 'react';
import { Badge, Button, cx, Panel } from '../components/ui';
import { invoke } from '../lib/api';

const tone: Record<SafetyCase['status'], string> = {
  passed: 'bg-emerald-950 text-emerald-300', failed: 'bg-rose-950 text-rose-300',
  error: 'bg-amber-950 text-amber-200', cancelled: 'bg-white/8 text-muted',
};

function Score({ title, cases, category }: { title: string; cases: SafetyCase[]; category?: SafetyCase['category'] }) {
  const score = safetyScore(cases, category);
  return <div className="rounded-xl border border-line bg-panel p-4">
    <p className="text-xs text-muted">{title}</p>
    <p className="mt-2 text-2xl font-semibold text-fg">{score.passed}<span className="text-base text-muted"> / {score.total}</span></p>
    <p className="mt-1 text-xs text-muted">{score.percent === null ? 'No evidence yet' : `${score.percent}% passed`}</p>
  </div>;
}

export function SafetyLabView() {
  const [report, setReport] = useState<SafetyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        // Read status first so a completed run's persisted report cannot race this refresh.
        const status = await invoke('safety.status', {});
        const saved = await invoke('safety.report', {});
        if (!current) return;
        setReport(saved); setBusy(status.running);
        if (status.running) timer = setTimeout(() => void refresh(), 750);
      } catch (e) { if (current) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (current) setLoading(false); }
    };
    void refresh();
    return () => { current = false; clearTimeout(timer); };
  }, []);

  const run = async () => {
    setBusy(true); setError(null); setCopied(false);
    try { setReport(await invoke('safety.run', {})); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    try { await invoke('safety.cancel', {}); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopied(true); }
    catch { setError('Could not copy the report. Saved evidence is also available in the app data folder under safety/latest.json.'); }
  };
  const results = report?.cases ?? [];
  return <div className="mx-auto max-w-5xl space-y-5 pb-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-wider text-indigo-300">Responsible agent evaluation</p>
        <h1 className="mt-1 text-2xl font-semibold text-fg">Safety Lab</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">Can CommandOS respect boundaries and still complete useful work? Run ten controlled scenarios against its execution engine and inspect the evidence.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {report && <Button variant="ghost" disabled={busy} onClick={() => void copy()}>{copied ? 'Copied JSON' : 'Copy evidence JSON'}</Button>}
        {busy && <Button variant="danger" onClick={() => void cancel()}>Cancel evaluations</Button>}
        <Button disabled={busy || loading} onClick={() => void run()}>{busy ? 'Evaluating…' : report ? 'Run again' : 'Run evaluations'}</Button>
      </div>
    </div>
    <div className="rounded-xl border border-indigo-500/25 bg-indigo-950/20 p-4 text-sm leading-relaxed text-fg/85">
      <p className="font-medium">Real execution engine · scripted proposals · no model calls</p>
      <p className="mt-1 text-muted">Uses disposable files and a separate local Chromium. Approval responses are scripted; native app actions and cloud providers are disabled. Your files, browser sessions, credentials and settings are not used.</p>
    </div>
    {error && <p role="alert" className="rounded-xl border border-rose-800 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
    <div role="status" aria-live="polite" className="text-xs text-muted">
      {busy ? 'Running a new evaluation. The previous report below remains historical until the new run finishes.' : loading ? 'Loading saved evidence…' : report ? `Saved run: ${new Date(report.finishedAt).toLocaleString()} · ${(report.durationMs / 1000).toFixed(1)} s · ${report.id}` : 'No evaluations have been run yet. Results will appear after an actual run.'}
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Evaluation scorecard">
      <Score title="All scenarios" cases={results} />
      <Score title="Boundary checks" cases={results} category="boundary" />
      <Score title="Useful work completed" cases={results} category="usefulness" />
      <Score title="Recovery" cases={results} category="recovery" />
    </div>
    {report ? <>
      <Panel title="Scenario results">
        <div className="divide-y divide-line">
          {results.map((result) => <details key={result.id} className="group px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center gap-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
              <Badge className={tone[result.status]}>{result.status}</Badge>
              <span className="min-w-0 flex-1 text-sm font-medium text-fg">{result.title}<span className="mt-0.5 block text-xs font-normal text-muted">{result.category} · {result.method}</span></span>
              <span className="shrink-0 text-xs text-muted">{result.durationMs} ms <span className="ml-2 group-open:hidden">＋</span></span>
            </summary>
            <div className="mt-4 space-y-3 text-[12.5px]">
              <dl className="space-y-2"><div><dt className="font-medium text-muted">Expected</dt><dd className="mt-1 text-fg">{result.expected}</dd></div><div><dt className="font-medium text-muted">Observed</dt><dd className="mt-1 break-words text-fg">{result.observed}</dd></div></dl>
              <ul className="space-y-1" aria-label={`${result.title} checks`}>{result.checks.map((item) => <li key={item.label} className={cx('rounded-lg bg-black/15 px-3 py-2', item.ok ? 'text-emerald-300' : 'text-rose-300')}>
                {item.ok ? '✓' : '✗'} {item.label}<p className="mt-1 break-words text-xs text-muted">{item.detail}</p>
              </li>)}</ul>
              <div><p className="mb-1 font-medium text-muted">Recorded execution evidence</p><pre className="selectable max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/25 p-3 text-[11.5px] text-zinc-300">{result.evidence.join('\n') || 'No task events recorded.'}</pre></div>
            </div>
          </details>)}
        </div>
      </Panel>
      <Panel title="Method and limits">
        <div className="space-y-3 p-4 text-xs leading-relaxed text-muted">
          <p>{report.methodology}</p><p>{report.environment} · suite {report.suiteVersion}</p>
          <ul className="list-disc space-y-1 pl-4">{report.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul>
          <p>Failed, cancelled and errored cases remain in the score denominator. These results apply to this suite and environment.</p>
        </div>
      </Panel>
    </> : !loading && <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">Run evaluations to generate the scorecard. No scores are prefilled.</div>}
  </div>;
}
