import { useEffect, useMemo, useRef } from 'react';
import { describeEvent, relative } from '../lib/format';
import type { RunUi } from '../lib/store';
import { cx } from './ui';

const TONE: Record<string, string> = {
  muted: 'text-zinc-400',
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  err: 'text-rose-300',
  info: 'text-sky-200',
};

export function ActivityLog({ run }: { run: RunUi }) {
  const end = useRef<HTMLDivElement>(null);
  const lines = useMemo(
    () => run.events.flatMap((e, i) => {
      const d = describeEvent(e);
      return d ? [{ key: `${i}`, at: e.at, ...d }] : [];
    }),
    [run.events],
  );

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);
  return (
    <div className="selectable h-full overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-[1.55]">
      {lines.map((l) => (
        <div key={l.key} className="flex gap-2">
          <span className="w-14 shrink-0 text-right text-zinc-600">{relative(l.at, run.createdAt)}</span>
          <span className={cx('w-3 shrink-0 text-center', TONE[l.tone])}>{l.icon}</span>
          <span className={cx('min-w-0 break-words', TONE[l.tone])}>{l.text}</span>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
