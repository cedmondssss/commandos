import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AxElement } from '@commandos/contracts';
import { z } from 'zod';
import { resolveUserPath } from './paths';
import { delay, pollUntil } from './poll';
import { defineTool, type ToolContext, ToolError } from './types';

const PHOTO_BOOTH = 'com.apple.PhotoBooth';
const LIBRARY = '~/Pictures/Photo Booth Library/Pictures';
const labels = (e: AxElement) => [e.title, e.label, e.description].filter((s): s is string => Boolean(s)).map((s) => s.trim().toLowerCase());

async function requirePhotoBoothFocus(ctx: ToolContext) {
  const current = await ctx.helper.call('apps.frontmost', {}, { signal: ctx.signal });
  if (current.app?.bundleId !== PHOTO_BOOTH) throw new ToolError('not_frontmost', 'Photo Booth lost keyboard focus. No capture was started.');
}

function photos(dir: string): Array<{ name: string; mtime: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.(jpe?g|png|heic)$/i.test(n))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }));
}

/**
 * A photo of the user through Photo Booth, the way a person would take one: open it, press its
 * enabled still-photo shutter (after Photo Booth's 3-second countdown), and pick the new file up from
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
    await ctx.helper.call('apps.launch', { bundleId: PHOTO_BOOTH, activate: true }, { signal: ctx.signal, timeoutMs: 20_000 });
    const activation = await ctx.helper.call('apps.activate', { bundleId: PHOTO_BOOTH }, { signal: ctx.signal });
    if (!activation.activated) throw new ToolError('not_frontmost', 'Photo Booth did not come to the front. Bring it forward before taking a picture.');
    const frontmost = await pollUntil(async () => {
      const current = await ctx.helper.call('apps.frontmost', {}, { signal: ctx.signal });
      return current.app?.bundleId === PHOTO_BOOTH ? true : null;
    }, 2_000, ctx.signal, 100);
    if (!frontmost) throw new ToolError('not_frontmost', 'Photo Booth is not the frontmost app. Bring its window forward, then try again.');
    ctx.progress('Waiting for Photo Booth’s still-photo shutter to become ready');
    let resumed = false;
    const shutter = await pollUntil(async () => {
      await requirePhotoBoothFocus(ctx);
      const tree = await ctx.helper.call('ax.tree', { bundleId: PHOTO_BOOTH, scope: 'window', maxDepth: 15, maxNodes: 1000 }, { signal: ctx.signal });
      if (tree.truncated) throw new ToolError('page_not_ready', 'Photo Booth’s capture controls could not be read completely. No capture was started.');
      const mode = tree.elements.filter((e) => e.role === 'AXRadioButton' && labels(e).includes('picture'));
      if (mode.length !== 1) return null;
      if (mode[0]!.value !== '1') {
        if (mode[0]!.enabled === true) {
          await requirePhotoBoothFocus(ctx);
          await ctx.helper.call('ax.press', { ref: mode[0]!.ref }, { signal: ctx.signal });
        }
        return null;
      }
      const buttons = tree.elements.filter((e) => e.role === 'AXButton' && labels(e).some((s) => /^(?:take photo|take (?:a )?picture)$/.test(s)));
      if (buttons.length !== 1) return null;
      if (buttons[0]!.enabled === true) return buttons[0]!;
      // Photo Booth can display “Click Photo Booth to resume” with a disabled
      // shutter even after app activation. Resume the identified preview once.
      const previews = tree.elements.filter((e) => e.role === 'AXImage' && labels(e).includes('preview'));
      const frame = previews.length === 1 ? previews[0]!.frame : null;
      if (!resumed && frame && frame.width > 0 && frame.height > 0) {
        await requirePhotoBoothFocus(ctx);
        await ctx.helper.call('mouse.click', { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2, button: 'left', clicks: 1 }, { signal: ctx.signal });
        resumed = true;
      }
      return null;
    }, 8_000, ctx.signal, 150, false);
    if (!shutter) throw new ToolError('page_not_ready', 'Photo Booth’s shutter stayed disabled. Resume its preview and make sure the camera is available; no capture was started.');
    await requirePhotoBoothFocus(ctx);
    const shutterLabel = labels(shutter).find((s) => /^(?:take photo|take (?:a )?picture)$/.test(s))!;
    ctx.progress('Clicking Photo Booth’s shutter once');
    try {
      // AXPress can acknowledge Photo Booth's custom shutter without firing it.
      // Re-find the enabled control and physically click its current bounds.
      const clicked = await ctx.helper.call('ax.click', { bundleId: PHOTO_BOOTH, role: 'AXButton', text: shutterLabel, expectLabel: shutterLabel }, { signal: ctx.signal });
      if (!clicked.clicked) throw new Error('Click was not acknowledged');
    } catch {
      ctx.signal.throwIfAborted();
      throw new ToolError('input_unverified', 'Photo Booth’s shutter click could not be confirmed. Check its library before taking another photo.');
    }
    ctx.progress('Waiting for Photo Booth’s countdown and saved photo');
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
    throw new ToolError('input_unverified', 'Sent one shutter click, but Photo Booth did not save a new photo. Check Photo Booth before retrying; no email was prepared.');
  },
});

export const cameraTools = [photoBoothTakePhoto];
