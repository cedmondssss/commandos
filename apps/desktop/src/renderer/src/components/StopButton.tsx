import { useState } from 'react';
import { invoke } from '../lib/api';
import { Button } from './ui';

export function StopButton({ all = false }: { all?: boolean }) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setStopping(true);
    setError(null);
    try { await invoke('emergency.stop', {}); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setStopping(false); }
  };
  return (
    <span className="no-drag inline-flex items-center gap-2">
      {error ? <span role="alert" className="max-w-48 text-xs text-rose-300">{error}</span> : null}
      <Button size="sm" variant="danger" title="Emergency stop (⌃⌥Esc)" disabled={stopping} onClick={() => void stop()}>
        {stopping ? 'Stopping…' : all ? '■ Stop all' : '■ Stop'}
      </Button>
    </span>
  );
}
