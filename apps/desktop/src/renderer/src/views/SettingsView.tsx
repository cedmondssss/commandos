import type { CredentialKey, CredentialStatus, Settings } from '@commandos/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Empty, Panel } from '../components/ui';
import { invoke } from '../lib/api';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function CredentialRow({ c, onChange }: { c: CredentialStatus; onChange: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke('credentials.set', { key: c.key, value });
      setValue('');
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke('credentials.delete', { key: c.key as CredentialKey });
      onChange();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const sourceStyle = c.access === 'unavailable' ? 'bg-amber-950 text-amber-200' : c.source === 'keychain' ? 'bg-emerald-950 text-emerald-300' : c.source === 'env' ? 'bg-sky-950 text-sky-300' : 'bg-zinc-800 text-zinc-400';
  return (
    <div className="grid grid-cols-[220px_110px_minmax(0,1fr)_auto] items-center gap-3 border-t border-line px-4 py-2">
      <div>
        <div className="text-[12.5px] text-fg">{c.label}</div>
        <div className="font-mono text-[10.5px] text-muted">{c.key}</div>
      </div>
      <Badge className={sourceStyle}>{c.access === 'unavailable' ? 'access unavailable' : c.access === 'saved' ? 'saved (keychain)' : c.source === 'missing' ? (c.required ? 'missing' : 'not set') : `set (${c.source})`}</Badge>
      <input
        type={c.secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={c.source === 'missing' ? 'paste value…' : 'replace value…'}
        className="selectable h-8 rounded-lg border border-line bg-black/30 px-2 text-[12.5px] outline-none focus:border-accent"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" disabled={!value.trim() || busy} onClick={() => void save()}>
          Save to Keychain
        </Button>
        {c.source === 'keychain' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </div>
      {err && <p className="col-span-4 text-[12px] text-rose-300">{err}</p>}
    </div>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [creds, setCreds] = useState<CredentialStatus[]>([]);
  const [rootsText, setRootsText] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const load = useCallback(() => {
    void invoke('settings.get', {}).then((s) => {
      setSettings(s);
      setRootsText(s.allowedRoots.join('\n'));
    });
    void invoke('credentials.status', {}).then((r) => setCreds(r.credentials));
  }, []);
  useEffect(load, [load]);
  if (!settings) return <Empty>Loading…</Empty>;

  const save = async (patch: Partial<Settings>) => {
    try {
      const next = await invoke('settings.update', patch);
      setSettings(next);
      setSaved('Saved');
      setTimeout(() => setSaved(null), 1500);
    } catch (e) {
      setSaved((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Panel title="API credentials" actions={<span className="text-[11px] text-muted">stored in the macOS Keychain · never shown again · env is the fallback</span>}>
        <p className="px-4 py-3 text-xs leading-relaxed text-muted">Credential checks run without macOS password dialogs. “Saved” means a Keychain entry exists; access is checked when needed. If Keychain access is unavailable, development environment credentials are used when configured.</p>
        {creds.map((c) => (
          <CredentialRow key={c.key} c={c} onChange={load} />
        ))}
      </Panel>

      <Panel title="Models (OpenAI)" actions={saved && <span className="text-[12px] text-emerald-300">{saved}</span>}>
        <div className="grid grid-cols-3 gap-4 p-4">
          {(['fast', 'main', 'deep'] as const).map((tier) => (
            <div key={tier} className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-muted">{tier === 'fast' ? 'Fast · router, simple plans' : tier === 'main' ? 'Main · planner' : 'Deep · risky plans, recovery'}</div>
              <input
                defaultValue={settings.models[tier]}
                onBlur={(e) => void save({ models: { ...settings.models, [tier]: e.target.value.trim() || settings.models[tier] } })}
                className="selectable h-8 w-full rounded-lg border border-line bg-black/30 px-2 font-mono text-[12px] outline-none focus:border-accent"
              />
              <select
                value={settings.efforts[tier]}
                onChange={(e) => void save({ efforts: { ...settings.efforts, [tier]: e.target.value as Settings['efforts']['fast'] } })}
                className="h-8 w-full rounded-lg border border-line bg-black/30 px-2 text-[12px]"
              >
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    reasoning: {x}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <span className="text-[11px] uppercase tracking-wider text-muted">Processing</span>
          <select
            value={settings.serviceTier}
            onChange={(e) => void save({ serviceTier: e.target.value as Settings['serviceTier'] })}
            className="h-8 rounded-lg border border-line bg-black/30 px-2 text-[12px]"
          >
            <option value="fast">Fast mode: lower latency, about 2× token price</option>
            <option value="default">Standard: list price, slower</option>
          </select>
        </div>
      </Panel>

      <Panel title="You">
        <div className="flex items-center gap-3 p-4 text-[12.5px]">
          <span className="text-[11px] uppercase tracking-wider text-muted">Your email</span>
          <input
            type="email"
            defaultValue={settings.userEmail ?? ''}
            placeholder="read from Gmail in Chrome when empty"
            onBlur={(e) => void save({ userEmail: e.target.value.trim() || null })}
            className="selectable h-8 w-80 rounded-lg border border-line bg-black/30 px-2 font-mono text-[12px] outline-none focus:border-accent"
          />
          <span className="text-[11px] text-muted">used for “email myself”</span>
        </div>
        <label className="flex items-center gap-2 px-4 pb-4 text-[12.5px]">
          <input type="checkbox" checked={settings.confirmSelfEmail} onChange={(e) => void save({ confirmSelfEmail: e.target.checked })} className="accent-indigo-500" />
          Ask before emailing myself <span className="text-[11px] text-muted">(emails to anyone else always ask)</span>
        </label>
      </Panel>

      <Panel title="Permissions & safety">
        <div className="grid grid-cols-2 gap-4 p-4 text-[12.5px]">
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wider text-muted">Folders CommandOS may change (one per line)</div>
            <textarea
              value={rootsText}
              onChange={(e) => setRootsText(e.target.value)}
              rows={6}
              className="selectable w-full rounded-lg border border-line bg-black/30 p-2 font-mono text-[12px] outline-none focus:border-accent"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void save({ allowedRoots: rootsText.split('\n').map((s) => s.trim()).filter(Boolean) })}
            >
              Save folders
            </Button>
            <p className="text-[11.5px] text-muted">Always blocked: {settings.deniedPaths.slice(0, 5).join(', ')}…</p>
          </div>
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3">
              <span>Send extracted text (OCR, documents) to OpenAI</span>
              <select value={settings.contentToModel} onChange={(e) => void save({ contentToModel: e.target.value as Settings['contentToModel'] })} className="h-8 rounded-lg border border-line bg-black/30 px-2">
                <option value="allow">allow</option>
                <option value="ask">ask each time</option>
                <option value="deny">never</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>Send images / screenshots to OpenAI (vision)</span>
              <select value={settings.imagesToModel} onChange={(e) => void save({ imagesToModel: e.target.value as Settings['imagesToModel'] })} className="h-8 rounded-lg border border-line bg-black/30 px-2">
                <option value="allow">allow</option>
                <option value="ask">ask each time</option>
                <option value="deny">never</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>Auto-approve reversible changes up to N items</span>
              <input
                type="number"
                min={0}
                max={1000}
                defaultValue={settings.autoApproveReversibleMax}
                onBlur={(e) => void save({ autoApproveReversibleMax: Number(e.target.value) })}
                className="h-8 w-20 rounded-lg border border-line bg-black/30 px-2"
              />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>Parallel tasks</span>
              <input type="number" min={1} max={32} defaultValue={settings.maxConcurrency} onBlur={(e) => void save({ maxConcurrency: Number(e.target.value) })} className="h-8 w-20 rounded-lg border border-line bg-black/30 px-2" />
            </label>
            <p className="text-[11.5px] text-muted">Deletions, sends, submissions, payments, privileged commands and anything irreversible always ask first.</p>
          </div>
        </div>
      </Panel>

      <Panel title="Voice (ElevenLabs)">
        <div className="grid grid-cols-3 gap-4 p-4 text-[12.5px]">
          <label className="space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-muted">End of utterance</div>
            <select
              value={settings.voice.commitStrategy}
              onChange={(e) => void save({ voice: { ...settings.voice, commitStrategy: e.target.value as 'vad' | 'manual' } })}
              className="h-8 w-full rounded-lg border border-line bg-black/30 px-2"
            >
              <option value="vad">automatic (voice activity)</option>
              <option value="manual">when I press stop</option>
            </select>
          </label>
          <label className="space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-muted">Silence before commit (s)</div>
            <input
              type="number"
              step={0.1}
              min={0.3}
              max={3}
              defaultValue={settings.voice.vadSilenceSecs}
              onBlur={(e) => void save({ voice: { ...settings.voice, vadSilenceSecs: Number(e.target.value) } })}
              className="h-8 w-full rounded-lg border border-line bg-black/30 px-2"
            />
          </label>
          <label className="flex items-center gap-2 pt-5">
            <input type="checkbox" checked={settings.voice.speakResults} onChange={(e) => void save({ voice: { ...settings.voice, speakResults: e.target.checked } })} />
            Speak verified results aloud
          </label>
        </div>
      </Panel>
    </div>
  );
}
