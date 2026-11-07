import { readdir, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { type CheckResult, type Condition, compare, describeCondition } from '@commandos/contracts';
import { type HelperClient, pathExists, resolveUserPath } from '@commandos/tools';
import { getPath } from './bindings';

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Output paths are relative to the task's own output. Planners often write them the way binds
 * reference outputs (`output.files`); accept that form unless the output really has an `output` key.
 */
function outputValue(output: unknown, path: string): unknown {
  const ownKey = output !== null && typeof output === 'object' && 'output' in output;
  if (!ownKey && path === 'output') return output;
  if (!ownKey && /^output[.[]/.test(path)) return getPath(output, path.replace(/^output\.?/, ''));
  return getPath(output, path);
}

export async function evaluateCondition(c: Condition, output: unknown, helper: HelperClient | null, signal?: AbortSignal): Promise<CheckResult> {
  signal?.throwIfAborted();
  const label = describeCondition(c);
  try {
    switch (c.kind) {
      case 'file_exists':
        return { label, ok: await pathExists(resolveUserPath(c.path)) };
      case 'file_absent':
        return { label, ok: !(await pathExists(resolveUserPath(c.path))) };
      case 'dir_file_count': {
        const dir = resolveUserPath(c.dir);
        const exts = c.extensions?.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
        const entries = await readdir(dir, { withFileTypes: true });
        let count = 0;
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          if (!e.isFile()) continue;
          if (exts && !exts.includes(extname(e.name).toLowerCase())) continue;
          count++;
        }
        return { label, ok: compare(c.op, count, c.value), detail: `found ${count}` };
      }
      case 'app_running': {
        if (!helper) return { label, ok: false, detail: 'helper unavailable' };
        const info = await helper.call('apps.info', { bundleId: c.bundleId }, { signal });
        return { label, ok: info.running };
      }
      case 'ax_value_equals': {
        if (!helper) return { label, ok: false, detail: 'helper unavailable' };
        const { value } = await helper.call('ax.getValue', { ref: c.ref }, { signal });
        return { label, ok: value === c.value, detail: `actual: ${JSON.stringify(value)}` };
      }
      case 'output_equals': {
        const actual = outputValue(output, c.path);
        return { label, ok: deepEqual(actual, c.value), detail: `actual: ${JSON.stringify(actual)?.slice(0, 200)}` };
      }
      case 'output_count': {
        const actual = outputValue(output, c.path);
        const n = Array.isArray(actual) ? actual.length : typeof actual === 'number' ? actual : Number.NaN;
        return { label, ok: Number.isFinite(n) && compare(c.op, n, c.value), detail: `actual: ${n}` };
      }
      case 'output_truthy': {
        const actual = outputValue(output, c.path);
        const ok = Array.isArray(actual) ? actual.length > 0 : Boolean(actual);
        return { label, ok };
      }
    }
  } catch (e) {
    signal?.throwIfAborted();
    return { label, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function evaluateConditions(conds: Condition[], output: unknown, helper: HelperClient | null, signal?: AbortSignal): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of conds) out.push(await evaluateCondition(c, output, helper, signal));
  return out;
}

export async function isDirectory(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}
