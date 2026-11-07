import { defaultSettings } from '@commandos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { photoBoothTakePhoto } from '../src/camera';
import type { ToolContext } from '../src/types';

vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), readdirSync: vi.fn(() => []), statSync: vi.fn() };
});

function harness(options: { activated?: boolean; frontmost?: string } = {}) {
  const call = vi.fn(async (method: string) => {
    if (method === 'apps.info') return { bundleId: 'com.apple.PhotoBooth', name: 'Photo Booth', version: '', shortVersion: '', path: '/Applications/Photo Booth.app', running: true, pids: [123] };
    if (method === 'apps.launch') return { pid: 123, bundleId: 'com.apple.PhotoBooth' };
    if (method === 'apps.activate') return { activated: options.activated ?? true };
    if (method === 'apps.frontmost') return { app: { bundleId: options.frontmost ?? 'com.apple.PhotoBooth', name: 'Photo Booth', pid: 123, active: true, hidden: false } };
    return { ok: true };
  });
  const context = { runId: 'camera-test', taskId: 'photo', signal: new AbortController().signal, dryRun: false, settings: defaultSettings(), helper: { call }, models: null, providers: { get: async () => { throw new Error('No providers'); } }, journal: { record: vi.fn() }, artifactsDir: '/tmp', log: vi.fn(), progress: vi.fn() } as unknown as ToolContext;
  return { call, context };
}

describe('Photo Booth capture focus guard', () => {
  beforeEach(() => vi.useFakeTimers());

  it('does not send the shutter shortcut if Photo Booth refuses activation', async () => {
    const h = harness({ activated: false });
    const result = photoBoothTakePhoto.run({}, h.context);
    const rejected = expect(result).rejects.toMatchObject({ code: 'not_frontmost' });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(h.call.mock.calls.some(([method]) => method === 'keyboard.press')).toBe(false);
  });

  it('does not send the shutter shortcut to another frontmost app', async () => {
    const h = harness({ frontmost: 'com.todesktop.230313mzl4w4u92' });
    const result = photoBoothTakePhoto.run({}, h.context);
    const rejected = expect(result).rejects.toMatchObject({ code: 'not_frontmost' });
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(h.call.mock.calls.some(([method]) => method === 'keyboard.press')).toBe(false);
  });
});
