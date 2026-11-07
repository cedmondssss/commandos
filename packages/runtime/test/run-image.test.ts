import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunSnapshot } from '@commandos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRuntime } from '../src/runtime';

let dir: string;
let rt: CommandRuntime;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=', 'base64');
const snapshot = (path: string, tool = 'web.screenshot'): RunSnapshot => ({
  summary: { runId: 'run_image', command: 'Read a page', source: 'text', state: 'succeeded', dryRun: false, createdAt: 1, taskCount: 1, succeededCount: 1, failedCount: 0, modelCalls: 0, undoable: false },
  events: [
    { type: 'task_added', runId: 'run_image', at: 1, task: { id: 'shot', tool, title: 'Screenshot', args: {}, dependsOn: [], bind: [], postconditions: [], tier: 1, risk: 'none', effectClass: 'read' } },
    { type: 'task_output', runId: 'run_image', at: 2, taskId: 'shot', output: { path }, artifacts: [] },
  ],
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commandos-image-'));
  rt = await CommandRuntime.create({ dataDir: dir, helperPath: '/nonexistent', useKeychain: false, telemetry: false, revealResults: false, env: {} });
  await mkdir(join(dir, 'runs/run_image/artifacts/web'), { recursive: true });
});
afterEach(async () => { await rt.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
describe('browser screenshot display boundary', () => {
  it('serves a recorded PNG from the selected run’s artifacts', async () => {
    const path = join(dir, 'runs/run_image/artifacts/web/shot.png'); await writeFile(path, png);
    vi.spyOn(rt, 'getRun').mockResolvedValue(snapshot(path));
    expect(await rt.runImage('run_image', 'shot')).toEqual({ dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  });
  it('identifies a remote JPEG by its bytes even when its path ends in .png', async () => {
    const path = join(dir, 'runs/run_image/artifacts/web/remote.png');
    const jpeg = Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex'); await writeFile(path, jpeg);
    vi.spyOn(rt, 'getRun').mockResolvedValue(snapshot(path));
    expect(await rt.runImage('run_image', 'shot')).toEqual({ dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
  });
  it.each(['outside', 'symlink', 'other-run'])('refuses an image outside this run: %s', async (kind) => {
    const other = join(dir, 'private.png'); await writeFile(other, png);
    let path = other;
    if (kind === 'symlink') { path = join(dir, 'runs/run_image/artifacts/web/link.png'); await symlink(other, path); }
    if (kind === 'other-run') { path = join(dir, 'runs/other/artifacts/shot.png'); await mkdir(join(dir, 'runs/other/artifacts'), { recursive: true }); await writeFile(path, png); }
    vi.spyOn(rt, 'getRun').mockResolvedValue(snapshot(path));
    await expect(rt.runImage('run_image', 'shot')).rejects.toThrow('outside');
  });
  it('refuses traversal, non-screenshot tools and non-PNG files', async () => {
    await expect(rt.runImage('../private', 'shot')).rejects.toThrow();
    const path = join(dir, 'runs/run_image/artifacts/web/secret.txt'); await writeFile(path, 'private text');
    const read = vi.spyOn(rt, 'getRun').mockResolvedValue(snapshot(path, 'fs.read'));
    await expect(rt.runImage('run_image', 'shot')).rejects.toThrow('Only recorded browser screenshots');
    read.mockResolvedValue(snapshot(path));
    await expect(rt.runImage('run_image', 'shot')).rejects.toThrow('not a supported PNG');
  });
  it('bounds screenshot payloads and never starts a browser to preview an unknown run', async () => {
    const path = join(dir, 'runs/run_image/artifacts/web/oversized.png');
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    vi.spyOn(rt, 'getRun').mockResolvedValue(snapshot(path));
    await expect(rt.runImage('run_image', 'shot')).rejects.toThrow('too large');
    expect(await rt.browserPreview('run_missing', 'web_missing')).toEqual({ state: 'closed', dataUrl: null });
  });
});
