import { z } from 'zod';
import { defineTool } from './types';

function num(v: unknown): number {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : Number.NaN;
}

function cell(row: Record<string, unknown>, field: string): unknown {
  if (field in row) return row[field];
  const key = Object.keys(row).find((k) => k.toLowerCase() === field.toLowerCase());
  return key ? row[key] : undefined;
}

const Cond = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(['eq', 'neq', 'contains', 'lt', 'lte', 'gt', 'gte']),
  value: z.string().max(500),
});

export function matches(row: Record<string, unknown>, c: z.infer<typeof Cond>): boolean {
  const v = cell(row, c.field);
  const s = String(v ?? '').trim().toLowerCase();
  const target = c.value.trim().toLowerCase();
  switch (c.op) {
    case 'eq':
      return s === target;
    case 'neq':
      return s !== target;
    case 'contains':
      return s.includes(target);
    case 'lt':
      return num(v) < num(c.value);
    case 'lte':
      return num(v) <= num(c.value);
    case 'gt':
      return num(v) > num(c.value);
    case 'gte':
      return num(v) >= num(c.value);
  }
}

export const dataSelect = defineTool({
  id: 'data.select',
  title: 'Select rows',
  description:
    'Filter, sort and pick rows from a table (an array of objects such as web.extract tables[0].rows). Numeric comparisons and sorting understand values like "$48.00". Deterministic; no model call.',
  tier: 1,
  args: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).max(5000),
    where: z.array(Cond).max(10).default([]),
    orderBy: z.object({ field: z.string().min(1), direction: z.enum(['asc', 'desc']).default('asc'), numeric: z.boolean().default(true) }).optional(),
    limit: z.number().int().min(1).max(1000).default(1),
  }),
  output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), matched: z.number().int() }),
  effectClass: 'read',
  effects: [],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 5_000,
  async run(a) {
    let rows = a.rows.filter((r) => a.where.every((c) => matches(r, c)));
    const matched = rows.length;
    if (a.orderBy) {
      const { field, direction, numeric } = a.orderBy;
      const dir = direction === 'desc' ? -1 : 1;
      rows = [...rows].sort((x, y) => {
        const vx = cell(x, field);
        const vy = cell(y, field);
        return numeric ? (num(vx) - num(vy)) * dir : String(vx).localeCompare(String(vy)) * dir;
      });
    }
    return { rows: rows.slice(0, a.limit), matched };
  },
});

export const dataTools = [dataSelect];
