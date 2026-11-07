import { randomBytes } from 'node:crypto';
import { agentTask, connectBrowser, createAnchorbrowserClient, Sessions } from 'anchorbrowser';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { redactText } from './redaction';

/**
 * Injected into every page CommandOS drives. Form submissions (submit events, Enter in a field,
 * form.submit()/requestSubmit()) are blocked and recorded unless CommandOS explicitly allows one
 * after user approval. Ordinary fetch/XHR traffic is untouched: actions are classified by what
 * they do, not by HTTP method.
 */
export const SUBMIT_GUARD = `(() => {
  // bundlers running with keepNames wrap named functions in __name(); make it a no-op in pages
  if (typeof window.__name !== 'function') Object.defineProperty(window, '__name', { value: (fn) => fn, configurable: true, writable: true });
  if (window.__commandosGuard) return;
  const guard = { allowSubmit: false, blocked: [] };
  Object.defineProperty(window, '__commandosGuard', { value: guard, configurable: false });
  const record = (form, via) => guard.blocked.push({ via, action: form && form.action || null, at: Date.now() });
  document.addEventListener('submit', (e) => {
    if (guard.allowSubmit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    record(e.target, 'submit-event');
  }, true);
  const proto = HTMLFormElement.prototype;
  const origSubmit = proto.submit;
  proto.submit = function () { if (!guard.allowSubmit) { record(this, 'form.submit'); return; } return origSubmit.call(this); };
  const origRequest = proto.requestSubmit;
  if (origRequest) proto.requestSubmit = function (s) { if (!guard.allowSubmit) { record(this, 'form.requestSubmit'); return; } return origRequest.call(this, s); };
})();`;

export interface BrowserSession {
  id: string;
  kind: 'anchor' | 'local';
  runId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  anchorSessionId?: string;
  liveViewUrl?: string;
  createdAt: number;
}

/**
 * Browser sessions for web tools. `anchor` sessions run in Anchor Browser's cloud (driven over
 * CDP with Playwright); they never control the browser on this Mac. `local` sessions launch a
 * separate Chromium controlled by Playwright.
 */
export class BrowserHub {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly anchorSessions = new Map<string, string>();
  private readonly closing = new Map<string, Promise<boolean>>();
  private anchorClient: ReturnType<typeof createAnchorbrowserClient> | null = null;

  constructor(private readonly anchorApiKey: () => Promise<string | null>) {}

  private async anchor() {
    if (this.anchorClient) return this.anchorClient;
    const key = await this.anchorApiKey();
    if (!key) throw Object.assign(new Error('ANCHORBROWSER_API_KEY is not configured'), { code: 'missing_credentials' });
    this.anchorClient = createAnchorbrowserClient({ auth: key });
    return this.anchorClient;
  }

