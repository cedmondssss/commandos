import type { RunSummary } from '@commandos/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, cx, Empty, Panel } from '../components/ui';
import { invoke } from '../lib/api';
import { RUN_STATE_STYLE } from '../lib/format';
import { store } from '../lib/store';

export function HistoryView({ onOpen }: { onOpen: () => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    invoke('runs.list', {}).then(
      (r) => setRuns(r.runs),
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(load, [load]);

  const open = async (runId: string) => {
    const snap = await invoke('run.get', { runId });
    store.loadSnapshot(snap);
    onOpen();
  };
  const undo = async (runId: string) => {
    try {
      const r = await invoke('run.undo', { runId });
      setError(r.ok ? null : `Undo incomplete: ${r.failures.join('; ')}`);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  };

  return (
    <Panel title="Run history (audit-backed)" actions={<Button size="sm" variant="ghost" onClick={load}>Refresh</Button>}>
      {error && <p className="px-4 pt-3 text-[12px] text-rose-300">{error}</p>}
      {!runs ? (
        <Empty>Loading…</Empty>
      ) : runs.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="text-left text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-2 py-2">Command</th>
              <th className="px-2 py-2">Mode</th>
              <th className="px-2 py-2">State</th>
              <th className="px-2 py-2">Steps</th>
              <th className="px-2 py-2">Model calls</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId} className="border-t border-line align-top">
                <td className="whitespace-nowrap px-4 py-2 text-muted">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="selectable max-w-md px-2 py-2">
                  <div className="truncate">{r.command}</div>
                  {r.summary && <div className="truncate text-[11.5px] text-muted">{r.summary}</div>}
                </td>
                <td className="px-2 py-2">{r.mode ? <Badge>{r.mode}</Badge> : '—'}</td>
                <td className="px-2 py-2">
                  <span className={cx('rounded px-1.5 py-0.5 text-[11px]', RUN_STATE_STYLE[r.state])}>{r.state}</span>
                </td>
                <td className="px-2 py-2 tabular-nums">
                  {r.succeededCount}/{r.taskCount}
                </td>
                <td className="px-2 py-2 tabular-nums">{r.modelCalls}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => void open(r.runId)}>
                    Open
                  </Button>{' '}
                  {['failed', 'partial', 'stopped', 'cancelled'].includes(r.state) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void invoke('run.resume', { runId: r.runId }).then(
                          () => onOpen(),
                          (e: Error) => setError(e.message),
                        )
                      }
                    >
                      Resume
                    </Button>
                  )}{' '}
                  {r.undoable && (
                    <Button size="sm" variant="ghost" onClick={() => void undo(r.runId)}>
                      Undo
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
