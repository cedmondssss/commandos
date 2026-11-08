import { defaultSettings } from '@commandos/contracts';
import { readdirSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { photoBoothTakePhoto } from '../src/camera';
import type { ToolContext } from '../src/types';

vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), readdirSync: vi.fn(() => []), statSync: vi.fn() };
});

function harness(options: { activated?: boolean; frontmost?: string; disabled?: boolean; resumes?: boolean; videoMode?: boolean; noSavedPhoto?: boolean; clickAckLost?: boolean } = {}) {
  let ready = !options.disabled;
  let picture = !options.videoMode;
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'apps.info') return { bundleId: 'com.apple.PhotoBooth', name: 'Photo Booth', version: '', shortVersion: '', path: '/Applications/Photo Booth.app', running: true, pids: [123] };
    if (method === 'apps.launch') return { pid: 123, bundleId: 'com.apple.PhotoBooth' };
    if (method === 'apps.activate') return { activated: options.activated ?? true };
    if (method === 'apps.frontmost') return { app: { bundleId: options.frontmost ?? 'com.apple.PhotoBooth', name: 'Photo Booth', pid: 123, active: true, hidden: false } };
    if (method === 'ax.tree') return { truncated: false, elements: [
      { ref: '123:0.0', role: 'AXRadioButton', description: 'picture', value: picture ? '1' : '0', enabled: true },
      { ref: '123:0.1', role: 'AXButton', description: 'take photo', enabled: ready },
      { ref: '123:0.2', role: 'AXImage', description: 'preview', frame: { x: 100, y: 100, width: 600, height: 400 } },
    ] };
    if (method === 'mouse.click' && options.resumes) ready = true;
    if (method === 'ax.press' && params.ref === '123:0.0') picture = true;
    // The real failure: AXPress returns success but never fires the custom shutter.
    if (method === 'ax.press' && params.ref === '123:0.1') return { ok: true };
    if (method === 'ax.click') {
      if (!ready || !picture) throw new Error('Shutter is not ready for a still photo');
      if (!options.noSavedPhoto) vi.mocked(readdirSync).mockImplementation((() => ['Photo on 11-7-26 at 9.44\u202fPM.jpg']) as unknown as typeof readdirSync);
      if (options.clickAckLost) throw new Error('Click acknowledgement lost');
      return { clicked: true };
    }
    return { ok: true };
  });
  const context = { runId: 'camera-test', taskId: 'photo', signal: new AbortController().signal, dryRun: false, settings: defaultSettings(), helper: { call }, models: null, providers: { get: async () => { throw new Error('No providers'); } }, journal: { record: vi.fn() }, artifactsDir: '/tmp', log: vi.fn(), progress: vi.fn() } as unknown as ToolContext;
  return { call, context };
}

describe('Photo Booth capture focus guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(readdirSync).mockImplementation((() => []) as typeof readdirSync);
    vi.mocked(statSync).mockImplementation((() => ({ mtimeMs: Date.now() })) as unknown as typeof statSync);
  });
  afterEach(() => vi.useRealTimers());

  it.each([{ disabled: true, resumes: true }, { videoMode: true }, {}])('resumes the camera and selects still-photo mode before one capture: %j', async (options) => {
    const h = harness(options);
    const result = photoBoothTakePhoto.run({}, h.context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.call.mock.calls.filter(([method]) => method === 'ax.click')).toHaveLength(1);
    expect((await result).name).toContain('9.44\u202fPM.jpg');
    expect(h.call).toHaveBeenCalledWith('ax.click', { bundleId: 'com.apple.PhotoBooth', role: 'AXButton', text: 'take photo', expectLabel: 'take photo' }, expect.anything());
    expect(h.call.mock.calls.some(([method, params]) => method === 'ax.press' && params.ref === '123:0.1')).toBe(false);
    expect(h.call.mock.calls.some(([method]) => method === 'keyboard.press')).toBe(false);
    if (options.disabled) expect(h.call).toHaveBeenCalledWith('mouse.click', { x: 400, y: 300, button: 'left', clicks: 1 }, expect.anything());
  });

  it('does not trigger a disabled shutter or repeatedly click a paused preview', async () => {
    const h = harness({ disabled: true });
    const result = photoBoothTakePhoto.run({}, h.context);
    const rejected = expect(result).rejects.toMatchObject({ code: 'page_not_ready' });
    await vi.advanceTimersByTimeAsync(8_500);
    await rejected;
    expect(h.call.mock.calls.filter(([method]) => method === 'mouse.click')).toHaveLength(1);
    expect(h.call.mock.calls.some(([method]) => method === 'ax.press' || method === 'ax.click' || method === 'keyboard.press')).toBe(false);
  });

  it.each([{ noSavedPhoto: true }, { clickAckLost: true }])('never repeats an uncertain capture: %j', async (options) => {
    const h = harness(options);
    const rejected = expect(photoBoothTakePhoto.run({}, h.context)).rejects.toMatchObject({ code: 'input_unverified' });
    await vi.advanceTimersByTimeAsync(13_000);
    await rejected;
    expect(h.call.mock.calls.filter(([method]) => method === 'ax.click')).toHaveLength(1);
    expect(h.call.mock.calls.some(([method]) => method === 'keyboard.press')).toBe(false);
  });

  it('does not send the shutter shortcut if Photo Booth refuses activation', async () => {
    const h = harness({ activated: false });
    const result = photoBoothTakePhoto.run({}, h.context);
    const rejected = expect(result).rejects.toMatchObject({ code: 'not_frontmost' });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(h.call.mock.calls.some(([method]) => method === 'ax.click' || method === 'keyboard.press')).toBe(false);
  });

  it('does not send the shutter shortcut to another frontmost app', async () => {
    const h = harness({ frontmost: 'com.todesktop.230313mzl4w4u92' });
    const result = photoBoothTakePhoto.run({}, h.context);
    const rejected = expect(result).rejects.toMatchObject({ code: 'not_frontmost' });
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(h.call.mock.calls.some(([method]) => method === 'ax.click' || method === 'keyboard.press')).toBe(false);
  });
});
