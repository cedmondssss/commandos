import type { ActionExplanation } from '@commandos/contracts';

export function ActionDetails({ explanation, compact = false }: { explanation: ActionExplanation; compact?: boolean }) {
  const rows = [
    ['What happens', explanation.what],
    ['Permission', explanation.permission],
    ['Destination / affected items', explanation.targets.length ? explanation.targets.join('\n') : 'See the exact arguments for this step.'],
    ['Data sharing', explanation.dataFlow],
    ['Undo', explanation.undo],
  ];
  return <dl className={`grid min-w-0 gap-3 ${compact ? 'text-[11.5px]' : 'grid-cols-2 text-[12.5px]'}`} aria-label="Action explanation">
    {rows.map(([label, value], index) => <div key={label} className={`min-w-0 ${!compact && index < 3 ? 'col-span-2' : ''}`}>
      <dt className="font-medium text-muted">{label}</dt>
      <dd className={`mt-0.5 whitespace-pre-wrap break-words text-fg/90 ${index === 2 ? 'max-h-24 overflow-y-auto' : ''}`}>{value}</dd>
    </div>)}
  </dl>;
}
