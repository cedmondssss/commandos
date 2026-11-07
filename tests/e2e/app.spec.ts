import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test';
import type { SafetyReport } from '@commandos/contracts';
import { populateScreenshotInbox } from '../../scripts/gen-fixtures';
import { wavPcm, wordErrorRate } from '../../scripts/verify-providers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN = join(ROOT, 'apps', 'desktop', 'out', 'main', 'index.js');

let app: ElectronApplication;
let dashboard: Page;
let demo: string;

test.beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'commandos-app-'));
  const dataDir = join(demo, 'data');
  await populateScreenshotInbox(join(demo, 'Screenshots'));
  await cp(join(ROOT, 'fixtures/fs/docs'), join(demo, 'Docs'), { recursive: true });
  // restrict the app to the fixture folder for this test run
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dataDir, { recursive: true });
  const { defaultSettings } = await import('@commandos/contracts');
  await writeFile(
    join(dataDir, 'settings.json'),
    JSON.stringify({ ...defaultSettings(), allowedRoots: [demo], screenshotRoots: [join(demo, 'Screenshots')] }),
  );
  // VS Code terminals export ELECTRON_RUN_AS_NODE, which would start Electron as plain Node
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
  app = await electron.launch({
    args: [MAIN],
    env: { ...env, COMMANDOS_DATA_DIR: dataDir, COMMANDOS_REVEAL: '0', COMMANDOS_OPEN_DASHBOARD: '1', OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } as Record<string, string>,
  });
  // the command bar and the dashboard open separately and in either order: wait for the dashboard
  await app.firstWindow();
  const isDashboard = (w: Page) => w.url().includes('#/main');
  await expect.poll(() => app.windows().some(isDashboard), { timeout: 30_000 }).toBe(true);
  dashboard = app.windows().find(isDashboard) as Page;
});

test.afterAll(async () => {
  await app?.close();
});

test('renderer is sandboxed and isolated', async () => {
  const exposure = await dashboard.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    bridge: Object.keys((window as unknown as { commandos: object }).commandos).sort(),
  }));
  expect(exposure).toEqual({ require: 'undefined', process: 'undefined', bridge: ['invoke', 'on', 'sendAudio'] });
});

test('IPC rejects malformed requests', async () => {
  const err = await dashboard.evaluate(async () => {
    try {
      await (window as unknown as { commandos: { invoke: (m: string, p: unknown) => Promise<unknown> } }).commandos.invoke('command.submit', { text: '', source: 'nope' });
      return 'accepted';
    } catch (e) {
      return String(e);
    }
  });
  expect(err).not.toBe('accepted');
});

