import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle' | 'ok';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:brightness-110',
  ghost: 'bg-transparent text-fg hover:bg-white/8 border border-line',
  danger: 'bg-rose-600 text-white hover:bg-rose-500',
  subtle: 'bg-white/6 text-fg hover:bg-white/10',
  ok: 'bg-emerald-600 text-white hover:bg-emerald-500',
};

export function Button({
  variant = 'subtle',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap', className ?? 'bg-white/8 text-muted')}>
      {children}
    </span>
  );
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-line bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-wide text-fg/90">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-24 items-center justify-center p-6 text-center text-sm text-muted">{children}</div>;
}

export function EffectBadge({ effectClass }: { effectClass: string }) {
  const map: Record<string, string> = {
    read: 'bg-sky-950 text-sky-300',
    reversible_local: 'bg-emerald-950 text-emerald-300',
    irreversible_local: 'bg-amber-950 text-amber-300',
    external: 'bg-rose-950 text-rose-300',
  };
  const label: Record<string, string> = {
    read: 'read-only',
    reversible_local: 'reversible',
    irreversible_local: 'irreversible',
    external: 'external',
  };
  return <Badge className={map[effectClass]}>{label[effectClass] ?? effectClass}</Badge>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono text-[12px]', className)}>{children}</span>;
}
