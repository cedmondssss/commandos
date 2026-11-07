import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveUserPath } from './paths';
import { delay, pollUntil } from './poll';
import { defineTool, ToolError } from './types';

const PHOTO_BOOTH = 'com.apple.PhotoBooth';
const LIBRARY = '~/Pictures/Photo Booth Library/Pictures';

function photos(dir: string): Array<{ name: string; mtime: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.(jpe?g|png|heic)$/i.test(n))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }));
}

/**
 * A photo of the user through Photo Booth, the way a person would take one: open it, press its
 * shutter shortcut (⌘↩, after Photo Booth's 3-second countdown), and pick the new file up from
 * its library. No screen reading or model calls; the user sees the photo in Photo Booth.
 */
export const photoBoothTakePhoto = defineTool({
  id: 'photobooth.takePhoto',
  title: 'Take a photo',
  description:
    'Take a photo of the user with the Mac camera using Photo Booth and return the saved file path (for opening it, or attaching it to an email with gmail_compose attachments). No screen reading needed.',
  tier: 2,
  args: z.object({}),
  output: z.object({ path: z.string(), name: z.string() }),
  effectClass: 'reversible_local',
  effects: ['app_control', 'ui_input', 'fs_write'],
  risk: 'low',
  idempotent: false,
  defaultTimeoutMs: 30_000,
  resources: () => [`app:${PHOTO_BOOTH}`, 'ui:frontmost'],
  paths: () => ({ read: [], write: [LIBRARY] }),
  preview: () => ({ summary: 'Take a photo with Photo Booth', details: [] }),
  async run(_a, ctx) {
    const dir = resolveUserPath(LIBRARY);
    const before = new Set(photos(dir).map((p) => p.name));
    const info = await ctx.helper.call('apps.info', { bundleId: PHOTO_BOOTH }, { signal: ctx.signal }).catch(() => null);
    await ctx.helper.call('apps.launch', { bundleId: PHOTO_BOOTH, activate: true }, { signal: ctx.signal, timeoutMs: 20_000 });
    // the camera needs a moment to start when Photo Booth was not already open
    await delay(info?.running ? 400 : 2_500, ctx.signal);
    const activation = await ctx.helper.call('apps.activate', { bundleId: PHOTO_BOOTH }, { signal: ctx.signal });
    if (!activation.activated) throw new ToolError('not_frontmost', 'Photo Booth did not come to the front. Bring it forward before taking a picture.');
    const frontmost = await pollUntil(async () => {
      const current = await ctx.helper.call('apps.frontmost', {}, { signal: ctx.signal });
      return current.app?.bundleId === PHOTO_BOOTH ? true : null;
    }, 2_000, ctx.signal, 100);
    if (!frontmost) throw new ToolError('not_frontmost', 'Photo Booth is not the frontmost app. Bring its window forward, then try again.');
    ctx.progress('Smile: Photo Booth counts down from 3');
    await ctx.helper.call('keyboard.press', { key: 'return', modifiers: ['command'] }, { signal: ctx.signal });
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await delay(400, ctx.signal);
      const fresh = photos(dir)
        .filter((p) => !before.has(p.name))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (fresh) {
        const path = join(dir, fresh.name);
        await ctx.journal.record({ kind: 'delete_created', path, isDir: false });
        return { path, name: fresh.name };
      }
    }
    throw new ToolError('not_taken', 'Photo Booth did not save a new photo. Is the camera free and Photo Booth in front?');
  },
});

export const cameraTools = [photoBoothTakePhoto];