  async open(opts: { runId: string; kind: 'anchor' | 'local'; url?: string; headless?: boolean }): Promise<BrowserSession> {
    const id = `web_${randomBytes(4).toString('hex')}`;
    let session: BrowserSession;
    if (opts.kind === 'anchor') {
      const client = await this.anchor();
      const created = await Sessions.createSession({ client, body: { session: { timeout: { max_duration: 20, idle_timeout: 3 }, recording: { active: false }, live_view: { read_only: true } } }, throwOnError: true });
      if (!created.data?.id) throw new Error('Anchor did not return a session ID');
      const remoteId = created.data.id;
      this.anchorSessions.set(remoteId, opts.runId);
      let browser: Browser | undefined;
      try {
        browser = await connectBrowser(remoteId, client);
        const context = browser.contexts()[0] ?? (await browser.newContext());
        await context.addInitScript(SUBMIT_GUARD);
        const page = context.pages()[0] ?? (await context.newPage());
        session = {
          id,
          kind: 'anchor',
          runId: opts.runId,
          browser,
          context,
          page,
          anchorSessionId: remoteId,
          ...(created.data.live_view_url ? { liveViewUrl: created.data.live_view_url } : {}),
          createdAt: Date.now(),
        };
      } catch (e) {
        await browser?.close().catch(() => {});
        // Failed deletion stays tracked for runtime cleanup, even if CDP never connected.
        await this.deleteAnchorSession(remoteId).catch(() => {});
        throw new Error(redactText(e instanceof Error ? e.message : String(e)));
      }
    } else {
      // Chrome's built-in async DNS resolver stalled the first lookup ~9 s on macOS 26 (measured);
      // the system resolver answers in milliseconds
      const launch = { headless: opts.headless ?? false, args: ['--disable-features=AsyncDns'] };
      let browser: Browser;
      try {
        browser = await chromium.launch({ channel: 'chrome', ...launch });
      } catch {
        browser = await chromium.launch(launch);
      }
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await context.addInitScript(SUBMIT_GUARD);
      const page = await context.newPage();
      session = { id, kind: 'local', runId: opts.runId, browser, context, page, createdAt: Date.now() };
    }
    this.sessions.set(id, session);
    if (opts.url) {
      try { await session.page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); }
      catch (e) {
        await this.close(id).catch(() => {});
        throw new Error(redactText(e instanceof Error ? e.message : String(e)));
      }
    }
    return session;
  }

  get(id: string): BrowserSession {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error(`browser session ${id} is not open`), { code: 'not_found' });
    return s;
  }

  /** Read-only preview of an existing cloud session; never creates a session. */
  async preview(runId: string, id: string): Promise<Buffer | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.runId !== runId || s.kind !== 'anchor') throw new Error('Browser preview does not belong to this cloud run');
    return s.page.screenshot({ type: 'jpeg', quality: 65, timeout: 1500 });
  }

  /** Runs an Anchor agent task (natural-language web task) in an existing anchor session. */
  async agentTask(id: string, prompt: string, opts: { url?: string; outputSchema?: object; maxSteps?: number; onStep?: (s: string) => void }) {
    const s = this.get(id);
    if (s.kind !== 'anchor' || !s.anchorSessionId) throw new Error('agent tasks need an Anchor session');
    const client = await this.anchor();
    return agentTask(prompt, {
      client,
      sessionId: s.anchorSessionId,
      taskOptions: {
        ...(opts.url ? { url: opts.url } : {}),
        ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
        maxSteps: opts.maxSteps ?? 25,
        ...(opts.onStep ? { onAgentStep: opts.onStep } : {}),
      },
    }).catch((e: unknown) => { throw new Error(redactText(e instanceof Error ? e.message : String(e))); });
  }

  private async deleteAnchorSession(id: string): Promise<void> {
    try {
      await Sessions.deleteSession({ client: await this.anchor(), path: { session_id: id }, throwOnError: true });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw new Error(redactText(e instanceof Error ? e.message : String(e)));
    }
    this.anchorSessions.delete(id);
  }

  async close(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    const pending = this.closing.get(id);
    if (pending) return pending;
    const closing = (async () => {
      await s.browser.close().catch(() => {});
      if (s.kind === 'anchor' && s.anchorSessionId) await this.deleteAnchorSession(s.anchorSessionId);
      this.sessions.delete(id);
      return true;
    })().finally(() => this.closing.delete(id));
    this.closing.set(id, closing);
    return closing;
  }

  async closeAll(runId?: string): Promise<number> {
    const ids = [...this.sessions.values()].filter((s) => !runId || s.runId === runId).map((s) => s.id);
    const active = new Set([...this.sessions.values()].flatMap((s) => s.anchorSessionId ? [s.anchorSessionId] : []));
    const orphans = [...this.anchorSessions].filter(([id, run]) => !active.has(id) && (!runId || run === runId));
    const results = await Promise.allSettled([...ids.map((id) => this.close(id)), ...orphans.map(([id]) => this.deleteAnchorSession(id).then(() => true))]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((r) => r.reason), `failed to close ${failures.length} browser session(s); handles retained for retry`);
    return results.filter((r) => r.status === 'fulfilled' && r.value).length;
  }

  openIds(): string[] {
    return [...this.sessions.keys()];
  }
}
