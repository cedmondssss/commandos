import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultSettings } from '@commandos/contracts';
import { BrowserHub } from '@commandos/providers';
import {
  HelperClient,
  parseTestFailures,
  stageRepository,
  type ToolContext,
  webClick,
  webExtract,
  webFillForm,
  webGoto,
  webOpen,
} from '@commandos/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../packages/runtime/test/helpers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = join(ROOT, 'fixtures', 'site');
const REPO = join(ROOT, 'fixtures', 'repos', 'calc-lib');

/** Minimal static server for the fixture site (keeps tests offline). */
function serve(dir: string): Promise<{ server: Server; base: string }> {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css' };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/+/, '') || 'index.html';
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

describe('web tools in a real browser (local Playwright, offline fixture site)', () => {
  let site: { server: Server; base: string };
  const hub = new BrowserHub(async () => null);
  let ctx: ToolContext;

  beforeAll(async () => {
    site = await serve(SITE);
    const dir = await tempDir();
    ctx = {
      runId: 'run_web',
      taskId: 't',
      signal: new AbortController().signal,
      dryRun: false,
      settings: defaultSettings(),
      helper: new HelperClient('/nonexistent'),
      models: null,
      providers: { get: async <T>(name: string) => (name === 'browser' ? (hub as T) : Promise.reject(new Error('none'))) },
      journal: { record: async () => {} },
      artifactsDir: dir,
      log: () => {},
      progress: () => {},
    };
  });
  afterAll(async () => {
    await hub.closeAll();
    site?.server.close();
  });

  it('extracts the catalog, fills the draft form and blocks every submission path', async () => {
    const opened = await webOpen.run({ provider: 'local', url: `${site.base}/catalog.html`, headless: true }, ctx);
    const page = await webExtract.run({ sessionId: opened.sessionId, maxTextChars: 4000 }, ctx);
    expect(page.tables[0]?.rows).toHaveLength(6);
    expect(page.tables[0]?.rows[0]).toMatchObject({ SKU: 'NW-1042', 'Unit price': '$48.00' });

    await webGoto.run({ sessionId: opened.sessionId, url: `${site.base}/order.html` }, ctx);
    const fill = await webFillForm.run(
      {
        sessionId: opened.sessionId,
        strategy: 'selector',
        fields: [
          { selector: '#company', label: 'Company name', value: 'Rivera Labs' },
          { selector: '#email', label: 'Contact email', value: 'ops@rivera.example' },
          { selector: '#sku', label: 'Product', value: 'NW-2210 — Recycled notebook (A5, 10-pack)' },
          { selector: '#quantity', label: 'Quantity', value: '40' },
        ],
      },
      ctx,
    );
    const checks = await webFillForm.verify!({} as never, fill, ctx);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(fill.filled.every((f) => f.by === 'selector')).toBe(true);

    // pressing Enter in a field triggers implicit submission: the guard must block it
    const session = hub.get(opened.sessionId);
    await session.page.locator('#company').press('Enter');
    await session.page.waitForTimeout(300);
    expect(session.page.url()).toContain('order.html');
    const blocked = await session.page.evaluate(() => (window as unknown as { __commandosGuard: { blocked: unknown[] } }).__commandosGuard.blocked.length);
    expect(blocked).toBe(1);

    // a benign button works normally
    await webClick.run({ sessionId: opened.sessionId, label: 'Save draft', role: 'button' }, ctx);
    expect(await session.page.locator('#status').textContent()).toMatch(/Draft saved locally/);
  });

  it('a redesigned page breaks selectors; label matching still fills it', async () => {
    const opened = await webOpen.run({ provider: 'local', url: `${site.base}/order.html?variant=b`, headless: true }, ctx);
    const fields = [{ selector: '#company', label: 'Company name', value: 'Rivera Labs' }];
    await expect(webFillForm.run({ sessionId: opened.sessionId, strategy: 'selector', fields }, ctx)).rejects.toMatchObject({ code: 'field_not_found' });
    const r = await webFillForm.run({ sessionId: opened.sessionId, strategy: 'label', fields }, ctx);
    expect(r.filled[0]).toMatchObject({ by: 'label', readBack: 'Rivera Labs' });
  });

  it('reads an issue body without navigation noise and never substitutes the whole page for a missing selector', async () => {
    const opened = await webOpen.run({ provider: 'local', url: `${site.base}/catalog.html`, headless: true }, ctx);
    await hub.get(opened.sessionId).page.setContent('<nav>Unrelated navigation <a href="/other">Other</a></nav><main><article class="markdown-body"><h1>Checkout issue</h1><p>Local checkout: ~/CommandOS-Demo/checkout-demo</p><a href="/source">Source</a></article></main>');
    const issue = await webExtract.run({ sessionId: opened.sessionId, selector: 'main .markdown-body', maxTextChars: 8000 }, ctx);
    expect(issue.text).toContain('Local checkout: ~/CommandOS-Demo/checkout-demo');
    expect(issue.text).not.toContain('Unrelated navigation');
    expect(issue.links.map((l) => l.text)).toEqual(['Source']);
    await expect(webExtract.run({ sessionId: opened.sessionId, selector: '#missing', maxTextChars: 8000 }, ctx)).rejects.toMatchObject({ code: 'selector_not_found' });
  });
});

describe('sandbox staging and test parsing (no cloud calls)', () => {
  it('stages the fixture repo and refuses repos containing credentials', async () => {
    const staged = await stageRepository(REPO);
    expect(staged.files.map((f) => f.rel).sort()).toEqual(['.gitignore', 'README.md', 'package.json', 'src/cart.js', 'src/money.js', 'test/cart.test.js', 'test/money.test.js']);
    expect(staged.secretFindings).toEqual([]);

    const leaky = await tempDir('commandos-leaky-');
    await mkdir(join(leaky, 'src'));
    await writeFile(join(leaky, 'src', 'config.js'), "export const key = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';\n");
    await writeFile(join(leaky, '.env'), 'OPENAI_API_KEY=sk-proj-should-be-excluded-not-scanned\n');
    const r = await stageRepository(leaky);
    expect(r.skipped).toContain('.env');
    expect(r.secretFindings).toEqual([{ file: 'src/config.js', kinds: ['api_key'] }]);
  });

  it('parses node --test TAP output into failures', async () => {
    const { stdout } = await promisify(execFile)('node', ['--test', '--test-reporter=tap'], { cwd: REPO }).catch((e: { stdout: string }) => e);
    const parsed = parseTestFailures(stdout);
    expect(parsed.failed).toBe(3);
    expect(parsed.passed).toBe(5);
    expect(parsed.failures.map((f) => f.name).sort()).toEqual(['applies percentage discounts', 'cart total with a percentage code', 'splitting a bill keeps every cent']);
    expect(parsed.failures.find((f) => f.name === 'applies percentage discounts')?.location).toMatch(/money\.test\.js/);
  });
});
