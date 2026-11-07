import type { ApprovalRequest } from '@commandos/contracts';
import { useEffect, useState } from 'react';
import { invoke } from '../lib/api';
import { Badge, Button, cx, EffectBadge } from './ui';
import { ActionDetails } from './ActionDetails';

export function ApprovalCard({ approval, compact = false }: { approval: ApprovalRequest; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, Math.round((approval.expiresAt - now) / 1000));
  const respond = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke('approval.respond', { approvalId: approval.id, decision });
      if (!result.ok) setError('This request is no longer pending.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx('rounded-xl border bg-amber-950/30 p-3', approval.irreversible ? 'border-rose-700/70' : 'border-amber-700/60')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-amber-100">{approval.title}</span>
        <EffectBadge effectClass={approval.effectClass} />
        <Badge className="bg-white/8 text-amber-200">risk: {approval.risk}</Badge>
        {approval.irreversible && <Badge className="bg-rose-900 text-rose-100">cannot be undone</Badge>}
        <span className="ml-auto text-[11px] text-muted">auto-deny in {remaining}s</span>
      </div>
      <div className="mt-2">
        {approval.explanation ? <ActionDetails explanation={approval.explanation} compact={compact} /> : <>
          <p className="text-[12.5px] text-fg/90">{approval.preview.summary}</p>
          <ul className="mt-1 list-inside list-disc text-[12px] text-amber-200/80">
            {approval.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
          <p className="mt-1 text-[12px] text-muted">{approval.irreversible ? 'CommandOS cannot undo this action.' : 'Undo availability depends on the tool; inspect the action before approving.'}</p>
        </>}
      </div>
      {!compact && approval.preview.details.length > 0 && (
        <div className="selectable mt-2 max-h-36 overflow-y-auto rounded-lg bg-black/30 p-2 font-mono text-[11.5px] text-zinc-300">
          {approval.preview.details.map((d, i) => <div key={`${i}-${d}`}>{d}</div>)}
        </div>
      )}
      <details className="mt-2 text-[11.5px] text-muted">
        <summary className="cursor-pointer">Exact arguments and content</summary>
        <pre className="selectable mt-1 max-h-48 overflow-auto rounded-lg bg-black/30 p-2 text-zinc-300">{JSON.stringify(approval.preview.payload, null, 2)}</pre>
      </details>
      {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" variant={approval.irreversible ? 'danger' : 'ok'} disabled={busy || remaining === 0} onClick={() => void respond('approve')}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void respond('deny')}>
          Deny
        </Button>
      </div>
    </div>
  );
}
