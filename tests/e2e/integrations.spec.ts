import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { defaultSettings } from '@commandos/contracts';
import { CommandRuntime } from '@commandos/runtime';
import { findHelperBinary } from '@commandos/tools';

// Isolated renderer fixtures: no Electron instance, Keychain, real browser session,
// microphone or sponsor API is controlled by these UI regressions.
const ROOT = resolve(import.meta.dirname, '../..');
let server: Server;
let browser: Browser;
let origin: string;
let page: Page;
const trace = 'abcdefabcdefabcdefabcdefabcdefab';
const now = Date.now();
const task = (id: string, tool: string, args: Record<string, unknown>, bind: Array<{ arg: string; from: string }> = []) => ({ type: 'task_added', task: { id, tool, title: tool, args, bind, dependsOn: [], postconditions: [], tier: 1, risk: 'none', effectClass: 'read' } });
async function push(events: unknown[]) {
  await page.evaluate((events) => {
    const fixture = window as unknown as { __push: (event: unknown) => void };
    for (const event of events) fixture.__push(event);
  }, events);
}
const event = (value: Record<string, unknown>, at = now + 1000, runId = 'run_anchor') => ({ runId, at, ...value });

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const rel = new URL(request.url ?? '/', 'http://fixture').pathname.replace(/^\/+/, '') || 'index.html';
    const file = resolve(ROOT, 'apps/desktop/out/renderer', rel);
    if (!file.startsWith(join(ROOT, 'apps/desktop/out/renderer') + '/')) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(file);
      response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
test.afterAll(async () => { await browser?.close(); await new Promise<void>((done) => server?.close(() => done())); });
test.beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const png = await readFile(join(ROOT, 'fixtures/fs/screenshots/receipt-blue-bottle.png'));
  await page.addInitScript(({ image, settings }) => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const state = window as unknown as { commandos: unknown; __push: (event: unknown) => void; __submitted: number };
    state.__submitted = 0;
    state.commandos = {
      invoke: async (method: string) => {
        if (method === 'runs.list') return { runs: [] };
        if (method === 'settings.get') return settings;
        if (method === 'run.image') return { dataUrl: image };
        if (method === 'browser.preview') return { state: 'live', dataUrl: image };
        if (method === 'diagnostics.get') return { dataDir: '/fixture', helper: { running: false, path: '/fixture/helper' }, permissions: null, verification: null, telemetry: { arize: true, localTraceFile: null, projectName: 'commandos', exportStats: { spans: 12, batches: 2, failures: 0 } } };
        if (method === 'command.submit') { state.__submitted++; return { runId: 'fixture-submit' }; }
        return { ok: true };
      },
      on: (channel: string, callback: (event: unknown) => void) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(callback);
        return () => listeners.get(channel)?.delete(callback);
      },
      sendAudio: () => {},
    };
    state.__push = (event) => { for (const callback of listeners.get('run:event') ?? []) callback(event); };
  }, { image: `data:image/png;base64,${png.toString('base64')}`, settings: defaultSettings() });
  await page.goto(`${origin}/#/main`);
  await expect(page.getByRole('button', { name: 'Integrations', exact: true })).toBeVisible();
});
test.afterEach(async () => page.close());

test('Anchor viewer switches to retained screenshot; memory and trace evidence are inspectable', async () => {
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  await page.getByRole('button', { name: 'Try a read-only browser task' }).click();
  await expect(page.getByPlaceholder(/Tell CommandOS/)).toHaveValue(/Use Anchor Browser to open https:\/\/example.com/);
  expect(await page.evaluate(() => (window as unknown as { __submitted: number }).__submitted)).toBe(0);
  await push([
    event({ type: 'run_created', command: 'Read a page with Anchor Browser', source: 'text', dryRun: false }, now),
    event({ type: 'run_state', state: 'running' }), event({ type: 'trace', traceId: trace }),
    event(task('open', 'web.open', { provider: 'anchor', url: 'https://example.com' })),
    event({ type: 'task_state', taskId: 'open', state: 'running', attempt: 1 }),
    event({ type: 'task_output', taskId: 'open', artifacts: [], output: { sessionId: 'web_fixture', anchorSessionId: 'remote_fixture', provider: 'anchor', url: 'https://example.com', title: 'Example Domain', liveViewUrl: 'https://live.anchorbrowser.io/inspector.html?sessionId=fixture' } }),
    event({ type: 'task_state', taskId: 'open', state: 'succeeded', attempt: 1 }, now + 2000),
  ]);
  await expect(page.getByAltText('Live remote Anchor Browser page')).toBeVisible();
  await expect(page.getByText('remote_fixture', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(ROOT, 'test-results/integrations-anchor-live.png') });
  const binding = [{ arg: 'sessionId', from: 'open.output.sessionId' }];
  await push([
    event(task('shot', 'web.screenshot', { sessionId: '' }, binding)),
    event({ type: 'task_state', taskId: 'shot', state: 'running', attempt: 1 }, now + 2000),
    event({ type: 'task_output', taskId: 'shot', artifacts: [], output: { path: '/fixture/shot.png' } }),
    event({ type: 'task_state', taskId: 'shot', state: 'succeeded', attempt: 1 }, now + 3000),
    event(task('close', 'web.close', { sessionId: '' }, binding)),
    event({ type: 'task_output', taskId: 'close', artifacts: [], output: { closed: true } }),
    event({ type: 'task_state', taskId: 'close', state: 'succeeded', attempt: 1 }),
    event({ type: 'run_state', state: 'succeeded' }),
    event({ type: 'log', level: 'info', message: 'memory: saved verified procedure proc_fixture to SurrealDB Agent Memory', data: { provider: 'surrealdb', activity: 'saved', procedureId: 'proc_fixture', memoryId: 'memory_fixture', source: { sessionId: 'source_fixture' } } }),
  ]);
  await expect(page.getByAltText('Live remote Anchor Browser page')).toHaveCount(0);
  await expect(page.getByAltText('Browser screenshot captured during the selected run')).toBeVisible();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(ROOT, 'test-results/integrations-anchor-capture.png') });
  await page.getByRole('button', { name: 'SurrealDB memory', exact: true }).click();
  await expect(page.getByText('proc_fixture', { exact: true })).toBeVisible();
  await expect(page.getByText('memory_fixture', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(ROOT, 'test-results/integrations-memory.png') });
  await page.getByRole('button', { name: 'Arize trace', exact: true }).click();
  await expect(page.getByText(trace, { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Run timeline' })).toBeVisible();
  await expect(page.getByText('Runtime totals: 12 spans accepted · 0 export failures')).toBeVisible();
  await page.screenshot({ path: join(ROOT, 'test-results/integrations-trace.png') });
});

test('changing to a native-only run does not retain another run’s sponsor evidence', async () => {
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  await push([event({ type: 'run_created', command: 'Native Chrome attachment', source: 'text', dryRun: false }, now, 'run_native')]);
  await expect(page.getByText('No Anchor session in this run.')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'SurrealDB memory', exact: true }).click();
  await expect(page.getByText(/Saved and recalled procedures will appear/)).toBeVisible();
  await page.getByRole('button', { name: 'Arize trace', exact: true }).click();
  await expect(page.getByText('No trace in the selected run')).toBeVisible();
});

