import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandRuntime, organizeScreenshotsPlan } from '@commandos/runtime';
import { findHelperBinary, HelperClient } from '@commandos/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { populateScreenshotInbox } from '../../scripts/gen-fixtures';
import { tempDir } from '../../packages/runtime/test/helpers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = findHelperBinary(ROOT);
const haveHelper = existsSync(HELPER);
const FIXTURES = join(ROOT, 'fixtures', 'fs', 'screenshots');

describe.skipIf(!haveHelper)(`Swift helper over JSON-lines RPC (${haveHelper ? HELPER : 'not built: run pnpm build:helper'})`, () => {
  const helper = new HelperClient(HELPER);
  beforeAll(() => helper.start());
  afterAll(() => helper.stop());

  it('answers ping and reports permission status', async () => {
    const pong = await helper.call('ping', {});
    expect(pong.pong).toBe(true);
    const perms = await helper.call('permissions.status', {});
    expect(typeof perms.accessibility).toBe('boolean');
    expect(typeof perms.screenRecording).toBe('boolean');
  });

  it('reads text from a real screenshot on-device', async () => {
    const r = await helper.call('vision.ocr', { path: join(FIXTURES, 'receipt-blue-bottle.png'), level: 'accurate' });
    expect(r.width).toBe(1100);
    expect(r.text).toMatch(/Blue Bottle/);
    expect(r.text).toMatch(/37\.20/);
  });

  it('round-trips a Keychain secret without exposing others', async () => {
    const service = `com.commandos.tests.${Date.now()}`;
    await helper.call('keychain.set', { service, account: 'TEST_KEY', value: 's3cret' });
    expect((await helper.call('keychain.get', { service, account: 'TEST_KEY' })).value).toBe('s3cret');
    expect((await helper.call('keychain.list', { service })).accounts).toEqual(['TEST_KEY']);
    expect((await helper.call('keychain.delete', { service, account: 'TEST_KEY' })).deleted).toBe(true);
    expect((await helper.call('keychain.get', { service, account: 'TEST_KEY' })).value).toBeNull();
  });

  it('describes installed apps and lists running ones', async () => {
    const info = await helper.call('apps.info', { bundleId: 'com.apple.TextEdit' });
    expect(info.path).toMatch(/TextEdit\.app$/);
    const apps = await helper.call('apps.list', {});
    expect(apps.apps.length).toBeGreaterThan(0);
  });

  it('rejects invalid params before they reach the helper', async () => {
    await expect(helper.call('vision.ocr', { path: '', level: 'accurate' })).rejects.toThrow();
  });

  it('surfaces native errors with codes', async () => {
    await expect(helper.call('vision.ocr', { path: '/nonexistent.png', level: 'fast' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe.skipIf(!haveHelper)('FAST screenshot workflow end to end (real helper, real files, no model)', () => {
  let rt: CommandRuntime;
  let demo: string;

  beforeAll(async () => {
    demo = await tempDir('commandos-e2e-');
    rt = await CommandRuntime.create({
      dataDir: join(demo, 'data'),
      helperPath: HELPER,
      useKeychain: false,
      telemetry: false,
      revealResults: false,
      env: {},
      settingsOverride: { allowedRoots: [demo], screenshotRoots: [join(demo, 'Screenshots')] },
    });
    await populateScreenshotInbox(join(demo, 'Screenshots'));
  });
  afterAll(() => rt?.shutdown());

  it('moves the 3 newest screenshots, verifies, writes a report, then undoes everything', async () => {
    const before = (await readdir(join(demo, 'Screenshots'))).sort();
    const runId = await rt.submit('Move my 3 latest screenshots into a folder called Keepers and write a report', 'text');
    const summary = await rt.waitForRun(runId);
    expect(summary.state).toBe('succeeded');
    expect(summary.mode).toBe('fast');
    expect(summary.modelCalls).toBe(0);
    const kept = (await readdir(join(demo, 'Screenshots', 'Keepers'))).filter((f) => f.endsWith('.png'));
    expect(kept).toHaveLength(3);
    const report = (await readdir(join(demo, 'Screenshots', 'Keepers'))).find((f) => f.endsWith('.md'));
    expect(await readFile(join(demo, 'Screenshots', 'Keepers', report as string), 'utf8')).toMatch(/3 item\(s\)\./);
    const metrics = await rt.runMetrics(runId);
    expect(metrics.verifiedSuccess).toBe(true);
    expect(metrics.timeToFirstActionMs).toBeLessThan(2000);

    const undo = await rt.undo(runId);
    expect(undo.ok).toBe(true);
    expect((await readdir(join(demo, 'Screenshots'))).sort()).toEqual(before);
  });

  it('the plan template validates against the real tool registry', () => {
    const plan = organizeScreenshotsPlan(
      { count: 5, sourceFolder: null, destinationFolder: null, destinationName: 'X', renameByContent: true, groupByCategory: true, withinDays: null, report: true, reportTitle: null },
      rt.settings,
    );
    expect(plan.tasks.map((t) => t.tool)).toEqual(['screenshots.find', 'fs.mkdir', 'image.ocr', 'ai.nameFiles', 'fs.organize', 'report.write', 'workspace.reveal']);
  });
});

// keep fixtures importable for other suites
export async function copyFixture(name: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, name);
  await copyFile(join(FIXTURES, name), target);
  return target;
}

describe.skipIf(!haveHelper)('ScreenCaptureKit capture (skips when Screen Recording is not granted)', () => {
  it('captures the main display to a PNG on disk and reads it back', async () => {
    const helper = new HelperClient(HELPER);
    try {
      const perms = await helper.call('permissions.status', {});
      if (!perms.screenRecording) {
        console.warn('skipped: Screen Recording not granted to this process');
        return;
      }
      const dir = await tempDir('commandos-capture-');
      const out = join(dir, 'display.png');
      const cap = await helper.call('screen.capture', { target: 'display', outPath: out });
      expect(cap.width).toBeGreaterThan(100);
      expect(cap.frame.width).toBeGreaterThan(100);
      const info = await helper.call('image.info', { path: out });
      expect(info.width).toBe(cap.width);
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true }); // the capture never leaves this machine
    } finally {
      helper.stop();
    }
  });
});

describe.skipIf(!haveHelper)('emergency stop', () => {
  it('stops an in-flight run, kills its process group and leaves the run stopped', async () => {
    const dir = await tempDir('commandos-estop-');
    const rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: HELPER, useKeychain: false, telemetry: false, revealResults: false, env: {}, settingsOverride: { allowedRoots: [dir] } });
    try {
      const runId = await rt.submit('long running command', 'text', false, null, async (executor) => {
        executor.addTask({ id: 'wait', tool: 'terminal.run', args: { argv: ['tail', '-f', '/dev/null'], cwd: dir, timeoutMs: 120_000 } });
        executor.seal();
        return { mode: 'fast', intent: 'general', confidence: 1, via: 'procedure', reason: 'test', slots: {}, needsFullPreview: false };
      });
      await new Promise((r) => setTimeout(r, 600));
      const t0 = Date.now();
      await rt.emergencyStop();
      const summary = await rt.waitForRun(runId);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(summary.state).toBe('stopped');
      const { execFileSync } = await import('node:child_process');
      const stillRunning = execFileSync('/bin/ps', ['-axo', 'command']).toString().split('\n').some((l) => l.trim() === 'tail -f /dev/null');
      expect(stillRunning).toBe(false);
    } finally {
      await rt.shutdown();
    }
  });
});
