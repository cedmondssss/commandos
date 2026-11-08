import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type AxElement, defaultSettings, HelperMethods, type HelperMethodName } from '@commandos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gmailCompose } from '../src/gmail';
import type { ToolContext } from '../src/types';

const CHROME = 'com.google.Chrome';
const el = (ref: string, role: string, label = '', extra: Partial<AxElement> = {}): AxElement => ({
  ref, role, label, title: null, description: null, subrole: null, value: null, identifier: null, placeholder: null,
  enabled: true, focused: false, frame: null, actions: [], depth: 0, childCount: 0, ...extra,
});

function harness(path: string, options: {
  uploadMs?: number; failUpload?: boolean; noAttachment?: boolean; normalSpaces?: boolean;
  noPicker?: boolean; wrongPath?: boolean; wrongFile?: boolean; hiddenExtension?: boolean;
  loseFocus?: boolean; changeTab?: boolean; oldHelper?: boolean; openAckLost?: boolean;
  existingFilename?: boolean; truncated?: boolean; body?: string;
  pageReadyMs?: number; initialPageState?: 'unavailable' | 'busy' | 'truncated' | 'missing-metadata';
  postUploadUnavailableMs?: number;
} = {}) {
  let phase = 'compose';
  let pathValue = '';
  let url = '';
  let openedAt = 0;
  let uploadedAt = 0;
  let uploads = 0;
  let sends = 0;
  const uploading = () => phase === 'upload' && Date.now() - uploadedAt < (options.uploadMs ?? 0);
  const labelName = options.normalSpaces ? basename(path).replace(/\s/g, ' ') : basename(path);
  const tree = () => {
    if (phase === 'goto') return [
      el('1:0.3', 'AXSheet', '', { identifier: 'GoToWindow' }),
      el('1:0.3.0', 'AXButton', 'Close'),
      el('1:0.3.1', 'AXTextField', '', { identifier: 'PathTextField', value: pathValue }),
    ];
    if (phase === 'picker' || phase === 'selected') return [
      el('1:0.2', 'AXSheet', '', { identifier: 'open-panel' }),
      el('1:0.2.0', 'AXButton', 'Cancel'),
      el('1:0.2.1', 'AXButton', 'Open', { enabled: phase === 'selected' }),
      ...(phase === 'selected' ? [el('1:0.2.2', 'AXImage', '', {
        identifier: options.wrongFile ? 'Different photo.jpg' : options.hiddenExtension ? basename(path).replace(/\.[^.]+$/, '') : basename(path),
      })] : []),
    ];
    return [
      el('1:0', 'AXWindow', 'Compose Mail'), el('1:0.1', 'AXWebArea', 'Gmail'),
      el('1:0.1.0', 'AXTextField', 'Subject', { value: 'Photo' }),
      el('1:0.1.1', 'AXTextArea', 'Message Body', { value: options.body ?? (options.existingFilename ? labelName : '') }),
      el('1:0.1.2', 'AXButton', 'Send'), el('1:0.1.3', 'AXPopUpButton', 'Attach files'),
      // A page button styled as a picker must never receive an attachment path.
      ...(options.noPicker ? [el('1:0.1.7', 'AXDialog'), el('1:0.1.7.0', 'AXButton', 'Cancel'), el('1:0.1.7.1', 'AXButton', 'Open')] : []),
      ...(phase === 'upload' && options.failUpload ? [el('1:0.1.4', 'AXStaticText', 'Upload failed')] : []),
      ...(phase === 'upload' && !options.noAttachment && !options.failUpload ? [
        el('1:0.1.5', 'AXLink', `${labelName} (123 KB)`),
        el('1:0.1.6', 'AXButton', 'Remove attachment'),
      ] : []),
      ...(uploading() ? [el('1:0.1.8', 'AXProgressIndicator')] : []),
    ];
  };
  const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    // Exercise the real RPC parameter limits; a permissive mock hid maxNodes: 12000.
    HelperMethods[method as HelperMethodName].params.parse(params);
    if (method === 'workspace.open') { url = String(params.url); openedAt = Date.now(); return { opened: true }; }
    if (method === 'apps.activate') return { activated: true };
    if (method === 'apps.frontmost') return { app: { bundleId: options.loseFocus && phase === 'picker' ? 'com.apple.PhotoBooth' : CHROME } };
    if (method === 'osa.run') return { items: [options.changeTab && phase === 'picker' ? 'https://example.com/' : url], result: null };
    if (method === 'ax.find') return { elements: [el('1:0', 'AXWindow', '', { title: 'Compose Mail - me@example.com - Gmail' })] };
    if (method === 'ax.enableWeb') return { ok: true, code: 0 };
    if (method === 'ax.webText') {
      if (options.oldHelper) throw new Error('unknown_method');
      const notReady = phase === 'compose' && Date.now() - openedAt < (options.pageReadyMs ?? 0);
      if ((notReady && options.initialPageState === 'unavailable')
        || (phase === 'upload' && Date.now() - uploadedAt < (options.postUploadUnavailableMs ?? 0))) {
        return { title: 'Compose Mail', url: null, text: '', found: false, truncated: false, nodes: 1 };
      }
      return { title: 'Compose Mail', url, text: 'Send\nPhoto', found: true, truncated: false, nodes: 10,
        images: 1, busy: notReady && options.initialPageState === 'busy', progressIndicators: uploading() ? 1 : 0,
        ...(notReady && options.initialPageState === 'truncated' ? { truncated: true } : {}),
        ...(notReady && options.initialPageState === 'missing-metadata' ? { busy: undefined, progressIndicators: undefined } : {}),
      };
    }
    if (method === 'ax.tree') return { elements: tree(), truncated: options.truncated ?? false };
    if (method === 'ax.click' && params.text === 'Attach files') {
      if (!options.noPicker) phase = 'picker';
      return { clicked: true };
    }
    if (method === 'ax.focused') return { bundleId: CHROME, element: phase === 'goto' ? tree()[2] : null };
    if (method === 'ax.setValue' && phase === 'goto' && params.ref === '1:0.3.1') {
      pathValue = options.wrongPath ? 'Incorrect path' : String(params.value);
      return { ok: true, value: pathValue };
    }
    if (method === 'keyboard.press') {
      if (phase === 'picker' && params.key === 'g') { phase = 'goto'; return { ok: true }; }
      if (phase === 'goto' && params.key === 'return') { phase = 'selected'; return { ok: true }; }
      sends++;
      throw new Error('Unexpected keyboard action outside the native picker');
    }
    if (method === 'ax.press' && phase === 'selected' && params.ref === '1:0.2.1') {
      phase = 'upload'; uploadedAt = Date.now(); uploads++;
      if (options.openAckLost) throw new Error('RPC acknowledgement lost after Open');
      return { ok: true };
    }
    throw new Error(`Unexpected helper method: ${method}`);
  });
  const ctx: ToolContext = {
    runId: 'gmail_attachment', taskId: 'compose', signal: new AbortController().signal, dryRun: false,
    settings: { ...defaultSettings(), userEmail: 'me@example.com' }, helper: { call } as unknown as ToolContext['helper'],
    models: null, providers: { get: async () => { throw new Error('unused'); } }, journal: { record: async () => {} },
    artifactsDir: '/tmp/commandos-gmail-test', log: () => {}, progress: () => {},
  };
  return { ctx, call, body: options.body ?? '', uploads: () => uploads, sends: () => sends };
}

