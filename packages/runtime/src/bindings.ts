import type { Binding, TaskSpec } from '@commandos/contracts';
import { z } from 'zod';

type Segment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'all' };

/** Parses `a.b[0].c[*].d` (leading dot optional) into segments. */
export function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  const re = /\.?([A-Za-z_$][\w$-]*)|\[(\d+|\*)\]|\.(\d+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: tokenizer loop
  while ((m = re.exec(path)) !== null) {
    if (m.index !== consumed) throw new Error(`invalid path "${path}"`);
    consumed = re.lastIndex;
    if (m[1] !== undefined) segments.push({ kind: 'key', key: m[1] });
    else if (m[2] === '*') segments.push({ kind: 'all' });
    else if (m[2] !== undefined) segments.push({ kind: 'index', index: Number(m[2]) });
    else if (m[3] !== undefined) segments.push({ kind: 'index', index: Number(m[3]) });
  }
  if (consumed !== path.length) throw new Error(`invalid path "${path}"`);
  return segments;
}

/** Reads a path; `[*]` maps the rest of the path over an array. Missing values yield undefined. */
export function getPath(value: unknown, path: string): unknown {
  const segments = path ? parsePath(path) : [];
  const walk = (v: unknown, i: number): unknown => {
    if (i >= segments.length) return v;
    const seg = segments[i] as Segment;
    if (seg.kind === 'all') {
      if (!Array.isArray(v)) return undefined;
      return v.map((item) => walk(item, i + 1));
    }
    if (v === null || v === undefined) return undefined;
    if (seg.kind === 'index') return Array.isArray(v) ? walk(v[seg.index], i + 1) : undefined;
    if (typeof v !== 'object') return seg.key === 'length' && typeof v === 'string' ? (v as string).length : undefined;
    if (seg.key === 'length' && Array.isArray(v)) return v.length;
    return walk((v as Record<string, unknown>)[seg.key], i + 1);
  };
  return walk(value, 0);
}

/** Writes a dotted path (numeric segments index arrays), creating containers as needed. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const last = i === parts.length - 1;
    const nextIsIndex = !last && /^\d+$/.test(parts[i + 1] as string);
    const key: string | number = /^\d+$/.test(part) ? Number(part) : part;
    const container = cur as Record<string | number, unknown>;
    if (last) {
      container[key] = value;
      return;
    }
    let next = container[key];
    if (next === null || typeof next !== 'object') {
      next = nextIsIndex ? [] : {};
      container[key] = next;
    }
    cur = next as Record<string, unknown> | unknown[];
  }
}

export function splitBindingSource(from: string): { taskId: string; path: string } {
  const idx = from.indexOf('.output');
  return { taskId: from.slice(0, idx), path: from.slice(idx + '.output'.length).replace(/^\./, '') };
}

export class BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingError';
  }
}

/**
 * A binding implies a dependency: bind sources missing from dependsOn are added, so a plan that
 * pipes `t1.output.files` without also listing t1 runs in the right order instead of being
 * rejected (planners often omit the duplicate declaration).
 */
export function withBindingDeps<T extends Pick<TaskSpec, 'dependsOn' | 'bind'>>(spec: T): T {
  const missing = [...new Set(spec.bind.map((b) => splitBindingSource(b.from).taskId))].filter((id) => id && !spec.dependsOn.includes(id));
  return missing.length ? { ...spec, dependsOn: [...spec.dependsOn, ...missing] } : spec;
}

/** Static checks: every binding source must be a declared dependency. */
export function checkBindingRefs(spec: Pick<TaskSpec, 'id' | 'dependsOn' | 'bind'>): string[] {
  const errors: string[] = [];
  for (const b of spec.bind) {
    const { taskId } = splitBindingSource(b.from);
    if (!spec.dependsOn.includes(taskId)) errors.push(`binding ${b.arg} ← ${b.from} references ${taskId}, which is not in dependsOn`);
    try {
      parsePath(splitBindingSource(b.from).path);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return errors;
}

/** Resolves bindings against upstream outputs, returning a fresh args object. */
export function resolveArgs(args: Record<string, unknown>, bind: Binding[], outputs: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const resolved = structuredClone(args);
  for (const b of bind) {
    const { taskId, path } = splitBindingSource(b.from);
    if (!outputs.has(taskId)) throw new BindingError(`no output available from ${taskId}`);
    const value = getPath(outputs.get(taskId), path);
    if (value === undefined) throw new BindingError(`${b.from} resolved to nothing`);
    setPath(resolved, b.arg, value);
  }
  return resolved;
}

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[]; oneOf?: JsonSchema[] };
const outputSchemas = new WeakMap<z.ZodType, JsonSchema>();

/**
 * Static check of a binding path against a tool's output schema, e.g. `entries[*].path` on fs.list.
 * Returns the fields available where the path breaks, or null when the path exists or the schema
 * cannot tell (records, unknown values). Tool outputs are parsed by their schema, so a key the
 * schema does not list can never be present.
 */
export function missingOutputPath(output: z.ZodType, path: string): string[] | null {
  let root = outputSchemas.get(output);
  if (!root) {
    root = z.toJSONSchema(output, { io: 'output', unrepresentable: 'any' }) as JsonSchema;
    outputSchemas.set(output, root);
  }
  let segments: Segment[];
  try {
    segments = path ? parsePath(path) : [];
  } catch {
    return null;
  }
  const walk = (node: JsonSchema | undefined, i: number): string[] | null => {
    if (!node || i >= segments.length) return null;
    const branches = node.anyOf ?? node.oneOf;
    if (branches) {
      const results = branches.map((b) => walk(b, i));
      return results.some((r) => r === null) ? null : (results.find((r) => r) ?? null);
    }
    const seg = segments[i] as Segment;
    if (seg.kind === 'key') {
      if (seg.key === 'length') return null;
      if (!node.properties) return null;
      const next = node.properties[seg.key];
      return next ? walk(next, i + 1) : Object.keys(node.properties);
    }
    return node.items ? walk(node.items, i + 1) : null;
  };
  return walk(root, 0);
}

/** Match the condition evaluator's optional `output.` prefix, without stripping
 * a real field named output from a tool's declared contract. */
export function conditionOutputPath(output: z.ZodType, path: string): string {
  const schema = z.toJSONSchema(output, { io: 'output', unrepresentable: 'any' }) as JsonSchema;
  if (!schema.properties?.output && (path === 'output' || /^output[.[]/.test(path))) return path.replace(/^output\.?/, '');
  return path;
}