test('live Anchor session renders inside the dashboard and retains its real captured page', async () => {
  test.skip(process.env.COMMANDOS_LIVE_SPONSOR_UI !== '1', 'opt-in live cloud session; isolated renderer, no user desktop interaction');
  const dir = await mkdtemp(join(tmpdir(), 'commandos-live-dashboard-'));
  const rt = await CommandRuntime.create({ dataDir: dir, helperPath: findHelperBinary(ROOT), telemetry: false, revealResults: false, settingsOverride: { allowedRoots: [dir] } });
  rt.registerProvider('memory', async () => { throw new Error('Do not save a test workflow'); });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let runId: string | undefined;
  const pending: Promise<unknown>[] = [];
  rt.on('run', (e) => { pending.push(page.evaluate((event) => (window as unknown as { __push: (e: unknown) => void }).__push(event), JSON.parse(JSON.stringify(e)) as Record<string, unknown>)); });
  await page.exposeFunction('__realImage', (args: { runId: string; taskId: string }) => rt.runImage(args.runId, args.taskId));
  await page.exposeFunction('__realPreview', (args: { runId: string; sessionId: string }) => rt.browserPreview(args.runId, args.sessionId));
  await page.evaluate(() => {
    const w = window as unknown as { __realImage: (p: unknown) => Promise<unknown>; __realPreview: (p: unknown) => Promise<unknown>; commandos: { invoke: (m: string, p?: unknown) => Promise<unknown> } };
    const original = w.commandos.invoke;
    w.commandos.invoke = (method, params) => method === 'run.image' ? w.__realImage(params) : method === 'browser.preview' ? w.__realPreview(params) : original(method, params);
  });
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  try {
    runId = await rt.submit('Read the public catalog with Anchor Browser and capture the page', 'bench', false, null, async (executor) => {
      executor.addPlan({ goal: 'Read-only Anchor viewer verification', tasks: [
        { id: 'open', tool: 'web.open', args: { provider: 'anchor', url: 'https://commandos-fixtures.vercel.app/catalog.html', headless: true } },
        { id: 'extract', tool: 'web.extract', args: { sessionId: '' }, bind: [{ arg: 'sessionId', from: 'open.output.sessionId' }] },
        { id: 'shot', tool: 'web.screenshot', args: { sessionId: '' }, bind: [{ arg: 'sessionId', from: 'open.output.sessionId' }] },
      ] });
      await executor.waitFor(['open']);
      await hold;
      executor.seal();
      return { mode: 'fast', intent: 'general', confidence: 1, via: 'grammar', reason: 'Live read-only dashboard verification', slots: {}, needsFullPreview: false };
    });
    const frame = page.getByAltText('Live remote Anchor Browser page');
    await expect(frame).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => frame.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(500);
    await page.screenshot({ path: join(ROOT, 'test-results/integrations-anchor-real-live.png') });
    release();
    const result = await rt.waitForRun(runId);
    expect(result.state).toBe('succeeded');
    await Promise.all(pending);
    await expect(frame).toHaveCount(0);
    await expect(page.getByAltText('Browser screenshot captured during the selected run')).toBeVisible();
    await expect(page.getByText('Closed', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(ROOT, 'test-results/integrations-anchor-real-capture.png') });
  } finally {
    release();
    if (runId) { rt.cancel(runId); await rt.waitForRun(runId); }
    await rt.shutdown();
    await Promise.allSettled(pending);
  }
});
