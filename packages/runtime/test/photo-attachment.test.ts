import { join } from 'node:path';
import { photoBoothTakePhoto, browserAttachFile, ToolError } from '@commandos/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchExistingAttachment, matchPhotoAttachment } from '../src/photo-attachment';
import { routeLocally } from '../src/router';
import { photoAttachmentPlan } from '../src/templates';
import { CommandRuntime } from '../src/runtime';
import { tempDir } from './helpers';

const command = 'yu see the qwen tab i have open on google chrome take a pic on phto bnooth and upload to the chat but dont submit it yet or anything';
const recentCommand = 'take a pic of me on photobooth and uplaod it to the qwen chat i have open of googek chrome';
const existingCommand = (path: string) => `Attach only this Photo Booth image to the existing Qwen chat in Google Chrome: ${path}. Do not take another photo, type a chat message, or submit/send anything.`;
afterEach(() => vi.restoreAllMocks());

describe('photo attachment routing', () => {
  it('routes the reported existing-file command locally and preserves the full path', () => {
    const path = '/Users/soulemanesow/Pictures/Photo Booth Library/Pictures/Photo on 10-16-26 at 10.52AM.jpg';
    for (const input of [existingCommand(path), `“${existingCommand(path)}”`, existingCommand(path.replace('52AM', '52\u202fAM'))]) {
      const match = matchExistingAttachment(input);
      expect(match).not.toBeNull();
      expect(routeLocally(input)).toMatchObject({ existingAttachment: match, decision: { mode: 'fast', via: 'grammar' } });
      expect(photoAttachmentPlan(match!.path).tasks).toEqual([expect.objectContaining({ tool: 'browser.attachFile', args: expect.objectContaining({ path: match!.path }) })]);
    }
  });

  it('does not discard extra actions or destinations from existing-file requests', () => {
    const text = existingCommand('/tmp/photo.jpg');
    for (const input of [text + ' Then send it anyway.', text.replace('Google Chrome', 'Safari'), text.replace('Do not take', 'Take'), text.replace('existing Qwen', 'new Qwen'), text.replace('photo.jpg', 'photo.jpg\nother.jpg')]) {
      expect(matchExistingAttachment(input), input).toBeNull();
    }
  });

  it.each([command, recentCommand, 'Take a photo in Photo Booth and upload it to my open Qwen chat'])('routes the reported command to two fixed steps without a planning loop: %s', (text) => {
    expect(routeLocally(text)).toMatchObject({ photoAttachment: true, decision: { mode: 'fast', via: 'grammar' } });
    expect(photoAttachmentPlan().tasks.map((t) => t.tool)).toEqual(['photobooth.takePhoto', 'browser.attachFile']);
    expect(photoAttachmentPlan().tasks[1]?.bind).toEqual([{ arg: 'path', from: 'photo.output.path' }]);
  });

  it('preserves explicit constraints instead of silently dropping extra actions', () => {
    expect(matchPhotoAttachment('Take a photo in Photo Booth and attach it to Qwen without submitting')).toBe(true);
    expect(matchPhotoAttachment('Take a pic and upload to Qwen, keep it unsent')).toBe(true);
    for (const text of [
      'Take a photo and attach it to Qwen and submit it',
      'Take a photo and attach it to Qwen, do not submit, then send it anyway',
      'Take a photo and attach it to Qwen without submitting and write a caption',
      'Take a photo and attach it to Qwen without submitting in Safari',
      'Do not take a photo; attach the old photo to Qwen without submitting',
      'Take a photo but do not upload it to Qwen, do not submit',
      'Take a photo and upload it to Qwen without submitting, then email me',
    ]) expect(matchPhotoAttachment(text), text).toBe(false);
  });
});

