import { createHash, randomBytes } from 'node:crypto';
import { release } from 'node:os';
import type { PlanInput, RouteDecision, Settings, TaskSpecInput } from '@commandos/contracts';
import type { Fingerprint, ModelGateway, Procedure } from '@commandos/providers';
import type { HelperClient, ToolRegistry } from '@commandos/tools';
import { z } from 'zod';
import type { TaskRecord } from './executor';
import { type OrganizeSlots, extractFolder } from './router';
import { organizeScreenshotsPlan } from './templates';

export function toolVersion(registry: ToolRegistry, toolId: string): string {
  const tool = registry.get(toolId);
  if (!tool) return 'missing';
  const schema = JSON.stringify(z.toJSONSchema(tool.args, { io: 'input', unrepresentable: 'any' }));
  return createHash('sha1').update(`${tool.id}:${tool.tier}:${schema}`).digest('hex').slice(0, 10);
}

function collectStrings(value: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (typeof value === 'string') out.push({ path, value });
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${path}.${i}`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collectStrings(v, path ? `${path}.${k}` : k, out);
}

/** Environment the procedure relied on: tool contract versions, app versions, site origins, OS. */
export async function fingerprintFor(records: TaskRecord[], registry: ToolRegistry, helper: HelperClient | null): Promise<Fingerprint> {
  const tools: Record<string, string> = {};
  const apps: Record<string, string> = {};
  const sites: Record<string, string> = {};
  for (const r of records) {
    tools[r.tool.id] = toolVersion(registry, r.tool.id);
    const strings: Array<{ path: string; value: string }> = [];
    collectStrings(r.args ?? r.spec.args, '', strings);
    for (const s of strings) {
      if (s.path.endsWith('bundleId') && helper && !apps[s.value]) {
        const info = await helper.call('apps.info', { bundleId: s.value }).catch(() => null);
        if (info) apps[s.value] = info.shortVersion || info.version;
      }
      if (/^https?:\/\//.test(s.value)) {
        try {
          const origin = new URL(s.value).origin;
          // for form fills, remember which selectors the page had when it worked
          if (r.tool.id === 'web.fillForm') sites[origin] = createHash('sha1').update(strings.filter((x) => x.path.endsWith('selector')).map((x) => x.value).join('|')).digest('hex').slice(0, 10);
          else sites[origin] ??= 'seen';
        } catch {
          // not a URL
        }
      }
    }
  }
  return { tools, apps, sites, os: release().split('.')[0] ?? release() };
}

/** Compares a stored fingerprint with the current environment. Site changes surface at run time. */
export async function checkFingerprint(fp: Fingerprint, registry: ToolRegistry, helper: HelperClient | null): Promise<string[]> {
  const mismatches: string[] = [];
  for (const [tool, version] of Object.entries(fp.tools)) {
    const now = toolVersion(registry, tool);
    if (now !== version) mismatches.push(`tool ${tool} changed (${version} → ${now})`);
  }
  for (const [bundleId, version] of Object.entries(fp.apps)) {
    const info = helper ? await helper.call('apps.info', { bundleId }).catch(() => null) : null;
    const now = info ? info.shortVersion || info.version : 'missing';
    if (now !== version) mismatches.push(`app ${bundleId} is ${now}, procedure was verified on ${version}`);
  }
  const os = release().split('.')[0] ?? release();
  if (os !== fp.os) mismatches.push(`macOS kernel ${os} differs from ${fp.os}`);
  return mismatches;
}

const PATHISH = /^(~\/|\/)[^\s]*$/;

/** Literal argument values a user is likely to change when reusing a procedure. */
export function extractParameters(records: TaskRecord[], command: string): Procedure['parameters'] {
  const params: Procedure['parameters'] = [];
  for (const r of records) {
    const strings: Array<{ path: string; value: string }> = [];
    collectStrings(r.spec.args, '', strings);
    for (const s of strings) {
      if (!s.value) continue;
      const inCommand = s.value.length >= 3 && command.toLowerCase().includes(s.value.toLowerCase());
      if (PATHISH.test(s.value) || /^https?:\/\//.test(s.value) || inCommand) {
        params.push({ name: `${r.spec.id}.${s.path}`, value: s.value, description: `${r.tool.id} argument ${s.path}` });
      }
    }
  }
  return params.slice(0, 30);
}

export function buildProcedure(input: {
  runId: string;
  command: string;
  decision: RouteDecision;
  organize?: OrganizeSlots;
  records: TaskRecord[];
  fingerprint: Fingerprint;
  durationMs: number;
  summary: string;
}): Procedure {
  const template = input.decision.intent === 'organize_screenshots' && input.organize ? 'organize_screenshots' : null;
  return {
    kind: 'commandos.procedure',
    version: 1,
    id: `proc_${randomBytes(5).toString('hex')}`,
    intent: input.decision.intent,
    command: input.command,
    summary: input.summary,
    mode: template ? 'template' : 'plan',
    template,
    slots: template && input.organize ? { ...input.organize } : null,
    tasks: template
      ? null
      : input.records.map((r) => ({
          id: r.spec.id,
          tool: r.spec.tool,
          title: r.spec.title ?? r.tool.title,
          args: r.spec.args,
          dependsOn: r.spec.dependsOn,
          bind: r.spec.bind,
          postconditions: r.spec.postconditions,
        })),
    parameters: template
      ? Object.entries(input.organize ?? {})
          .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
          .map(([name, value]) => ({ name, value: String(value), description: `organize_screenshots slot ${name}` }))
      : extractParameters(input.records, input.command),
    fingerprint: input.fingerprint,
    stats: { successes: 1, failures: 0, avgMs: input.durationMs, lastVerifiedAt: new Date().toISOString() },
    runId: input.runId,
    status: 'active',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Re-binds a procedure's parameters for a new command without a model when the command names
 * them explicitly (a folder, a count, a destination name). Returns null when a model is needed.
 */
export function bindDeterministic(p: Procedure, command: string): Record<string, string> | null {
  const folder = extractFolder(command);
  const named = /(?:folder|directory)\s+(?:called|named|titled)\s+["“']?(.+?)["”']?(?=\s+(?:and|then|on|in|under|with|from|so)\b|\s*[.,!?;]|$)/i.exec(command)?.[1]?.trim();
  if (p.mode === 'template') {
    const values: Record<string, string> = {};
    if (folder) values.sourceFolder = folder;
    if (named) values.destinationName = named;
    return Object.keys(values).length ? values : null;
  }
  const pathParams = p.parameters.filter((x) => PATHISH.test(x.value));
  if (folder && pathParams.length >= 1) {
    // rebase every path that lived under the most common old directory
    const dirs = pathParams.map((x) => x.value.replace(/\/[^/]*$/, ''));
    const base = dirs.sort((a, b) => dirs.filter((d) => d === b).length - dirs.filter((d) => d === a).length)[0] as string;
    const values: Record<string, string> = {};
    for (const x of pathParams) {
      if (x.value === base) values[x.name] = folder;
      else if (x.value.startsWith(`${base}/`)) values[x.name] = folder + x.value.slice(base.length);
    }
    return Object.keys(values).length ? values : null;
  }
  return null;
}

const BindingSchema = z.object({ values: z.array(z.object({ name: z.string(), value: z.string() })) });

/** One fast-model call to re-bind parameters when the command is phrased loosely. */
export async function bindWithModel(p: Procedure, command: string, models: ModelGateway, ctx: { runId: string; signal?: AbortSignal }): Promise<Record<string, string>> {
  const { data } = await models.parse({
    tier: 'fast',
    purpose: 'bind_procedure',
    runId: ctx.runId,
    signal: ctx.signal,
    schema: BindingSchema,
    schemaName: 'procedure_binding',
    cacheKey: 'commandos.bind-procedure.v1',
    maxOutputTokens: 1500,
    instructions:
      'A stored procedure is being reused for a new command. For each parameter, return the value it should take for the new command; repeat the old value when the new command does not change it. Use ~/ paths. Return only parameters from the list.',
    input: JSON.stringify({ previousCommand: p.command, newCommand: command, parameters: p.parameters }),
  });
  const allowed = new Set(p.parameters.map((x) => x.name));
  return Object.fromEntries(data.values.filter((v) => allowed.has(v.name)).map((v) => [v.name, v.value]));
}

function setByPath(target: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = /^\d+$/.test(parts[i] as string) ? Number(parts[i]) : (parts[i] as string);
    cur = (cur as Record<string | number, unknown>)[key] as Record<string, unknown> | unknown[];
    if (cur === undefined || cur === null) return;
  }
  const last = parts.at(-1) as string;
  (cur as Record<string | number, unknown>)[/^\d+$/.test(last) ? Number(last) : last] = value;
}

/** Produces an executable plan from a procedure and bound parameter values. */
export function instantiate(p: Procedure, values: Record<string, string>, settings: Settings, opts: { reveal?: boolean } = {}): PlanInput {
  if (p.mode === 'template' && p.template === 'organize_screenshots') {
    const s = { ...(p.slots ?? {}) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(values)) s[k] = k === 'count' || k === 'withinDays' ? Number(v) : v;
    if (values.sourceFolder && !values.destinationFolder) s.destinationFolder = null;
    return organizeScreenshotsPlan(s as unknown as OrganizeSlots, settings, opts);
  }
  const tasks = structuredClone(p.tasks ?? []) as Array<Record<string, unknown>>;
  for (const [name, value] of Object.entries(values)) {
    const dot = name.indexOf('.');
    const task = tasks.find((t) => t.id === name.slice(0, dot));
    if (task) setByPath(task.args as Record<string, unknown>, name.slice(dot + 1), value);
  }
  return { goal: `Replay: ${p.summary}`, tasks: tasks as unknown as TaskSpecInput[], assumptions: [`reusing procedure ${p.id} from “${p.command}”`] };
}
