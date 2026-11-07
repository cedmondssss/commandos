import { defaultSettings } from '@commandos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserReadPage, matchesPageUrl } from '../src/browserpage';
import { gmailCompose, gmailSend } from '../src/gmail';
import { delay } from '../src/poll';
import { type ToolContext } from '../src/types';

const frame = { x: 0, y: 0, width: 1000, height: 800 };
const page = (text = 'Short page', extra: Record<string, unknown> = {}) => ({
  title: 'Fixture',
  url: 'https://example.com/',
  text,
  found: true,
  truncated: false,
  nodes: 4,
  ...extra,
});
function context(call: (method: string, params: Record<string, unknown>) => Promise<unknown>): ToolContext {
  return {
    runId: 'run_latency',
    taskId: 'task',
    signal: new AbortController().signal,
    dryRun: false,
    settings: { ...defaultSettings(), userEmail: 'me@example.com' },
    helper: { call: vi.fn(call) } as unknown as ToolContext['helper'],
    models: null,
    providers: {
      get: async () => {
        throw new Error('not used');
      },
    },
    journal: { record: async () => {} },
    artifactsDir: '/tmp/commandos-latency',
    log: () => {},
    progress: () => {},
  };
}

afterEach(() => vi.useRealTimers());

describe('browser latency and readiness', () => {
  it('returns a short loaded page immediately instead of polling for 15 seconds', async () => {
    const ctx = context(async () => page());
    const result = await browserReadPage.run(browserReadPage.args.parse({ scrollPages: 0 }), ctx);
    expect(result.text).toBe('Short page');
    expect(ctx.helper.call).toHaveBeenCalledTimes(2);
  });

  it('waits for the requested URL instead of answering from the previous tab', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const ctx = context(async (method) =>
      method === 'ax.enableWeb' ? { ok: true } : page('Correct page', { url: ++reads > 1 ? 'https://example.com/new' : 'https://example.com/old' }),
    );
    const result = browserReadPage.run(browserReadPage.args.parse({ expectedUrl: 'https://example.com/new', scrollPages: 0 }), ctx);
    await vi.advanceTimersByTimeAsync(150);
    expect((await result).url).toBe('https://example.com/new');
    expect(reads).toBe(2);
    expect(matchesPageUrl('https://luma.com/home', 'https://lu.ma/home')).toBe(true);
    expect(matchesPageUrl('https://example.com.evil/home', 'https://example.com/home')).toBe(false);
  });

  it('waits for asynchronous form validation and matches text split across accessibility nodes', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const ctx = context(async (method) => method === 'ax.enableWeb' ? { ok: true } :
      page(++reads > 1 ? 'HackBU\nis available.' : 'Checking HackBU…', { url: 'https://github.com/new' }));
    const waiting = browserReadPage.run(browserReadPage.args.parse({ expectedUrl: 'https://github.com/new', waitForText: 'HackBU is available', scrollPages: 0 }), ctx);
    await vi.advanceTimersByTimeAsync(150);
    expect((await waiting).text).toBe('HackBU\nis available.');
    expect(reads).toBe(2);
  });

  it('retains delayed lazy-loaded content and finishes early once it settles', async () => {
    vi.useFakeTimers();
    let scrollAt: number | null = null;
    const ctx = context(async (method) => {
      if (method === 'keyboard.press') scrollAt = Date.now();
      return page(scrollAt !== null && Date.now() - scrollAt >= 600 ? 'Event A\nEvent B' : 'Event A');
    });
    const start = Date.now();
    const result = browserReadPage.run(browserReadPage.args.parse({ scrollPages: 1 }), ctx);
    await vi.advanceTimersByTimeAsync(900);
    expect((await result).text).toBe('Event A\nEvent B');
    expect(Date.now() - start).toBe(900);
  });

  it('preserves equal-length virtualized rows and does not remove repeated original text', async () => {
    vi.useFakeTimers();
    let scrolled = false;
    const ctx = context(async (method) => {
      if (method === 'keyboard.press') scrolled = true;
      return page(scrolled ? 'Event B\nOct 16' : 'Event A\nOct 16\nOct 16');
    });
    const result = browserReadPage.run(browserReadPage.args.parse({ scrollPages: 1 }), ctx);
    await vi.advanceTimersByTimeAsync(400);
    expect((await result).text).toBe('Event A\nOct 16\nOct 16\nEvent B');
    expect((await result).truncated).toBe(true); // scroll budget exhausted, so never claim a full count
  });

  it('fails when the requested text never arrives, and cancels polling promptly', async () => {
    vi.useFakeTimers();
    const ctx = context(async () => page());
    const result = browserReadPage.run(browserReadPage.args.parse({ waitForText: 'Missing', scrollPages: 0 }), ctx);
    const failed = expect(result).rejects.toMatchObject({ code: 'page_not_ready' });
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    const controller = new AbortController();
    const waiting = delay(10_000, controller.signal);
    const stopped = expect(waiting).rejects.toThrow('stopped');
    controller.abort(new Error('stopped'));
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });
});

