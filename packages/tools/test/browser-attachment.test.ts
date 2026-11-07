import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AxElement, defaultSettings } from '@commandos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentControl, attachmentMenuControl, browserAttachFile, chatComposer, composerRegion, isQwenUrl, nativeFilePicker, resolveAttachmentPath } from '../src/browser-attachment';
import { visionLocateText } from '../src/vision';
import { type ToolContext } from '../src/types';

const CHROME = 'com.google.Chrome';
const url = 'https://chat.qwen.ai/c/existing-chat';
const el = (ref: string, role: string, text = '', extra: Partial<AxElement> = {}): AxElement => ({
  ref, role, subrole: null, title: text || null, label: null, value: null, identifier: null,
  description: null, placeholder: null, enabled: true, focused: false, frame: null, actions: [], depth: 0, childCount: 0, ...extra,
});

export function attachmentHarness(path: string, options: {
  uploadMs?: number; failUpload?: boolean; noPicker?: boolean; changeTab?: boolean;
  loseFocus?: boolean; noAttachment?: boolean; noFilename?: boolean; directPicker?: boolean;
  transientWindowReads?: number;
  iconLabel?: string; identifier?: string; noPlusButton?: boolean;
  menuLabel?: string; menuAlreadyOpen?: boolean; menuChildLabel?: boolean;
  standaloneGoTo?: boolean; hiddenExtension?: boolean; wrongSelectedFile?: boolean;
} = {}) {
  let phase = options.menuAlreadyOpen ? 'menu' : 'chat';
  let pathValue = '/old/path';
  let selectedAll = false;
  let uploadedAt = 0;
  let sent = 0;
  let transientWindowReads = options.transientWindowReads ?? 0;
  const base = () => [
    el('44:0', 'AXWindow', 'Qwen'), el('44:0.1', 'AXWebArea'),
    el('44:0.1.0', 'AXImage', 'Old chat image'),
    el('44:0.1.2', 'AXStaticText', 'A previous message mentioned upload failed'),
    el('44:0.1.3', 'AXGroup'), el('44:0.1.3.0', 'AXTextArea', 'Ask Qwen', { value: 'Existing unsent text', frame: options.noPlusButton ? { x: 100, y: 200, width: 300, height: 40 } : null }),
    ...(!options.noPlusButton ? [el('44:0.1.3.1', 'AXButton', options.iconLabel || options.identifier ? '' : '+', { identifier: options.identifier ?? null }), ...(options.iconLabel ? [el('44:0.1.3.1.0', 'AXImage', options.iconLabel)] : [])] : []),
    el('44:0.1.3.2', 'AXButton', 'Send'),
  ];
  const ui = () => {
    if (phase === 'goto' && options.standaloneGoTo) return [
      el('44:0.4', 'AXSheet', '', { identifier: 'GoToWindow' }),
      el('44:0.4.0', 'AXStaticText', 'Go to Folder'),
      el('44:0.4.1', 'AXButton', 'Close', { identifier: 'CloseButton' }),
      el('44:0.4.2', 'AXTextField', '', { identifier: 'PathTextField', value: pathValue }),
    ];
    if (['picker', 'goto', 'selected'].includes(phase)) return [
      el('44:0', 'AXWindow', 'Qwen'), el('44:0.2', 'AXSheet'),
      el('44:0.2.0', 'AXButton', 'Cancel'), el('44:0.2.1', 'AXButton', 'Open', { enabled: phase === 'selected' }),
      ...(phase === 'goto' ? [el('44:0.2.2', 'AXTextField', '', { value: pathValue })] : []),
      ...(phase === 'selected' ? [options.hiddenExtension
        ? el('44:0.2.3', 'AXImage', '', { identifier: options.wrongSelectedFile ? 'Photo on 10-16-26 at 10.12\u202fAM' : path.split('/').at(-1)!.replace(/\.[^.]+$/, '') })
        : el('44:0.2.3', 'AXStaticText', path.split('/').at(-1))] : []),
    ];
    const result = base();
    if (phase === 'menu') result.push(
      el('44:0.1.5', 'AXMenu'),
      ...(options.menuLabel ? [
        el('44:0.1.5.1', 'AXMenuItem', options.menuChildLabel ? '' : options.menuLabel),
        ...(options.menuChildLabel ? [el('44:0.1.5.1.0', 'AXStaticText', '', { value: options.menuLabel })] : []),
        el('44:0.1.5.2', 'AXMenuItem', 'Create Image'),
        el('44:0.1.5.3', 'AXMenuItem', 'Create Video'),
      ] : [el('44:0.1.5.0', 'AXMenuItem', 'Upload files'), el('44:0.1.5.1', 'AXMenuItem', 'Upload image')]),
      ...(options.noPicker ? [el('44:0.1.6.0', 'AXButton', 'Open'), el('44:0.1.6.1', 'AXButton', 'Cancel')] : []),
    );
    if (phase === 'upload') {
      if (options.failUpload) result.push(el('44:0.1.3.8', 'AXStaticText', 'Upload failed'));
      else if (!options.noAttachment) {
        result.push(el('44:0.1.3.4', 'AXImage', options.noFilename ? 'Image preview' : path.split('/').at(-1)));
        result.push(el('44:0.1.3.5', 'AXButton', 'Remove attachment'));
        if (Date.now() - uploadedAt < (options.uploadMs ?? 0)) result.push(el('44:0.1.3.6', 'AXProgressIndicator'));
      }
    }
    return result;
  };
  const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'osa.run') return { result: null, items: [options.changeTab && phase !== 'chat' && (params.source as string).includes('front window') && !(params.source as string).includes('chosenWindow') ? 'https://chat.qwen.ai/c/different-chat' : url, 'Qwen'] };
    if (method === 'apps.frontmost') return { app: { bundleId: options.loseFocus && phase === 'picker' ? 'com.apple.PhotoBooth' : CHROME } };
    if (method === 'ax.enableWeb') return { ok: true, code: 0 };
    if (method === 'ax.tree') {
      if (transientWindowReads > 0) { transientWindowReads--; throw new Error('ax.tree: com.google.Chrome has no accessible front window'); }
      return { elements: ui(), truncated: false };
    }
    if (method === 'ax.webText') return { title: 'Qwen', url, text: 'A previous message mentioned upload failed', found: true, truncated: false, nodes: 10, busy: false, progressIndicators: 0 };
    if (method === 'ax.focused') return { bundleId: CHROME, element: phase === 'goto' ? el(options.standaloneGoTo ? '44:0.4.2' : '44:0.2.2', 'AXTextField', '', { value: pathValue }) : null };
    if (method === 'ax.setValue') {
      if (phase !== 'goto' || params.ref !== (options.standaloneGoTo ? '44:0.4.2' : '44:0.2.2')) throw new Error('Setting text outside native path field');
      pathValue = String(params.value);
      return { ok: true, value: pathValue };
    }
    if (method === 'ax.press') {
      if (params.ref === '44:0.1.3.1') phase = phase === 'menu' ? 'chat' : options.directPicker ? 'picker' : 'menu';
      else if (params.ref === '44:0.1.5.1') { if (!options.noPicker) phase = 'picker'; }
      else if (params.ref === '44:0.2.1' && phase === 'selected') { phase = 'upload'; uploadedAt = Date.now(); }
      else if (params.ref === '44:0.1.3.2') sent++;
      else throw new Error(`Unexpected press: ${String(params.ref)} in ${phase}`);
      return { ok: true };
    }
    if (method === 'mouse.click') {
      if (options.noPlusButton && params.x === 73 && params.y === 220) phase = options.directPicker ? 'picker' : 'menu';
      else throw new Error(`Unexpected coordinate click: ${String(params.x)},${String(params.y)}`);
      return { ok: true };
    }
    if (method === 'keyboard.press') {
      if (params.key === 'g' && phase === 'picker') phase = 'goto';
      else if (params.key === 'a' && phase === 'goto') selectedAll = true;
      else if (params.key === 'return' && phase === 'goto' && pathValue === path) phase = 'selected';
      else { sent++; throw new Error(`Unexpected key in ${phase}`); }
      return { ok: true };
    }
    if (method === 'keyboard.type') {
      if (phase !== 'goto') throw new Error('Typing outside file picker');
      pathValue = selectedAll ? String(params.text) : pathValue + String(params.text);
      return { ok: true };
    }
    throw new Error(`Unexpected helper method: ${method}`);
  });
  const ctx: ToolContext = {
    runId: 'run_upload', taskId: 'attach', signal: new AbortController().signal, dryRun: false,
    settings: defaultSettings(), helper: { call } as unknown as ToolContext['helper'], models: null,
    providers: { get: async () => { throw new Error('unused'); } }, journal: { record: async () => {} },
    artifactsDir: '/tmp/commandos-attachment', log: () => {}, progress: () => {},
  };
  return { ctx, call, sent: () => sent };
}

