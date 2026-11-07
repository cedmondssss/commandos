import { execFile } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultSettings } from '@commandos/contracts';
import { BrowserHub, type Procedure, ProcedureMemory, SandboxService } from '@commandos/providers';
import { CommandRuntime } from '@commandos/runtime';
import { findHelperBinary, HelperClient, type ToolContext, webExtract, webFillForm, webOpen, webGoto } from '@commandos/tools';
import { afterAll, describe, expect, it } from 'vitest';
import { loadLocalEnv } from '../../scripts/lib/env';
import { tempDir } from '../../packages/runtime/test/helpers';

loadLocalEnv();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_URL = process.env.COMMANDOS_FIXTURE_URL ?? 'https://commandos-fixtures.vercel.app';
const env = process.env;
const has = (...keys: string[]) => keys.every((k) => Boolean(env[k]));
const reason = (keys: string[]) => (has(...keys) ? 'live' : `skipped: ${keys.filter((k) => !env[k]).join(', ')} not set`);

function toolCtx(dir: string, providers: Record<string, unknown>): ToolContext {
  return {
    runId: `run_cloud_${Date.now()}`,
    taskId: 't',
    signal: new AbortController().signal,
    dryRun: false,
    settings: defaultSettings(),
    helper: new HelperClient('/nonexistent'),
    models: null,
    providers: { get: async <T>(n: string) => (providers[n] as T) ?? Promise.reject(new Error(`no ${n}`)) },
    journal: { record: async () => {} },
    artifactsDir: dir,
    log: () => {},
    progress: () => {},
  };
}

describe.skipIf(!has('DAYTONA_API_KEY'))(`Daytona sandbox (${reason(['DAYTONA_API_KEY'])})`, () => {
  const svc = has('DAYTONA_API_KEY') ? new SandboxService({ apiKey: env.DAYTONA_API_KEY as string, ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}), ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}) }) : null;
  afterAll(() => svc?.destroyAll());

  it('stages the fixture repo without network and reproduces the 3 failing tests', async () => {
    const { sandboxCreate, sandboxExec } = await import('@commandos/tools');
    const dir = await tempDir();
    const ctx = toolCtx(dir, { daytona: svc });
    const created = await sandboxCreate.run({ repoPath: join(ROOT, 'fixtures/repos/calc-lib'), network: 'auto' }, ctx);
    expect(created.network).toBe('none');
    const checks = await sandboxCreate.verify!({} as never, created, ctx);
    expect(checks.every((c) => c.ok)).toBe(true);
    const run = await sandboxExec.run({ sandboxId: created.sandboxId, command: created.testCommand, timeoutSec: 180, expectZeroExit: false }, ctx);
    expect(run.failed).toBe(3);
    expect(run.failures.map((f) => f.name)).toContain('applies percentage discounts');
    expect(await svc?.destroy(created.sandboxId)).toBe(true);
  }, 300_000);
});

describe.skipIf(!has('DAYTONA_API_KEY', 'OPENAI_API_KEY'))(`Workflow 2 end to end (${reason(['DAYTONA_API_KEY', 'OPENAI_API_KEY'])})`, () => {
  let rt: CommandRuntime | null = null;
  afterAll(() => rt?.shutdown());

  it('finds failures in a sandbox, validates an Astra patch there, and applies it locally after approval', async () => {
    const dir = await tempDir('commandos-w2-');
    const repo = join(dir, 'calc-lib');
    await cp(join(ROOT, 'fixtures/repos/calc-lib'), repo, { recursive: true });
    rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: findHelperBinary(ROOT), useKeychain: false, revealResults: false, settingsOverride: { allowedRoots: [dir] } });
    rt.on('run', (e) => {
      if (e.type === 'approval_requested') rt?.respondApproval(e.approval.id, 'approve');
    });
    const runId = await rt.submit(`Run the tests in ${repo} and fix the failures`, 'text');
    const summary = await rt.waitForRun(runId);
    expect(summary.mode).toBe('fast');
    expect(summary.state).toBe('succeeded');
    // the patched repository now passes locally too
    const { stdout } = await promisify(execFile)('node', ['--test', '--test-reporter=tap'], { cwd: repo });
    expect(stdout).toMatch(/# fail 0/);
  }, 600_000);
});

