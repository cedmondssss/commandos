import dagre from '@dagrejs/dagre';
import { Background, Controls, type Edge, Handle, MarkerType, type Node, type NodeProps, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useMemo } from 'react';
import { ms, TASK_STATE_STYLE } from '../lib/format';
import type { RunUi, TaskUi } from '../lib/store';
import { cx, EffectBadge } from './ui';

const W = 292;
const H = 104;

type TaskNodeData = { task: TaskUi; step: number };

const TaskNode = memo(function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const t = data.task;
  const style = TASK_STATE_STYLE[t.state];
  const duration = t.startedAt && t.endedAt ? t.endedAt - t.startedAt : undefined;
  return (
    <div className={cx('rounded-xl border border-line bg-panel-2 px-3.5 py-2.5 shadow-lg ring-1', style.ring)} style={{ width: W, height: H }}>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-zinc-500" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Step {String(data.step).padStart(2, '0')}</span>
        <span className={cx('flex items-center gap-1.5 text-[10.5px] font-semibold', style.text)}>
          <span className={cx('h-1.5 w-1.5 rounded-full', style.dot)} />
          {style.label}{t.attempt > 1 ? ` · retry ${t.attempt}` : ''}
        </span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-[13px] font-semibold leading-4 text-fg" title={t.view.title}>
        {t.view.title}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">{t.view.id} · {t.view.tool}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {duration !== undefined && <span className="text-[10px] text-muted">{ms(duration)}</span>}
          <EffectBadge effectClass={t.policy?.effectClass ?? t.view.effectClass} />
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-zinc-500" />
    </div>
  );
});

const nodeTypes = { task: TaskNode };

function layout(run: RunUi): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 48, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of run.order) g.setNode(id, { width: W, height: H });
  const edges: Edge[] = [];
  for (const id of run.order) {
    const t = run.tasks[id];
    if (!t) continue;
    for (const dep of t.view.dependsOn) {
      if (!run.tasks[dep]) continue;
      g.setEdge(dep, id);
      const bound = t.view.bind.some((b) => b.from.startsWith(`${dep}.`));
      const active = run.tasks[dep]?.state === 'succeeded' && (t.state === 'running' || t.state === 'verifying');
      const color = bound ? '#8588ff' : '#727a8d';
      edges.push({
        id: `${dep}->${id}`,
        source: dep,
        target: id,
        animated: active,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
        style: { stroke: color, strokeWidth: bound ? 2.2 : 1.7, strokeDasharray: bound ? undefined : '5 4' },
        label: bound ? 'passes data' : 'depends',
        labelStyle: { fill: bound ? '#b9baff' : '#b4bac8', fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: '#181b23' },
        labelBgPadding: [5, 3],
      });
    }
  }
  dagre.layout(g);
  const nodes: Node<TaskNodeData>[] = run.order.flatMap((id, index) => {
    const t = run.tasks[id];
    const p = g.node(id) as { x: number; y: number } | undefined;
    if (!t || !p) return [];
    return [{ id, type: 'task', position: { x: p.x - W / 2, y: p.y - H / 2 }, data: { task: t, step: index + 1 }, draggable: false, selectable: false }];
  });
  return { nodes, edges };
}

export function DagView({ run }: { run: RunUi }) {
  const { nodes, edges } = useMemo(() => layout(run), [run]);
  const tasks = run.order.map((id) => run.tasks[id]).filter((task): task is TaskUi => Boolean(task));
  const verified = tasks.filter((task) => task.state === 'succeeded').length;
  const active = tasks.filter((task) => ['running', 'verifying'].includes(task.state)).length;
  const approval = tasks.filter((task) => task.state === 'awaiting_approval').length;
  const queued = tasks.filter((task) => ['pending', 'ready'].includes(task.state)).length;
  const blocked = tasks.filter((task) => ['failed', 'denied'].includes(task.state)).length;
  if (!run.order.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {run.state === 'routing' || run.state === 'planning' ? 'Planning…' : 'No tasks'}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[10.5px]" aria-label="Plan progress and connection legend">
        <span className="font-semibold text-fg">{tasks.length} {tasks.length === 1 ? 'step' : 'steps'}</span>
        {verified > 0 && <span className="text-emerald-300">{verified} verified</span>}
        {active > 0 && <span className="text-indigo-300">{active} active</span>}
        {approval > 0 && <span className="text-amber-300">{approval} approval</span>}
        {queued > 0 && <span className="text-muted">{queued} queued</span>}
        {blocked > 0 && <span className="text-rose-300">{blocked} blocked</span>}
        <span className="ml-auto whitespace-nowrap text-muted"><span className="text-indigo-300">━</span> data passed <span className="ml-2 text-zinc-400">┄</span> dependency</span>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          colorMode="dark"
          minZoom={0.3}
        >
          <Background gap={28} size={1} color="#292e3b" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
    </div>
  );
}