let dir = '';
let path = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'commandos-upload-')); path = join(dir, 'Photo with spaces.jpg'); await writeFile(path, 'fixture'); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('Qwen attach-only flow', () => {
  it.each([
    { menuLabel: 'Upload attachment' },
    { menuLabel: 'Upload attachment file, image, video, audio' },
    { menuLabel: 'Upload attachment file, image, video, audio', menuChildLabel: true },
    { menuLabel: 'Upload attachment file, image, video, audio', menuAlreadyOpen: true },
    { menuLabel: 'Upload attachment file, image, video, audio', standaloneGoTo: true },
    { menuLabel: 'Upload attachment file, image, video, audio', standaloneGoTo: true, hiddenExtension: true },
  ])('recognizes Qwen’s actual upload menu and leaves the chat unsent: %j', async (options) => {
    vi.useFakeTimers();
    const h = attachmentHarness(path, options);
    const result = browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx);
    const settled = result.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await settled).toMatchObject({ value: { attached: true, submitted: false } });
    expect(h.call.mock.calls.filter(([m, p]) => m === 'ax.press' && p.ref === '44:0.1.5.1')).toHaveLength(1);
    if (options.menuAlreadyOpen) expect(h.call.mock.calls.some(([m, p]) => m === 'ax.press' && p.ref === '44:0.1.3.1')).toBe(false);
    expect(h.sent()).toBe(0);
  });

  it('does not mistake history, disabled uploads, creation actions or ambiguous menu items for the upload control', () => {
    const history = el('44:0.1.2', 'AXButton', 'Upload attachment');
    const menu = [el('44:0', 'AXWindow'), el('44:0.1', 'AXWebArea'), history, el('44:0.1.5', 'AXMenu')];
    const upload = el('44:0.1.5.1', 'AXMenuItem', 'Upload attachment file, image, video, audio');
    expect(attachmentMenuControl([...menu, upload])?.ref).toBe(upload.ref);
    expect(attachmentMenuControl(menu, menu)).toBeNull();
    expect(attachmentMenuControl([...menu, { ...upload, enabled: false }])).toBeNull();
    expect(attachmentMenuControl([...menu, { ...upload, title: 'Create Image' }])).toBeNull();
    expect(attachmentMenuControl([...menu, upload, { ...upload, ref: '44:0.1.5.2' }])).toBeNull();
    expect(attachmentMenuControl([...menu, { ...upload, title: 'Upload from computer and send message' }])).toBeNull();
  });

  it('attaches the exact Photo Booth timestamp when the supplied path omits the invisible AM/PM space', async () => {
    path = join(dir, 'Photo on 10-16-26 at 10.52\u202fAM.jpg');
    await writeFile(path, 'fixture');
    await writeFile(join(dir, 'Photo on 10-16-26 at 11.52\u202fAM.jpg'), 'different photo');
    vi.useFakeTimers();
    const h = attachmentHarness(path, { menuLabel: 'Upload attachment file, image, video, audio', standaloneGoTo: true, hiddenExtension: true });
    const result = browserAttachFile.run(browserAttachFile.args.parse({ path: path.replace('\u202f', '') }), h.ctx);
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ path, attached: true, submitted: false });
    expect(h.call).toHaveBeenCalledWith('ax.setValue', { ref: '44:0.4.2', value: path }, expect.anything());
    expect(h.sent()).toBe(0);
  });

  it('preserves an exact filename and refuses ambiguous timestamp matches', async () => {
    const narrow = join(dir, 'Photo on 10-16-26 at 10.52\u202fAM.jpg');
    const space = join(dir, 'Photo on 10-16-26 at 10.52 AM.jpg');
    await writeFile(narrow, 'first');
    await writeFile(space, 'second');
    expect(await resolveAttachmentPath(narrow)).toBe(narrow);
    await expect(resolveAttachmentPath(space.replace('52 AM', '52AM'))).rejects.toMatchObject({ code: 'upload_unverified', message: expect.stringContaining('Several') });
  });

  it('does not pick another photo or touch Chrome when the specified timestamp is missing', async () => {
    await writeFile(join(dir, 'Photo on 10-16-26 at 10.12\u202fAM.jpg'), 'different photo');
    const h = attachmentHarness(path);
    await expect(browserAttachFile.run(browserAttachFile.args.parse({ path: join(dir, 'Photo on 10-16-26 at 10.52AM.jpg') }), h.ctx)).rejects.toMatchObject({ code: 'upload_unverified' });
    expect(h.call).not.toHaveBeenCalled();
    expect(h.sent()).toBe(0);
  });

  it('does not follow a replacement filename symlink when resolving an omitted space', async () => {
    const link = join(dir, 'Photo on 10-16-26 at 10.52\u202fAM.jpg');
    await symlink(path, link);
    await expect(resolveAttachmentPath(link.replace('\u202f', ''))).rejects.toMatchObject({ code: 'upload_unverified' });
  });

  it.each([{ iconLabel: 'Add attachment' }, { iconLabel: 'Upload files and images' }, { identifier: 'chat-upload-button' }])('recognizes an icon-only attachment button: %j', async (options) => {
    vi.useFakeTimers();
    const h = attachmentHarness(path, options);
    const result = browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx);
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).submitted).toBe(false);
    expect(h.sent()).toBe(0);
  });

  it('finds a deeply nested composer without selecting a history or browser button', () => {
    const composer = el('44:0.1.3.0.0.0.0.0.0.0', 'AXTextArea', 'Ask Qwen');
    const target = el('44:0.1.3.1', 'AXButton', 'Add attachment');
    const history = el('44:0.1.2', 'AXButton', 'Upload');
    const elements = [el('44:0', 'AXWindow'), el('44:0.1', 'AXWebArea'), history, composer, target];
    expect(attachmentControl(composerRegion(elements, composer))?.ref).toBe(target.ref);
    expect(attachmentControl(composerRegion(elements.filter((e) => e !== target), composer))).toBeNull();
    expect(attachmentControl([target, el('44:0.1.3.2', 'AXButton', 'Upload image')])).toBeNull();
    expect(attachmentControl([el('44:0.1.3.2', 'AXButton', 'Send')])).toBeNull();
  });
  it('selects the existing chat, uploads through the native picker, verifies and leaves it unsent', async () => {
    vi.useFakeTimers();
    const h = attachmentHarness(path);
    const result = browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx);
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ attached: true, submitted: false, path, url });
    expect(h.sent()).toBe(0);
    expect(h.call).toHaveBeenCalledWith('ax.setValue', { ref: '44:0.2.2', value: path }, expect.anything());
    expect(h.call).toHaveBeenCalledWith('ax.tree', expect.objectContaining({ scope: 'window' }), expect.anything());
    expect(h.call.mock.calls.some(([m]) => /screen.capture|vision|mouse.click|workspace.open/.test(m))).toBe(false);
  });

  it('recovers when Chrome briefly has no accessible front window during activation', async () => {
    vi.useFakeTimers();
    const h = attachmentHarness(path, { transientWindowReads: 2 });
    const result = browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx);
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await result).submitted).toBe(false);
    expect(h.sent()).toBe(0);
  });

  it('uses the verified composer frame when Qwen omits its visible plus from Accessibility', async () => {
    vi.useFakeTimers();
    const h = attachmentHarness(path, { noPlusButton: true });
    const result = browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx);
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await result).submitted).toBe(false);
    expect(h.call).toHaveBeenCalledWith('mouse.click', { x: 73, y: 220, button: 'left', clicks: 1 }, expect.anything());
    expect(h.sent()).toBe(0);
  });

  it('waits for upload progress to finish, including when a preview appears immediately', async () => {
    vi.useFakeTimers();
    const h = attachmentHarness(path, { uploadMs: 4_000, noFilename: true, directPicker: true });
    let done = false;
    const result = browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx).then((r) => { done = true; return r; });
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await result).submitted).toBe(false);
    expect(h.sent()).toBe(0);
  });

  it('does not accept old chat images as evidence that an upload succeeded', async () => {
    vi.useFakeTimers();
    const h = attachmentHarness(path, { noAttachment: true });
    const failure = expect(browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx)).rejects.toMatchObject({ code: 'upload_unverified' });
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(21_000);
    await failure;
    expect(h.sent()).toBe(0);
    expect(h.call.mock.calls.filter(([m, p]) => m === 'ax.press' && p.ref === '44:0.2.1')).toHaveLength(1);
  });

  it('stops on a reported upload failure without retrying or sending', async () => {
    const h = attachmentHarness(path, { failUpload: true });
    await expect(browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx)).rejects.toMatchObject({ code: 'upload_unverified' });
    expect(h.sent()).toBe(0);
  });

  it('never types a path into a web dialog masquerading as a file picker', async () => {
    vi.useFakeTimers();
    const h = attachmentHarness(path, { noPicker: true });
    const failure = expect(browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx)).rejects.toMatchObject({ code: 'upload_unverified' });
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3_000);
    await failure;
    expect(h.call.mock.calls.some(([m]) => m === 'ax.setValue' || m === 'keyboard.type' || m === 'keyboard.press')).toBe(false);
  });

  it('does not open a different image when the native picker hides extensions', async () => {
    vi.useFakeTimers();
    const h = attachmentHarness(path, { hiddenExtension: true, wrongSelectedFile: true });
    const failure = expect(browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx)).rejects.toMatchObject({ code: 'upload_unverified' });
    await vi.waitFor(() => expect(h.call).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(4_000);
    await failure;
    expect(h.call.mock.calls.some(([m, p]) => m === 'ax.press' && p.ref === '44:0.2.1')).toBe(false);
    expect(h.sent()).toBe(0);
  });

  it.each([{ changeTab: true }, { loseFocus: true }])('stops if the destination or keyboard focus changes: %j', async (options) => {
    const h = attachmentHarness(path, options);
    await expect(browserAttachFile.run(browserAttachFile.args.parse({ path }), h.ctx)).rejects.toMatchObject({ code: 'upload_unverified' });
    expect(h.call.mock.calls.some(([m]) => m === 'ax.setValue' || m === 'keyboard.type')).toBe(false);
    expect(h.sent()).toBe(0);
  });

  it('rejects misleading hosts, paths with newlines and ambiguous composers', () => {
    expect(isQwenUrl(url)).toBe(true);
    expect(isQwenUrl('https://chat.qwen.ai.evil.example/')).toBe(false);
    expect(isQwenUrl('https://user@chat.qwen.ai/')).toBe(false);
    expect(browserAttachFile.args.safeParse({ path: '/tmp/photo.jpg\n' }).success).toBe(false);
    expect(chatComposer([el('44:0.1', 'AXTextArea'), el('44:0.2', 'AXTextArea')])).toBeNull();
    expect(nativeFilePicker([el('44:0.1', 'AXButton', 'Open'), el('44:0.2', 'AXButton', 'Cancel')])).toBeNull();
    expect(nativeFilePicker([el('44:0.1', 'AXWebArea'), el('44:0.1.2', 'AXDialog'), el('44:0.1.2.0', 'AXButton', 'Cancel')])).toBeNull();
    expect(nativeFilePicker([el('44:0.1', 'AXWebArea'), el('44:0.1.2', 'AXSheet', '', { identifier: 'GoToWindow' }), el('44:0.1.2.0', 'AXTextField', '', { identifier: 'PathTextField' })])).toBeNull();
  });
});

describe('window capture after Photo Booth takes focus', () => {
  it('activates the requested app and retries an on-screen-window miss once', async () => {
    vi.useFakeTimers();
    const h = attachmentHarness(path);
    let captures = 0;
    h.call.mockImplementation(async (method) => {
      if (method === 'apps.activate') return { activated: true };
      if (method === 'screen.capture') { if (++captures === 1) throw new Error('screen.capture: no on-screen window for the requested app'); return { path: '/tmp/capture.png', frame: { x: 0, y: 0, width: 1000, height: 800 } }; }
      if (method === 'vision.ocr') return { lines: [{ text: 'Upload file', confidence: 1, box: [0, 0, 0.1, 0.1] }] };
      throw new Error(method);
    });
    const result = visionLocateText.run({ text: 'Upload file', bundleId: CHROME }, h.ctx);
    await vi.advanceTimersByTimeAsync(250);
    expect((await result).found).toBe(true);
    expect(h.call.mock.calls.map(([method]) => method)).toEqual(['apps.activate', 'screen.capture', 'screen.capture', 'vision.ocr']);
  });
});