describe.skipIf(!has('ANCHORBROWSER_API_KEY'))(`Anchor Browser (${reason(['ANCHORBROWSER_API_KEY'])})`, () => {
  const hub = new BrowserHub(async () => env.ANCHORBROWSER_API_KEY ?? null);
  afterAll(() => hub.closeAll());

  it('reads the catalog and fills the draft form in a remote session without submitting', async () => {
    const dir = await tempDir();
    const ctx = toolCtx(dir, { browser: hub });
    const opened = await webOpen.run({ provider: 'anchor', url: `${FIXTURE_URL}/catalog.html`, headless: true }, ctx);
    expect(opened.provider).toBe('anchor');
    const page = await webExtract.run({ sessionId: opened.sessionId, maxTextChars: 2000 }, ctx);
    expect(page.tables[0]?.rows.length).toBe(6);
    await webGoto.run({ sessionId: opened.sessionId, url: `${FIXTURE_URL}/order.html` }, ctx);
    const fill = await webFillForm.run(
      { sessionId: opened.sessionId, strategy: 'auto', fields: [{ selector: '#company', label: 'Company name', value: 'Rivera Labs' }, { selector: '#quantity', label: 'Quantity', value: '40' }] },
      ctx,
    );
    const checks = await webFillForm.verify!({} as never, fill, ctx);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(await hub.close(opened.sessionId)).toBe(true);
  }, 240_000);
});

describe.skipIf(!has('SPECTRON_URL', 'SPECTRON_CONTEXT_ID', 'SPECTRON_API_KEY'))(
  `SurrealDB Agent Memory (${reason(['SPECTRON_URL', 'SPECTRON_CONTEXT_ID', 'SPECTRON_API_KEY'])})`,
  () => {
    it('stores a verified procedure verbatim and recalls it', async () => {
      const mem = new ProcedureMemory({ endpoint: env.SPECTRON_URL as string, context: env.SPECTRON_CONTEXT_ID as string, apiKey: env.SPECTRON_API_KEY as string }, 'ci-test');
      const id = `proc_test_${Date.now()}`;
      const procedure: Procedure = {
        kind: 'commandos.procedure',
        version: 1,
        id,
        intent: 'organize_screenshots',
        command: `organize my screenshots into a folder called Verification ${id}`,
        summary: 'Moved 2 file(s).',
        mode: 'template',
        template: 'organize_screenshots',
        slots: { count: 2 },
        tasks: null,
        parameters: [],
        fingerprint: { tools: {}, apps: {}, sites: {}, os: '25' },
        stats: { successes: 1, failures: 0, avgMs: 10, lastVerifiedAt: new Date().toISOString() },
        runId: 'run_test',
        status: 'active',
        updatedAt: new Date().toISOString(),
      };
      await mem.rememberProcedure(procedure);
      let found = false;
      for (let i = 0; i < 10 && !found; i++) {
        found = (await mem.recallProcedures(`folder called Verification ${id}`, 5)).some((r) => r.procedure.id === id);
        if (!found) await new Promise((r) => setTimeout(r, 1500));
      }
      expect(found).toBe(true);
      const testKey = ['sk-', 'proj-', 'AbCdEfGhIjKlMnOpQrStUvW', 'xYz0123456789'].join('');
      await expect(mem.rememberOutcome({ intent: 'x', command: `export OPENAI_API_KEY=${testKey}`, success: true, summary: '', runId: 'r', durationMs: 1 })).rejects.toThrow(/secrets/);
    }, 120_000);
  },
);
