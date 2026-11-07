import { type FormEvent, useEffect, useRef, useState } from 'react';
import { invoke, onPush } from '../lib/api';
import { useVoice } from '../lib/voice';
import { Button, cx } from './ui';

function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const bars = 5;
  const lit = Math.min(bars, Math.round(Math.sqrt(level) * 14));
  return (
    <span className="flex h-4 items-end gap-[2px]">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cx('w-[3px] rounded-sm transition-all', active && i < lit ? 'bg-rose-300' : 'bg-white/25')}
          style={{ height: `${6 + i * 2.5}px` }}
        />
      ))}
    </span>
  );
}

export function CommandInput({
  autoFocus = false,
  large = false,
  listenOnShortcut = false,
  showDryRun = true,
  overlay = false,
  draft,
}: { autoFocus?: boolean; large?: boolean; listenOnShortcut?: boolean; showDryRun?: boolean; overlay?: boolean; draft?: { text: string; key: number } }) {
  const [text, setText] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { voice, listening, toggle } = useVoice();

  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    setError(null);
    input.current?.focus();
  }, [draft]);

  useEffect(() => {
    if (!listenOnShortcut) return;
    return onPush('ui:command', (cmd) => {
      if (cmd.action === 'focus-input') input.current?.focus();
      if (cmd.action === 'toggle-voice') void toggle().catch((e: Error) => setError(e.message));
    });
  }, [listenOnShortcut, toggle]);

  useEffect(() => {
    if (voice.error) setError(voice.error);
  }, [voice.error]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await invoke('command.submit', { text: value, source: 'text', dryRun });
      // the overlay hands keyboard focus back so CommandOS's own keystrokes reach their app
      if (overlay) void invoke('window.releaseBar', {}).catch(() => {});
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const placeholder = listening
    ? voice.partial || (voice.state === 'connecting' ? 'Connecting to ElevenLabs…' : 'Listening… speak your command')
    : 'Tell CommandOS what to do — or press ⌃⌥Space and speak';

  return (
    <div className="w-full">
      <form onSubmit={(e) => void submit(e)} className={cx('no-drag flex items-center gap-2 rounded-2xl border border-line bg-panel-2/90 px-3', large ? 'h-14' : 'h-12')}>
        <button
          type="button"
          title={listening ? 'Stop listening (commits what you said)' : 'Speak a command'}
          onClick={() => void toggle().catch((err: Error) => setError(err.message))}
          className={cx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
            listening ? 'bg-rose-600 text-white shadow-[0_0_0_4px_rgba(244,63,94,.25)]' : 'bg-white/8 text-fg hover:bg-white/14',
          )}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
          </svg>
        </button>
        {listening && <LevelMeter level={voice.level} active={voice.state === 'listening'} />}
        <input
          ref={input}
          autoFocus={autoFocus}
          value={listening ? voice.partial : text}
          readOnly={listening}
          onKeyDown={
            overlay
              ? (e) => {
                  if (e.key === 'Escape') {
                    input.current?.blur();
                    void invoke('window.releaseBar', {}).catch(() => {});
                  }
                }
              : undefined
          }
          onMouseDown={
            overlay
              ? () => {
                  void invoke('window.focusBar', {})
                    .then(() => input.current?.focus())
                    .catch(() => {});
                }
              : undefined
          }
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          className={cx('selectable min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted', large ? 'text-[17px]' : 'text-[15px]')}
          spellCheck={false}
        />
        {showDryRun ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11.5px] text-muted" title="Plan and preview without changing anything">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="accent-indigo-500" />
            dry run
          </label>
        ) : null}
        <Button type="submit" variant="primary" size="sm" disabled={busy || listening || !text.trim()}>
          Run ↵
        </Button>
      </form>
      {error && <p className="mt-1.5 px-1 text-[12px] text-rose-300">{error}</p>}
    </div>
  );
}