function gmailContext(options: {
  uploadMs?: number; failUpload?: boolean; wrongDraft?: boolean; noComposeTitle?: boolean; progressOnly?: boolean; oldHelper?: boolean;
  wrongRecipient?: boolean; wrongBody?: boolean; ambiguousSend?: boolean; noSendAck?: boolean; pressThrows?: boolean;
  sentText?: string; staleSentBanner?: boolean; navigatedAfterSend?: boolean; noPressAction?: boolean;
  closeAfterSend?: boolean; noSentReceipt?: boolean; wrongSentSubject?: boolean; staleSentQuery?: boolean;
  attachmentControl?: boolean; imagesUnchanged?: boolean;
} = {}) {
  let pastedAt: number | null = null;
  let sent = false;
  let sentSearchUrl: string | null = null;
  const ctx = context(async (method, params) => {
    if (method === 'workspace.open' && String(params.url).includes('#search/')) {
      sentSearchUrl = String(params.url);
      return { opened: true };
    }
    if (method === 'ax.tree') {
      const el = (ref: string, role: string, label: string, value: string | null = null) => ({
        ref, role, label, title: null, description: null, value, enabled: true, frame,
        actions: options.noPressAction ? [] : ['AXPress'],
      });
      if (sentSearchUrl && options.closeAfterSend) return { truncated: false, elements: [
        el('1:0', 'AXWindow', 'Search results'), el('1:0.1', 'AXWebArea', 'Gmail'),
        el('1:0.1.0', 'AXTextField', 'Search mail', 'Photo'),
        ...(!options.noSentReceipt ? [el('1:0.1.1', 'AXRow', 'me, Photo, 1:06 PM'),
          el('1:0.1.1.0', 'AXStaticText', '', options.wrongSentSubject ? 'Old unrelated email' : 'Photo')] : []),
      ] };
      return { truncated: false, elements: [
        el('1:0', 'AXWindow', 'Compose Mail'), el('1:0.1', 'AXWebArea', 'Gmail'),
        el('1:0.1.0', 'AXStaticText', 'Recipient', options.wrongRecipient ? 'Someone Else (other@example.com)' : 'Me (me@example.com)'),
        el('1:0.1.1', 'AXTextField', 'Subject', options.wrongDraft ? 'Wrong message' : 'Photo'),
        el('1:0.1.2', 'AXTextArea', 'Message Body', options.wrongBody ? 'Unapproved extra text' : '\u200b\n\u200b'),
        el('1:0.1.3', 'AXButton', 'Send \u202a(⌘Enter)\u202c'),
        el('1:0.1.4', 'AXButton', 'More send options'),
        ...(options.attachmentControl && pastedAt !== null ? [el('1:0.1.5', 'AXButton', 'Remove attachment')] : []),
        ...(options.ambiguousSend ? [el('1:0.1.6', 'AXButton', 'Send')] : []),
      ] };
    }
    if (method === 'ax.find')
      return { elements: [{ title: sent ? 'Inbox - me@example.com - Gmail' : options.noComposeTitle ? 'Gmail' : 'Compose Mail - me@example.com - Gmail', frame }] };
    if (options.oldHelper && ['ax.enableWeb', 'ax.webText'].includes(method)) throw new Error('unknown_method');
    if (method === 'ax.enableWeb') return { ok: true, code: 0 };
    if (method === 'ax.webText') {
      if (sentSearchUrl && options.closeAfterSend) return page('Search results\nPhoto', { url: options.staleSentQuery ? 'https://mail.google.com/mail/u/0/#search/in%3Asent' : sentSearchUrl });
      const uploading = pastedAt !== null && Date.now() - pastedAt < (options.uploadMs ?? 0);
      return page(
        sent
          ? (options.sentText ?? 'Message sent')
          : options.failUpload && pastedAt !== null
            ? 'Upload failed'
            : `Send\n${options.wrongDraft ? 'Wrong message' : 'Photo'}${uploading && !options.progressOnly ? '\nUploading' : ''}${options.staleSentBanner ? '\nMessage sent' : ''}`,
        {
          title: 'Gmail',
          url: sent && (options.navigatedAfterSend || options.closeAfterSend) ? 'https://example.com/' : 'https://mail.google.com/mail/u/0/?to=me%40example.com',
          images: pastedAt === null || options.imagesUnchanged ? 1 : 2,
          busy: uploading && !options.progressOnly,
          progressIndicators: uploading ? 1 : 0,
        },
      );
    }
    if (method === 'keyboard.press') {
      if (params.key === 'v') pastedAt = Date.now();
      if (params.key === 'return') sent = true;
    }
    if (method === 'ax.press' || (method === 'mouse.click' && options.noPressAction)) {
      if (options.pressThrows) throw new Error('helper acknowledgement lost');
      if (!options.noSendAck) sent = true;
      return { ok: true };
    }
    if (method === 'screen.capture') throw new Error('Screen Recording unavailable');
    return { opened: true, activated: true, result: null, items: [] };
  });
  return ctx;
}