test('dashboard runs a typed command end to end and shows the verified DAG', async () => {
  await expect(dashboard.getByText('CommandOS').first()).toBeVisible();
  const input = dashboard.getByPlaceholder(/Tell CommandOS what to do/);
  await input.fill('Move my 2 latest screenshots into a folder called E2E Picks');
  await dashboard.getByRole('button', { name: /Run/ }).click();
  await expect(dashboard.getByText('FAST', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(dashboard.getByText(/All \d+ steps succeeded and were verified/).first()).toBeVisible({ timeout: 60_000 });
  await expect(dashboard.locator('.react-flow__node')).toHaveCount(3);
  const moved = (await readdir(join(demo, 'Screenshots', 'E2E Picks'))).filter((f) => f.endsWith('.png'));
  expect(moved).toHaveLength(2);
  await dashboard.screenshot({ path: join(ROOT, 'test-results', 'dashboard-run.png') });
});

test('IPC fuzzing: malformed, unknown and traversal requests are rejected; app stays responsive', async () => {
  const results = await dashboard.evaluate(async () => {
    const c = (window as unknown as { commandos: { invoke: (m: unknown, p: unknown) => Promise<unknown>; sendAudio: (b: unknown) => void } }).commandos;
    const cases: Array<[unknown, unknown]> = [
      ['nope.method', {}],
      ['command.submit', null],
      ['command.submit', { text: 'x'.repeat(5000), source: 'text', dryRun: false }],
      ['command.submit', { text: 'ok', source: 'root', dryRun: false }],
      ['credentials.set', { key: 'NOT_A_KEY', value: 'x' }],
      ['approval.respond', { approvalId: '../../etc/passwd', decision: 'approve' }],
      ['run.get', { runId: '../../../etc/passwd' }],
      ['run.undo', { runId: '/tmp' }],
      ['settings.update', { maxConcurrency: 10_000 }],
      ['system.openSettings', { pane: 'x-apple.systempreferences:evil' }],
      [123, {}],
      ['a'.repeat(200), {}],
    ];
    const out: string[] = [];
    for (const [m, p] of cases) {
      try {
        await c.invoke(m as string, p);
        out.push(`accepted ${String(m).slice(0, 30)}`);
      } catch {
        out.push('rejected');
      }
    }
    c.sendAudio(new Uint8Array(3));
    c.sendAudio('not audio');
    return out;
  });
  expect(results).toEqual(Array(results.length).fill('rejected'));
  const settings = (await dashboard.evaluate(() =>
    (window as unknown as { commandos: { invoke: (m: string, p: unknown) => Promise<{ maxConcurrency: number }> } }).commandos.invoke('settings.get', {}),
  )) as { maxConcurrency: number };
  expect(settings.maxConcurrency).toBeLessThanOrEqual(32);
});

test('Stop cancels an approval, and hiding the overlay survives the remaining run events', async () => {
  await expect.poll(() => app.windows().some((w) => w.url().includes('#/bar'))).toBe(true);
  const bar = app.windows().find((w) => w.url().includes('#/bar'))!;
  const invoke = (method: string, params: unknown) => dashboard.evaluate(({ method, params }) =>
    (window as unknown as { commandos: { invoke: (m: string, p: unknown) => Promise<any> } }).commandos.invoke(method, params), { method, params });
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#/bar'))?.isVisible() ?? false);
  await invoke('settings.update', { autoApproveReversibleMax: 0 });
  try {
    const { runId } = await invoke('command.submit', { text: 'Move my 2 latest screenshots into a folder called Stopped Picks', source: 'text', dryRun: false });
    await expect(bar.getByRole('button', { name: /^Approve/ })).toBeVisible({ timeout: 30_000 });
    await expect.poll(visible).toBe(true);
    await bar.getByRole('button', { name: 'Stop', exact: false }).click();
    await expect.poll(async () => (await invoke('run.get', { runId })).summary.state).toBe('stopped');
    await bar.getByRole('button', { name: 'Hide overlay', exact: true }).click();
    await expect.poll(visible).toBe(false);
    // These later persisted run/metric events must never resurrect the hidden panel.
    await expect.poll(async () => (await invoke('diagnostics.get', {})).helper.running).toBe(true);
    await expect.poll(visible).toBe(false);
    expect(await readdir(join(demo, 'Screenshots', 'Stopped Picks')).catch(() => [])).toEqual([]);
    const { runId: next } = await invoke('command.submit', { text: 'Move my 1 latest screenshot into a folder called New Command', source: 'text', dryRun: true });
    await expect.poll(visible).toBe(true);
    await expect.poll(async () => (await invoke('run.get', { runId: next })).summary.state).not.toMatch(/created|routing|planning|running/);
  } finally { await invoke('settings.update', { autoApproveReversibleMax: 25 }); }
});

test('Content Security Policy blocks injected inline scripts', async () => {
  const csp = await dashboard.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  const ran = await dashboard.evaluate(
    () =>
      new Promise<number>((resolve) => {
        (window as unknown as { __injected: number }).__injected = 0;
        const s = document.createElement('script');
        s.textContent = 'window.__injected = 1';
        document.body.appendChild(s);
        setTimeout(() => resolve((window as unknown as { __injected: number }).__injected), 100);
      }),
  );
  expect(ran).toBe(0);
});

test('HackBU demo command moves five fixture screenshots and undo restores their names', async () => {
  await dashboard.getByRole('button', { name: 'Live', exact: true }).click();
  const inbox = join(demo, 'Screenshots');
  const before = (await readdir(inbox)).filter((name) => name.endsWith('.png')).sort();
  const input = dashboard.getByPlaceholder(/Tell CommandOS what to do/);
  await input.fill(`Move my five latest screenshots in ${inbox} into a folder called HackBU Picks.`);
  await dashboard.getByRole('button', { name: /^Run/ }).click();
  await expect(dashboard.getByText(/All \d+ steps succeeded and were verified/).first()).toBeVisible({ timeout: 30_000 });
  expect((await readdir(join(inbox, 'HackBU Picks'))).filter((name) => name.endsWith('.png'))).toHaveLength(5);
  await expect(dashboard.getByRole('button', { name: /Undo run/ })).toBeVisible();
  const bar = app.windows().find((window) => window.url().includes('#/bar'))!;
  await expect(bar.getByRole('button', { name: /Undo run/ })).toBeVisible();
  // Undo is available even if the user has hidden the overlay's step list.
  await bar.getByTitle('Hide steps', { exact: true }).click();
  await expect(bar.getByRole('button', { name: /Undo run/ })).toBeVisible();
  await bar.getByRole('button', { name: /Undo run/ }).click();
  await expect.poll(async () => (await readdir(inbox)).filter((name) => name.endsWith('.png')).sort()).toEqual(before);
  await expect(bar.getByRole('button', { name: /Undo run/ })).toHaveCount(0);
});

test('Safety Lab runs through validated Electron IPC and shows inspectable persisted evidence', async () => {
  await dashboard.getByRole('button', { name: 'Safety Lab', exact: true }).click();
  await expect(dashboard.getByText('No evaluations have been run yet.', { exact: false })).toBeVisible();
  await dashboard.getByRole('button', { name: 'Run evaluations', exact: true }).click();
  // Navigating away must not lose the active run or start a duplicate suite.
  await dashboard.getByRole('button', { name: 'Live', exact: true }).click();
  await dashboard.getByRole('button', { name: 'Safety Lab', exact: true }).click();
  await expect(dashboard.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled({ timeout: 60_000 });
  const report = await dashboard.evaluate(() => (window as unknown as { commandos: { invoke: (method: string, params: unknown) => Promise<unknown> } }).commandos.invoke('safety.report', {})) as SafetyReport;
  expect(report.cases).toHaveLength(10);
  expect(report.cases.every((c) => c.status === 'passed')).toBe(true);
  await expect(dashboard.getByLabel('Evaluation scorecard').getByText(/10\s*\/\s*10/)).toBeVisible();
  await dashboard.locator('summary').filter({ hasText: 'Gate a send proposed after reading hostile text' }).click();
  await expect(dashboard.getByText('send: policy=require_approval', { exact: false })).toBeVisible();
  await expect(dashboard.getByText('no model was tested in this scenario', { exact: false })).toBeVisible();
  await dashboard.screenshot({ path: join(ROOT, 'test-results/safety-lab-electron.png') });
  await dashboard.getByRole('button', { name: 'Live', exact: true }).click();
  await dashboard.getByRole('button', { name: 'Safety Lab', exact: true }).click();
  await expect(dashboard.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled();
  await writeFile(join(ROOT, 'verification/safety-lab-desktop.json'), JSON.stringify({ checkedAt: new Date().toISOString(), interface: 'Built Electron app with real runtime IPC', report }, null, 2));
});

test('approval explanations show concrete targets, data sharing and undo before denial', async () => {
  const invoke = (method: string, params: unknown) => dashboard.evaluate(({ method, params }) => (window as unknown as { commandos: { invoke: (method: string, params: unknown) => Promise<unknown> } }).commandos.invoke(method, params), { method, params });
  await dashboard.getByRole('button', { name: 'Live', exact: true }).click();
  await invoke('settings.update', { autoApproveReversibleMax: 0 });
  try {
    await invoke('command.submit', { text: 'Move my 1 latest screenshot into a folder called Permission Check', source: 'text', dryRun: false });
    await expect(dashboard.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
    const card = dashboard.locator('[aria-label="Action explanation"]').filter({ hasText: 'Your approval is required' }).first();
    await expect(card.getByText('What happens', { exact: true })).toBeVisible();
    await expect(card.getByText('Destination / affected items', { exact: true })).toBeVisible();
    await expect(card).toContainText('Permission Check');
    await expect(card.getByText('Data sharing', { exact: true })).toBeVisible();
    await expect(card.getByText('Undo is recorded for successful changes.', { exact: false })).toBeVisible();
    await expect(card.getByText('Your approval is required:', { exact: false })).toBeVisible();
    await dashboard.screenshot({ path: join(ROOT, 'test-results/approval-explanation-electron.png') });
    await dashboard.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(dashboard.getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0);
    expect(await readdir(join(demo, 'Screenshots', 'Permission Check')).catch(() => [])).toEqual([]);
  } finally {
    await invoke('settings.update', { autoApproveReversibleMax: 25 });
  }
});

test('live credentials reach the Electron runtime, and a model-backed command produces the requested file', async () => {
  test.skip(process.env.COMMANDOS_LIVE_E2E !== '1', 'requires configured live providers');
  const status = await dashboard.evaluate(async () => {
    const c = (window as unknown as { commandos: { invoke: (m: string, p: unknown) => Promise<any> } }).commandos;
    return { ...(await c.invoke('credentials.status', {})), diagnostics: await c.invoke('diagnostics.get', {}) };
  });
  expect(status.credentials.filter((c: { required: boolean; source: string }) => c.required && c.source !== 'keychain')).toEqual([]);
  expect(status.diagnostics.telemetry.arize).toBe(true);
  await dashboard.getByPlaceholder(/Tell CommandOS what to do/).fill(`Read every document in ${join(demo, 'Docs')} and write a file called desktop-summary.md in that folder with one sentence per document.`);
  await dashboard.getByRole('button', { name: /Run/ }).click();
  await expect.poll(async () => readFile(join(demo, 'Docs/desktop-summary.md'), 'utf8').catch(() => ''), { timeout: 90_000 }).toMatch(/invoice/i);
  await expect(dashboard.getByText(/All \d+ steps succeeded and were verified/).first()).toBeVisible({ timeout: 90_000 });
  await writeFile(join(ROOT, 'verification/desktop-live.json'), JSON.stringify({ generatedAt: new Date().toISOString(), credentials: status.credentials.map(({ key, source }: { key: string; source: string }) => ({ key, source })), arizeEnabled: true, modelCommand: { verified: true, artifact: 'desktop-summary.md' } }, null, 2));
});

test('live voice audio crosses renderer IPC, transcribes, and returns a committed transcript', async () => {
  test.skip(process.env.COMMANDOS_LIVE_E2E !== '1', 'requires configured ElevenLabs');
  const sentence = 'Find my five latest screenshots and put them in a folder called receipts.';
  const wav = join(demo, 'voice-check.wav');
  await promisify(execFile)('/usr/bin/say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@16000', sentence]);
  const pcm = wavPcm(await readFile(wav));
  await dashboard.evaluate(async () => {
    const w = window as unknown as { voiceCheck: any[]; commandos: { invoke: (m: string, p: unknown) => Promise<any>; on: (channel: string, cb: (event: unknown) => void) => unknown } };
    w.voiceCheck = [];
    w.commandos.on('voice:event', (event) => w.voiceCheck.push(event));
    const settings = await w.commandos.invoke('settings.get', {});
    await w.commandos.invoke('settings.update', { voice: { ...settings.voice, autoSubmit: false, commitStrategy: 'manual', speakResults: false } });
    await w.commandos.invoke('voice.start', {});
  });
  try {
    const chunks: number[][] = [];
    for (let offset = 0; offset < pcm.length; offset += 3200) chunks.push(Array.from(pcm.subarray(offset, offset + 3200)));
    await dashboard.evaluate(async (audio) => {
      const c = (window as unknown as { commandos: { sendAudio: (chunk: Uint8Array) => void } }).commandos;
      for (const chunk of audio) { c.sendAudio(new Uint8Array(chunk)); await new Promise((resolve) => setTimeout(resolve, 100)); }
    }, chunks);
    await dashboard.evaluate(() => (window as unknown as { commandos: { invoke: (m: string, p: unknown) => Promise<unknown> } }).commandos.invoke('voice.stop', { commit: true }));
    await expect.poll(() => dashboard.evaluate(() => (window as unknown as { voiceCheck: Array<{ type: string }> }).voiceCheck.some((e) => e.type === 'committed')), { timeout: 20_000 }).toBe(true);
    const event = await dashboard.evaluate(() => (window as unknown as { voiceCheck: Array<{ type: string; text: string; metrics: unknown }> }).voiceCheck.find((e) => e.type === 'committed'));
    expect(wordErrorRate(sentence, event!.text)).toBeLessThanOrEqual(0.25);
    const report = JSON.parse(await readFile(join(ROOT, 'verification/desktop-live.json'), 'utf8'));
    await writeFile(join(ROOT, 'verification/desktop-live.json'), JSON.stringify({ ...report, voiceIpc: { verified: true, source: 'synthetic PCM fixture, not microphone hardware', transcript: event!.text, metrics: event!.metrics } }, null, 2));
  } finally {
    await dashboard.evaluate(() => (window as unknown as { commandos: { invoke: (m: string, p: unknown) => Promise<unknown> } }).commandos.invoke('voice.stop', { commit: false }));
  }
});
