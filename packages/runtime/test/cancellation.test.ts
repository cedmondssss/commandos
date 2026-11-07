import { join } from 'node:path';
import { photoBoothTakePhoto, browserAttachFile, defineTool } from '@commandos/tools';
import { RealtimeTranscriber } from '@commandos/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CommandRuntime } from '../src/runtime';
import { ApprovalBroker } from '../src/approvals';
import type { RunExecutor } from '../src/executor';
import { makeExecutor, statesOf, tempDir } from './helpers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function runtime() {
  const dir = await tempDir('commandos-stop-');
  const rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: '/nonexistent', telemetry: false, useKeychain: false, revealResults: false, env: {}, settingsOverride: { allowedRoots: [dir, '~/Pictures'] } });
  return { dir, rt };
}
afterEach(() => vi.restoreAllMocks());

describe('Stop across the run lifecycle', () => {
  it('settles while model initialization is pending and never starts the photo later', async () => {
    const { rt } = await runtime();
    const models = deferred<null>();
    const started = vi.spyOn(rt, 'getModels').mockReturnValue(models.promise);
    const photo = vi.spyOn(photoBoothTakePhoto, 'run');
    try {
      const id = await rt.submit('Take a pic and upload it to Qwen', 'text');
      await vi.waitFor(() => expect(started).toHaveBeenCalled());
      await rt.emergencyStop();
      expect((await rt.waitForRun(id)).state).toBe('stopped');
      models.resolve(null);
      await Promise.resolve();
      expect(photo).not.toHaveBeenCalled();
      expect((await rt.getRun(id)).events.filter((e) => e.type === 'run_state').at(-1)).toMatchObject({ state: 'stopped' });
    } finally { models.resolve(null); await rt.shutdown(); }
  });

  it('seals an unfinished planner so late work cannot restart a stopped run', async () => {
    const { rt, dir } = await runtime();
    vi.spyOn(rt, 'getModels').mockResolvedValue(null);
    const pending = deferred<{ outcome: string; summary: string }>();
    let executor: RunExecutor | undefined;
    const plannable = rt as unknown as { plan: (run: unknown, route: unknown, executor: RunExecutor) => Promise<{ outcome: string; summary: string }> };
    vi.spyOn(plannable, 'plan').mockImplementation(async (_run, _route, e) => { executor = e; return pending.promise; });
    try {
      const id = await rt.submit('List the files here', 'text');
      await vi.waitFor(() => expect(executor).toBeDefined());
      await rt.emergencyStop();
      expect((await rt.waitForRun(id)).state).toBe('stopped');
      expect(() => executor!.addTask({ id: 'late', tool: 'fs.mkdir', args: { path: join(dir, 'Must not exist') } })).toThrow(/no more tasks/);
      pending.resolve({ outcome: 'done', summary: 'late response' });
      await Promise.resolve();
      expect((await rt.waitForRun(id)).state).toBe('stopped');
    } finally { pending.resolve({ outcome: 'done', summary: '' }); await rt.shutdown(); }
  });

  it('cancels a waiting upload approval without uploading or retaking the photo', async () => {
    const { rt, dir } = await runtime();
    vi.spyOn(rt, 'getModels').mockResolvedValue(null);
    const photo = vi.spyOn(photoBoothTakePhoto, 'run').mockResolvedValue({ path: join(dir, 'photo.jpg'), name: 'photo.jpg' });
    const attach = vi.spyOn(browserAttachFile, 'run');
    let approval: string | undefined;
    rt.on('run', (e) => { if (e.type === 'approval_requested') approval = e.approval.id; });
    try {
      const id = await rt.submit('Take a pic and upload it to Qwen', 'text');
      await vi.waitFor(() => expect(approval).toBeDefined());
      await rt.emergencyStop();
      expect((await rt.waitForRun(id)).state).toBe('stopped');
      expect(rt.respondApproval(approval!, 'approve')).toBe(false);
      expect(photo).toHaveBeenCalledOnce();
      expect(attach).not.toHaveBeenCalled();
    } finally { await rt.shutdown(); }
  });

  it('cancels verification immediately and ignores its late success', async () => {
    const verification = deferred<Array<{ label: string; ok: boolean }>>();
    const verify = vi.fn(() => verification.promise);
    const tool = defineTool({ id: 'test.verify', title: 'verify', description: 'verification fixture', tier: 1, args: z.object({}), output: z.object({}), effectClass: 'read', effects: [], risk: 'none', idempotent: false, defaultTimeoutMs: 5_000, run: async () => ({}), verify });
    const h = await makeExecutor([tool]);
    h.executor.addTask({ id: 'verify', tool: tool.id, args: {} });
    // Deliberately leave planning unsealed: Stop must finish this run anyway.
    await vi.waitFor(() => expect(verify).toHaveBeenCalled());
    h.controller.abort(new Error('emergency stop'));
    expect((await h.executor.done()).cancelled).toBe(1);
    verification.resolve([{ label: 'late success', ok: true }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statesOf(h.events, 'verify').at(-1)).toBe('cancelled');
    expect(statesOf(h.events, 'verify')).not.toContain('succeeded');
  });

  it('never opens an approval for an already cancelled signal', async () => {
    const requested = vi.fn();
    const broker = new ApprovalBroker({ requested, resolved: vi.fn() });
    const controller = new AbortController(); controller.abort();
    const result = await broker.request({ runId: 'run_test', taskId: 'upload', toolId: 'browser.attachFile', title: 'Upload', effectClass: 'external', risk: 'high', irreversible: true, reasons: [], preview: { summary: '', details: [] } }, 5_000, controller.signal);
    expect(result).toEqual({ decision: 'denied', by: 'cancel' });
    expect(requested).not.toHaveBeenCalled();
    expect(broker.size).toBe(0);
  });

  it('stops a connecting microphone session and ignores late committed speech', async () => {
    const { rt } = await runtime();
    const connection = deferred<void>();
    let session: RealtimeTranscriber | undefined;
    vi.spyOn(rt.credentials, 'get').mockResolvedValue('test-key');
    vi.spyOn(RealtimeTranscriber.prototype, 'start').mockImplementation(function (this: RealtimeTranscriber) { session = this; return connection.promise; });
    const stopped = vi.spyOn(RealtimeTranscriber.prototype, 'stop').mockImplementation(() => {});
    const submit = vi.spyOn(rt, 'submit');
    try {
      const start = rt.voiceStart();
      await vi.waitFor(() => expect(session).toBeDefined());
      await rt.emergencyStop();
      session!.emit('committed', 'Take another photo', {});
      connection.resolve(); await start;
      expect(stopped).toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    } finally { connection.resolve(); await rt.shutdown(); }
  });
});