let dir = '';
let path = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commandos-gmail-'));
  path = join(dir, 'Photo on 11-7-26 at 8.18\u202fPM.jpg');
  await writeFile(path, 'test image');
});
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
const args = (body = '') => gmailCompose.args.parse({ to: 'me', subject: 'Photo', body, attachments: [path] });

async function settle(h: ReturnType<typeof harness>, ms = 25_000) {
  const result = gmailCompose.run(args(h.body), h.ctx).then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.waitFor(() => expect(h.call).toHaveBeenCalledWith('apps.activate', expect.anything(), expect.anything()));
  await vi.advanceTimersByTimeAsync(ms);
  return result;
}

describe('Gmail photo attachment through the native picker', () => {
  it.each(['unavailable', 'busy', 'truncated', 'missing-metadata'] as const)('waits for a %s compose page before attempting the attachment', async (initialPageState) => {
    vi.useFakeTimers();
    const h = harness(path, { pageReadyMs: 2_000, initialPageState });
    let finished = false;
    const result = gmailCompose.run(args(), h.ctx).then((value) => ({ value }), (error: unknown) => ({ error })).finally(() => { finished = true; });
    await vi.waitFor(() => expect(h.call).toHaveBeenCalledWith('apps.activate', expect.anything(), expect.anything()));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.uploads()).toBe(0);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await result).toMatchObject({ value: { attached: [path] } });
    expect(h.uploads()).toBe(1);
    expect(h.sends()).toBe(0);
  });

  it('rechecks temporarily unavailable upload evidence without attaching the file again', async () => {
    vi.useFakeTimers();
    const h = harness(path, { postUploadUnavailableMs: 2_000 });
    expect(await settle(h, 2_500)).toMatchObject({ value: { attached: [path] } });
    expect(h.uploads()).toBe(1);
    expect(h.sends()).toBe(0);
  });

  it.each([{ normalSpaces: true }, { hiddenExtension: true }])('attaches the exact Photo Booth file without relying on image counts: %j', async (options) => {
    vi.useFakeTimers();
    const h = harness(path, options);
    expect(await settle(h, 500)).toMatchObject({ value: { attached: [path] } });
    expect(h.call).toHaveBeenCalledWith('ax.setValue', { ref: '1:0.3.1', value: path }, expect.anything());
    expect(h.uploads()).toBe(1);
    expect(h.sends()).toBe(0);
    expect(h.call.mock.calls.some(([method]) => ['mouse.click', 'screen.capture', 'keyboard.type'].includes(method))).toBe(false);
  });

  it('waits for upload completion even after the filename appears', async () => {
    vi.useFakeTimers();
    const h = harness(path, { uploadMs: 4_000 });
    let finished = false;
    const result = gmailCompose.run(args(), h.ctx).then((value) => { finished = true; return value; });
    await vi.waitFor(() => expect(h.uploads()).toBe(1));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1_400);
    expect((await result).attached).toEqual([path]);
    expect(h.sends()).toBe(0);
  });

  it('does not confuse the message body with upload status', async () => {
    vi.useFakeTimers();
    const h = harness(path, { body: 'The previous upload failed. Attaching a new photo.' });
    expect(await settle(h, 500)).toMatchObject({ value: { attached: [path] } });
    expect(h.sends()).toBe(0);
  });

  it.each([
    { failUpload: true }, { noAttachment: true }, { noAttachment: true, existingFilename: true },
    { noPicker: true }, { wrongPath: true }, { wrongFile: true }, { loseFocus: true }, { changeTab: true },
    { oldHelper: true }, { truncated: true },
  ])('leaves the draft unsent when the attachment cannot be verified: %j', async (options) => {
    vi.useFakeTimers();
    const h = harness(path, options);
    expect(await settle(h)).toMatchObject({ error: { code: 'upload_unverified' } });
    expect(h.sends()).toBe(0);
    if (options.wrongPath || options.wrongFile || options.loseFocus || options.changeTab || options.noPicker || options.oldHelper || options.truncated) expect(h.uploads()).toBe(0);
  });

  it('does not retry an upload after losing the Open acknowledgement', async () => {
    vi.useFakeTimers();
    const h = harness(path, { openAckLost: true });
    expect(await settle(h)).toMatchObject({ error: { code: 'upload_unverified' } });
    expect(h.uploads()).toBe(1);
    expect(h.sends()).toBe(0);
  });
});