describe('Gmail readiness without fixed waits or screen capture', () => {
  const compose = gmailCompose.args.parse({ to: 'me', subject: 'Photo', body: '', attachments: ['/tmp/photo.png'] });

  it('finishes a ready attachment in 300 ms instead of the fixed three-second sleep', async () => {
    vi.useFakeTimers();
    const ctx = gmailContext();
    const result = gmailCompose.run(compose, ctx);
    await vi.advanceTimersByTimeAsync(300);
    expect((await result).attached).toEqual(['/tmp/photo.png']);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.helper.call).not.toHaveBeenCalledWith('screen.capture', expect.anything(), expect.anything());
  });

  it('keeps waiting for a slow upload instead of sending after three seconds', async () => {
    vi.useFakeTimers();
    const ctx = gmailContext({ uploadMs: 4_000, progressOnly: true });
    let finished = false;
    const result = gmailCompose.run(compose, ctx).then((r) => {
      finished = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1_300);
    expect((await result).attached).toEqual(['/tmp/photo.png']);
  });

  it('verifies a pasted image from its new attachment control when Chrome omits it from the image count', async () => {
    vi.useFakeTimers();
    const ctx = gmailContext({ attachmentControl: true, imagesUnchanged: true });
    const result = gmailCompose.run(compose, ctx);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).attached).toEqual(['/tmp/photo.png']);
    expect(ctx.helper.call).toHaveBeenCalledWith('ax.tree', expect.objectContaining({ scope: 'window' }), expect.anything());
  });

  it('keeps the existing three-second fallback for older helpers without page metadata', async () => {
    vi.useFakeTimers();
    const result = gmailCompose.run(compose, gmailContext({ oldHelper: true }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await result).attached).toEqual(['/tmp/photo.png']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops immediately on a failed upload and leaves the draft unsent', async () => {
    vi.useFakeTimers();
    const ctx = gmailContext({ failUpload: true });
    await expect(gmailCompose.run(compose, ctx)).rejects.toMatchObject({ code: 'upload_unverified' });
    expect(ctx.helper.call).not.toHaveBeenCalledWith('keyboard.press', { key: 'return', modifiers: ['command'] }, expect.anything());
  });

  it('checks the exact draft and confirms sending with AX when screen capture is unavailable', async () => {
    const ctx = gmailContext();
    const result = await gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx);
    expect(result.sent).toBe(true);
    expect(ctx.helper.call).toHaveBeenCalledWith('ax.press', { ref: '1:0.1.3' }, expect.anything());
    expect(ctx.helper.call).not.toHaveBeenCalledWith('keyboard.press', expect.anything(), expect.anything());
    expect(ctx.helper.call).not.toHaveBeenCalledWith('screen.capture', expect.anything(), expect.anything());
  });

  it('also handles a ready draft whose window title does not say Compose', async () => {
    const ctx = gmailContext({ noComposeTitle: true });
    expect((await gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx)).confirmation).toMatch(/confirmed/);
  });

  it('refuses a different draft before pressing Send', async () => {
    const ctx = gmailContext({ wrongDraft: true });
    await expect(gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx)).rejects.toMatchObject({ code: 'precondition' });
    expect(ctx.helper.call).not.toHaveBeenCalledWith('keyboard.press', expect.anything(), expect.anything());
    expect(ctx.helper.call).not.toHaveBeenCalledWith('ax.press', expect.anything(), expect.anything());
  });

  it.each([{ wrongRecipient: true }, { wrongBody: true }, { ambiguousSend: true }])('refuses an unapproved or ambiguous draft before sending: %j', async (options) => {
    const ctx = gmailContext(options);
    await expect(gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx)).rejects.toMatchObject({ code: 'precondition' });
    expect(ctx.helper.call).not.toHaveBeenCalledWith('ax.press', expect.anything(), expect.anything());
    expect(ctx.helper.call).not.toHaveBeenCalledWith('mouse.click', expect.anything(), expect.anything());
  });

  it.each(['Your message has been sent.', 'Message was sent', 'Message sent Undo View message'])('recognizes Gmail’s sent acknowledgement: %s', async (sentText) => {
    expect((await gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, gmailContext({ sentText }))).sent).toBe(true);
  });

  it('clicks the verified button frame once when AXPress is unavailable', async () => {
    const ctx = gmailContext({ noPressAction: true });
    expect((await gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx)).sent).toBe(true);
    expect(ctx.helper.call).toHaveBeenCalledWith('mouse.click', expect.objectContaining({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }), expect.anything());
    expect(ctx.helper.call).not.toHaveBeenCalledWith('keyboard.press', expect.anything(), expect.anything());
  });

  it.each([{ noSendAck: true }, { staleSentBanner: true }, { navigatedAfterSend: true }])('does not send again or claim success without a fresh acknowledgement: %j', async (options) => {
    vi.useFakeTimers();
    const ctx = gmailContext(options);
    const failure = expect(gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx)).rejects.toMatchObject({ code: 'send_unverified' });
    await vi.advanceTimersByTimeAsync(8_000);
    await failure;
    expect(vi.mocked(ctx.helper.call).mock.calls.filter(([method]) => method === 'ax.press')).toHaveLength(1);
    expect(ctx.helper.call).not.toHaveBeenCalledWith('mouse.click', expect.anything(), expect.anything());
    expect(ctx.helper.call).not.toHaveBeenCalledWith('keyboard.press', expect.anything(), expect.anything());
    expect(ctx.helper.call).not.toHaveBeenCalledWith('screen.capture', expect.anything(), expect.anything());
  });

  it('does not click again after the send RPC loses its acknowledgement', async () => {
    const ctx = gmailContext({ pressThrows: true });
    await expect(gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx)).rejects.toMatchObject({ code: 'send_unverified' });
    expect(vi.mocked(ctx.helper.call).mock.calls.filter(([method]) => method === 'ax.press')).toHaveLength(1);
    expect(ctx.helper.call).not.toHaveBeenCalledWith('mouse.click', expect.anything(), expect.anything());
  });

  it('verifies the new message in Sent when the full-page compose tab closes without a banner', async () => {
    const ctx = gmailContext({ closeAfterSend: true });
    const started = Date.now();
    expect((await gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx)).confirmation).toContain('Gmail Sent');
    const opened = vi.mocked(ctx.helper.call).mock.calls.find(([method]) => method === 'workspace.open')!;
    const url = new URL((opened[1] as { url: string }).url);
    expect(url.pathname).toBe('/mail/u/0/');
    expect(url.search).toBe(''); // never carries draft/to/body parameters into the search page
    const query = decodeURIComponent(url.hash.slice(8));
    expect(query).toMatch(/^in:sent to:me@example.com after:\d+$/);
    const after = Number(query.split('after:')[1]);
    expect(after).toBeGreaterThanOrEqual(Math.floor(started / 1000) - 1);
    expect(after).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 1);
    expect(vi.mocked(ctx.helper.call).mock.calls.filter(([method]) => method === 'ax.press')).toHaveLength(1);
  });

  it.each([{ noSentReceipt: true }, { wrongSentSubject: true }, { staleSentQuery: true }])('does not mistake a query, old page or unrelated result for a sent receipt: %j', async (options) => {
    vi.useFakeTimers();
    const ctx = gmailContext({ closeAfterSend: true, ...options });
    const failure = expect(gmailSend.run({ to: 'me@example.com', subject: 'Photo', body: '' }, ctx)).rejects.toMatchObject({ code: 'send_unverified' });
    await vi.advanceTimersByTimeAsync(8_000);
    await failure;
    expect(vi.mocked(ctx.helper.call).mock.calls.filter(([method]) => method === 'ax.press')).toHaveLength(1);
  });
});
