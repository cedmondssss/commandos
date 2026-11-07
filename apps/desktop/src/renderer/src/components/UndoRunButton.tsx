import { useState } from 'react';
import { invoke } from '../lib/api';
import { isTerminal, type RunUi } from '../lib/store';
import { Button } from './ui';

/** Shared by the dashboard and floating bar so undo is discoverable in both. */
export function UndoRunButton({ run, onMessage }: { run: RunUi; onMessage?: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reversible = run.metrics.undo_operations !== undefined ? run.metrics.undo_operations > 0
    : Object.values(run.tasks).some((task) => task.state === 'succeeded' && (task.policy?.effectClass ?? task.view.effectClass) === 'reversible_local');
  if (!isTerminal(run.state) || !reversible || run.state === 'undone' || run.dryRun) return null;

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke('run.undo', { runId: run.runId });
      const message = result.ok ? `Undone (${result.steps} steps)` : `Undo incomplete: ${result.failures.join('; ')}`;
      if (onMessage) onMessage(message);
      else if (!result.ok) setError(message);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (onMessage) onMessage(message);
      else setError(message);
    } finally { setBusy(false); }
  };
  return <span className="no-drag inline-flex flex-wrap items-center gap-2">
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()} title="Restore the recorded reversible changes from this run">
      {busy ? 'Undoing…' : '↺ Undo run'}
    </Button>
    {error && <span role="alert" className="text-xs text-rose-300">{error}</span>}
  </span>;
}
