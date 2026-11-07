import { z } from 'zod';
import { PathArg } from './fs';
import { displayPath, resolveUserPath } from './paths';
import { defineTool, ToolError } from './types';

const BundleId = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]+$/, 'bundle identifier like com.apple.TextEdit');

export const appsList = defineTool({
  id: 'apps.list',
  title: 'List running apps',
  description: 'List running GUI applications with bundle id, pid and whether each is active.',
  tier: 1,
  args: z.object({}),
  output: z.object({
    apps: z.array(z.object({ name: z.string(), bundleId: z.string(), pid: z.number(), active: z.boolean(), hidden: z.boolean() })),
  }),
  effectClass: 'read',
  effects: ['ui_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 5_000,
  async run(_a, ctx) {
    return ctx.helper.call('apps.list', {}, { signal: ctx.signal });
  },
});

export const appsInfo = defineTool({
  id: 'apps.info',
  title: 'App info',
  description: 'Return name, version, path and running state of an installed app by bundle id.',
  tier: 1,
  args: z.object({ bundleId: BundleId }),
  output: z.object({
    bundleId: z.string(),
    name: z.string(),
    version: z.string(),
    shortVersion: z.string(),
    path: z.string(),
    running: z.boolean(),
    pids: z.array(z.number()),
  }),
  effectClass: 'read',
  effects: ['ui_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 5_000,
  async run(a, ctx) {
    return ctx.helper.call('apps.info', { bundleId: a.bundleId }, { signal: ctx.signal });
  },
});

export const appsLaunch = defineTool({
  id: 'apps.launch',
  title: 'Open app',
  description: 'Launch (or bring forward) an app by bundle id, e.g. com.apple.TextEdit.',
  tier: 1,
  args: z.object({ bundleId: BundleId, activate: z.boolean().default(true) }),
  output: z.object({ pid: z.number(), bundleId: z.string() }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'low',
  idempotent: true,
  defaultTimeoutMs: 20_000,
  resources: (a) => [`app:${a.bundleId}`],
  preview: (a) => ({ summary: `Open ${a.bundleId}`, details: [] }),
  async run(a, ctx) {
    return ctx.helper.call('apps.launch', { bundleId: a.bundleId, activate: a.activate }, { signal: ctx.signal, timeoutMs: 20_000 });
  },
  async verify(a, _o, ctx) {
    const info = await ctx.helper.call('apps.info', { bundleId: a.bundleId });
    return [{ label: `${a.bundleId} is running`, ok: info.running }];
  },
});

export const appsActivate = defineTool({
  id: 'apps.activate',
  title: 'Bring app to front',
  description: 'Activate an already running app so it becomes frontmost.',
  tier: 1,
  args: z.object({ bundleId: BundleId }),
  output: z.object({ activated: z.boolean() }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'low',
  idempotent: true,
  defaultTimeoutMs: 5_000,
  resources: () => ['ui:frontmost'],
  async run(a, ctx) {
    const r = await ctx.helper.call('apps.activate', { bundleId: a.bundleId }, { signal: ctx.signal });
    if (!r.activated) throw new ToolError('not_activated', `${a.bundleId} could not be activated`, true);
    return r;
  },
});

export const appsQuit = defineTool({
  id: 'apps.quit',
  title: 'Quit app',
  description: 'Ask an app to quit (force=false lets it prompt to save). Unsaved work may be lost, so this needs confirmation.',
  tier: 1,
  args: z.object({ bundleId: BundleId, force: z.boolean().default(false) }),
  output: z.object({ requested: z.boolean(), count: z.number() }),
  effectClass: 'irreversible_local',
  effects: ['app_control'],
  risk: (a) => (a.force ? 'high' : 'medium'),
  idempotent: true,
  defaultTimeoutMs: 10_000,
  resources: (a) => [`app:${a.bundleId}`],
  preview: (a) => ({ summary: `${a.force ? 'Force quit' : 'Quit'} ${a.bundleId}`, details: ['Unsaved changes in that app may be lost.'] }),
  async run(a, ctx) {
    return ctx.helper.call('apps.quit', { bundleId: a.bundleId, force: a.force }, { signal: ctx.signal });
  },
});

export const workspaceOpen = defineTool({
  id: 'workspace.open',
  title: 'Open file or URL',
  description: 'Open a file with its default app (or a given app bundle id), or open an http(s)/mailto URL in the default handler.',
  tier: 1,
  args: z
    .object({ path: PathArg.optional(), url: z.url().max(2000).optional(), bundleId: BundleId.optional() })
    .refine((a) => Boolean(a.path) !== Boolean(a.url), 'provide exactly one of path or url'),
  output: z.object({ opened: z.boolean() }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'low',
  idempotent: true,
  defaultTimeoutMs: 10_000,
  paths: (a) => ({ read: a.path ? [a.path] : [], write: [] }),
  preview: (a) => ({ summary: a.path ? `Open ${displayPath(resolveUserPath(a.path))}` : `Open ${a.url}`, details: [] }),
  async run(a, ctx) {
    const r = await ctx.helper.call(
      'workspace.open',
      { ...(a.path ? { path: resolveUserPath(a.path) } : {}), ...(a.url ? { url: a.url } : {}), ...(a.bundleId ? { bundleId: a.bundleId } : {}) },
      { signal: ctx.signal },
    );
    if (!r.opened) throw new ToolError('not_opened', 'the system declined to open it');
    return r;
  },
});

export const workspaceReveal = defineTool({
  id: 'workspace.reveal',
  title: 'Show in Finder',
  description: 'Reveal and select files or folders in a Finder window.',
  tier: 1,
  args: z.object({ paths: z.array(PathArg).min(1).max(50) }),
  output: z.object({ ok: z.boolean() }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 10_000,
  paths: (a) => ({ read: a.paths, write: [] }),
  async run(a, ctx) {
    return ctx.helper.call('workspace.reveal', { paths: a.paths.map(resolveUserPath) }, { signal: ctx.signal });
  },
});

export const appTools = [appsList, appsInfo, appsLaunch, appsActivate, appsQuit, workspaceOpen, workspaceReveal];
