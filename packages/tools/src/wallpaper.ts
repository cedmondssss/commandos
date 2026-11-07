import { execFile } from 'node:child_process';
import { z } from 'zod';
import { PathArg } from './fs';
import { resolveUserPath } from './paths';
import { delay } from './poll';
import { defineTool, ToolError } from './types';

/**
 * Desktop wallpaper through NSWorkspace (JavaScript for Automation's Objective-C bridge): no Apple
 * Events to another app, so no Automation prompt, and no helper rebuild.
 */
function jxa(source: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], { timeout: 10_000, signal }, (err, stdout, stderr) => {
      if (err) reject(new ToolError('wallpaper_failed', (stderr || err.message).trim().slice(0, 300)));
      else resolve(stdout.trim());
    });
  });
}

const GET = `ObjC.import('AppKit');
const ws = $.NSWorkspace.sharedWorkspace, screens = $.NSScreen.screens, out = [];
for (let i = 0; i < screens.count; i++) { const u = ws.desktopImageURLForScreen(screens.objectAtIndex(i)); out.push(u.isNil() ? '' : u.path.js); }
JSON.stringify(out);`;

/** Sets one image (all screens) or one image per screen, in screen order. */
const set = (paths: string[]) => `ObjC.import('AppKit');
const paths = ${JSON.stringify(paths)};
const ws = $.NSWorkspace.sharedWorkspace, screens = $.NSScreen.screens;
let ok = true;
for (let i = 0; i < screens.count; i++) {
  const p = paths[Math.min(i, paths.length - 1)];
  ok = ws.setDesktopImageURLForScreenOptionsError($.NSURL.fileURLWithPath(p), screens.objectAtIndex(i), $({}), null) && ok;
}
JSON.stringify(ok);`;

export async function currentWallpapers(signal: AbortSignal): Promise<string[]> {
  return JSON.parse(await jxa(GET, signal)) as string[];
}

export const setWallpaper = defineTool({
  id: 'desktop.setWallpaper',
  title: 'Set the wallpaper',
  description:
    'Set the desktop wallpaper on every screen to an image file, e.g. a photo path bound from photobooth_takePhoto. On macOS the lock screen shows this same wallpaper (there is no separate lock-screen image), so use it for "wallpaper", "background", "home screen" and "lock screen" alike. restoreAfterSeconds puts the previous wallpaper back after that many seconds ("change it back / remove it after 5 seconds"). Returns the previous wallpaper paths.',
  tier: 1,
  args: z.object({ path: PathArg, restoreAfterSeconds: z.number().int().min(1).max(600).optional() }),
  output: z.object({ path: z.string(), previous: z.array(z.string()), restored: z.boolean() }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'low',
  idempotent: true,
  defaultTimeoutMs: 660_000,
  resources: () => ['desktop:wallpaper'],
  paths: (a) => ({ read: [a.path], write: [] }),
  preview: (a) => ({ summary: `Set the wallpaper to ${a.path}`, details: a.restoreAfterSeconds ? [`Change it back after ${a.restoreAfterSeconds} s`] : [] }),
  async run(a, ctx) {
    const path = resolveUserPath(a.path);
    if (!/\.(jpe?g|png|heic|tiff?|gif)$/i.test(path)) throw new ToolError('not_an_image', 'the wallpaper must be an image file');
    const previous = (await currentWallpapers(ctx.signal)).filter(Boolean);
    if ((await jxa(set([path]), ctx.signal)) !== 'true') throw new ToolError('wallpaper_failed', 'macOS did not accept the new wallpaper');
    const now = await currentWallpapers(ctx.signal);
    if (!now.every((p) => p === path)) throw new ToolError('unverified', 'the wallpaper did not change');
    if (!a.restoreAfterSeconds || !previous.length) return { path, previous, restored: false };
    ctx.progress(`Wallpaper set; changing it back in ${a.restoreAfterSeconds} s`);
    await delay(a.restoreAfterSeconds * 1000, ctx.signal);
    if ((await jxa(set(previous), ctx.signal)) !== 'true') throw new ToolError('restore_failed', 'could not put the previous wallpaper back');
    return { path, previous, restored: true };
  },
});

export const systemWait = defineTool({
  id: 'system.wait',
  title: 'Wait',
  description: 'Wait a number of seconds before the next step ("wait 5 seconds, then …"). Use depends_on to order the steps around it.',
  tier: 1,
  args: z.object({ seconds: z.number().min(0.1).max(600) }),
  output: z.object({ waitedMs: z.number() }),
  effectClass: 'read',
  effects: [],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 610_000,
  preview: (a) => ({ summary: `Wait ${a.seconds} s`, details: [] }),
  async run(a, ctx) {
    const t = Date.now();
    await delay(a.seconds * 1000, ctx.signal);
    return { waitedMs: Date.now() - t };
  },
});

export const desktopTools = [setWallpaper, systemWait];