describe('attach-only workflow through the runtime', () => {
  it.each(['approve', 'deny'] as const)('attaches an existing file without any camera or model calls and honors approval: %s', async (decision) => {
    const dir = await tempDir('commandos-existing-photo-');
    const path = join(dir, 'Photo on 10-16-26 at 10.52AM.jpg');
    const photo = vi.spyOn(photoBoothTakePhoto, 'run');
    const attach = vi.spyOn(browserAttachFile, 'run').mockResolvedValue({ path, url: 'https://chat.qwen.ai/c/test', title: 'Qwen', attached: true, submitted: false, confirmation: 'Attachment visible; message unsent' });
    const rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: '/nonexistent', useKeychain: false, telemetry: false, revealResults: false, env: {}, settingsOverride: { allowedRoots: [dir] } });
    vi.spyOn(rt, 'getModels').mockResolvedValue(null);
    rt.on('run', (e) => { if (e.type === 'approval_requested') rt.respondApproval(e.approval.id, decision); });
    try {
      const id = await rt.submit(existingCommand(path), 'text');
      const result = await rt.waitForRun(id);
      const snap = await rt.getRun(id);
      expect(photo).not.toHaveBeenCalled();
      expect(snap.events.filter((e) => e.type === 'task_added').map((e) => e.type === 'task_added' ? e.task.tool : '')).toEqual(['browser.attachFile']);
      expect(snap.events.some((e) => e.type === 'model_call')).toBe(false);
      if (decision === 'approve') {
        expect(result.state).toBe('succeeded');
        expect(result.summary).toContain('left unsent');
        expect(attach).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), expect.anything());
      } else {
        expect(result.state).toBe('failed');
        expect(attach).not.toHaveBeenCalled();
      }
    } finally { await rt.shutdown(); }
  });

  it.each(['approve', 'deny'] as const)('binds the saved photo path and honors upload approval: %s', async (decision) => {
    const dir = await tempDir('commandos-photo-');
    const path = join(dir, 'photo.jpg');
    const photo = vi.spyOn(photoBoothTakePhoto, 'run').mockResolvedValue({ path, name: 'photo.jpg' });
    const attach = vi.spyOn(browserAttachFile, 'run').mockResolvedValue({ path, url: 'https://chat.qwen.ai/c/test', title: 'Qwen', attached: true, submitted: false, confirmation: 'Attachment visible; message unsent' });
    const rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: '/nonexistent', useKeychain: false, telemetry: false, revealResults: false, env: {}, settingsOverride: { allowedRoots: [dir, '~/Pictures/Photo Booth Library/Pictures'] } });
    const models = vi.spyOn(rt, 'getModels').mockResolvedValue(null);
    rt.on('run', (e) => { if (e.type === 'approval_requested') rt.respondApproval(e.approval.id, decision); });
    try {
      const id = await rt.submit(recentCommand, 'text');
      const result = await rt.waitForRun(id);
      const snap = await rt.getRun(id);
      expect(photo).toHaveBeenCalledTimes(1);
      expect(snap.events.filter((e) => e.type === 'task_added').map((e) => e.type === 'task_added' ? e.task.tool : '')).toEqual(['photobooth.takePhoto', 'browser.attachFile']);
      expect(snap.events.some((e) => e.type === 'model_call')).toBe(false);
      if (decision === 'approve') {
        expect(result.state).toBe('succeeded');
        expect(result.summary).toContain('left unsent');
        expect(attach).toHaveBeenCalledWith(expect.objectContaining({ path }), expect.anything());
      } else {
        expect(result.state).toBe('partial');
        expect(attach).not.toHaveBeenCalled();
      }
      expect(models).toHaveBeenCalled(); // a null gateway is sufficient: the route needs no model
    } finally { await rt.shutdown(); }
  });

  it('does not turn failed attachment verification into another upload or a false success', async () => {
    const dir = await tempDir('commandos-photo-');
    vi.spyOn(photoBoothTakePhoto, 'run').mockResolvedValue({ path: join(dir, 'photo.jpg'), name: 'photo.jpg' });
    const attach = vi.spyOn(browserAttachFile, 'run').mockRejectedValue(new ToolError('upload_unverified', 'No attachment was visible; chat left unsent'));
    const rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: '/nonexistent', useKeychain: false, telemetry: false, revealResults: false, env: {}, settingsOverride: { allowedRoots: [dir, '~/Pictures/Photo Booth Library/Pictures'] } });
    vi.spyOn(rt, 'getModels').mockResolvedValue(null);
    rt.on('run', (e) => { if (e.type === 'approval_requested') rt.respondApproval(e.approval.id, 'approve'); });
    try {
      const id = await rt.submit(command, 'text');
      expect((await rt.waitForRun(id)).state).toBe('partial');
      expect(attach).toHaveBeenCalledTimes(1);
    } finally { await rt.shutdown(); }
  });
});
