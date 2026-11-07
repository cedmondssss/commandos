import type { Diagnostics, ToolDescriptor } from '@commandos/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EffectBadge, Empty, Mono, Panel } from '../components/ui';
import { invoke, type Res } from '../lib/api';

function Status({ ok, label }: { ok: boolean | null; label?: string }) {
  if (ok === null) return <Badge>unknown</Badge>;
  return <Badge className={ok ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'}>{label ?? (ok ? 'granted' : 'not granted')}</Badge>;
}

export function DiagnosticsView() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [mic, setMic] = useState<Res<'microphone.status'>['status'] | null>(null);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const load = useCallback(() => {
    void invoke('diagnostics.get', {}).then(setDiag);
    void invoke('microphone.status', {}).then((r) => setMic(r.status));
    void invoke('tools.list', {}).then((r) => setTools(r.tools));
  }, []);
  useEffect(load, [load]);
  if (!diag) return <Empty>Loading…</Empty>;
  const p = diag.permissions;

  const request = async (kind: 'accessibility' | 'screenRecording') => {
    await invoke('permissions.request', { kind });
    await invoke('system.openSettings', { pane: kind });
    setTimeout(load, 1500);
  };

  return (
    <div className="space-y-4">
      <Panel title="macOS permissions" actions={<Button size="sm" variant="ghost" onClick={load}>Re-check</Button>}>
        <div className="divide-y divide-line text-[12.5px]">
          {(
            [
              ['Accessibility (control other apps)', p?.accessibility ?? null, () => void request('accessibility')],
              ['Screen Recording (capture windows for vision fallback)', p?.screenRecording ?? null, () => void request('screenRecording')],
              ['Microphone (voice commands)', mic === null ? null : mic === 'granted', () => void invoke('microphone.request', {}).then(load)],
            ] as const
          ).map(([label, ok, fix]) => (
            <div key={label} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex-1">{label}</span>
              <Status ok={ok} />
              {!ok && (
                <Button size="sm" variant="ghost" onClick={fix}>
                  Grant…
                </Button>
              )}
            </div>
          ))}
          <p className="px-4 py-2.5 text-[11.5px] text-muted">
            In development, macOS attributes these permissions to the app that launched CommandOS (Electron, Terminal or your editor).
          </p>
        </div>
      </Panel>

      <Panel title="Native helper & telemetry">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 p-4 text-[12.5px]">
          <span className="text-muted">Swift helper</span>
          <span>
            <Status ok={diag.helper.running} label={diag.helper.running ? `running v${diag.helper.version ?? '?'}` : 'offline'} />
            {diag.helper.error && <span className="ml-2 text-rose-300">{diag.helper.error}</span>}
          </span>
          <span className="text-muted">Helper binary</span>
          <Mono className="selectable truncate text-zinc-400">{diag.helper.path}</Mono>
          <span className="text-muted">Arize AX export</span>
          <span>
            <Status ok={diag.telemetry.arize} label={diag.telemetry.arize ? 'enabled' : 'not configured'} />
          </span>
          <span className="text-muted">Local trace file</span>
          <Mono className="selectable truncate text-zinc-400">{diag.telemetry.localTraceFile ?? '—'}</Mono>
          <span className="text-muted">Data folder</span>
          <Mono className="selectable truncate text-zinc-400">{diag.dataDir}</Mono>
        </div>
      </Panel>

      <Panel title="Provider verification (live calls, from pnpm verify:providers)">
        {!diag.verification ? (
          <Empty>No verification report yet. Run `pnpm verify:providers` to make live calls to every provider.</Empty>
        ) : (
          <table className="w-full text-[12.5px]">
            <tbody>
              {diag.verification.results.map((r) => (
                <tr key={r.provider} className="border-t border-line align-top">
                  <td className="px-4 py-2 font-medium">{r.provider}</td>
                  <td className="px-2 py-2">
                    <Badge
                      className={
                        r.status === 'verified'
                          ? 'bg-emerald-950 text-emerald-300'
                          : r.status === 'blocked'
                            ? 'bg-amber-950 text-amber-300'
                            : r.status === 'failed'
                              ? 'bg-rose-950 text-rose-300'
                              : ''
                      }
                    >
                      {r.status}
                    </Badge>
                  </td>
                  <td className="selectable px-2 py-2 text-muted">{r.detail}</td>
                  <td className="px-4 py-2 text-right text-[11px] text-muted">{new Date(r.checkedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Tool catalog (${tools.length})`}>
        <table className="w-full text-[12px]">
          <tbody>
            {tools.map((t) => (
              <tr key={t.id} className="border-t border-line">
                <td className="px-4 py-1.5 font-mono text-zinc-300">{t.id}</td>
                <td className="px-2 py-1.5">
                  <Badge>tier {t.tier}</Badge>
                </td>
                <td className="px-2 py-1.5">
                  <EffectBadge effectClass={t.effectClass} />
                </td>
                <td className="px-4 py-1.5 text-muted">{t.title}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
