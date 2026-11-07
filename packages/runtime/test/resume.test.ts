import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandRuntime } from '../src/runtime';
import { tempDir } from './helpers';

describe('checkpoints and resume', () => {
  it('restores verified steps from checkpoints and re-runs only what failed', async () => {
    const dir = await tempDir('commandos-resume-');
    const rt = await CommandRuntime.create({
      dataDir: join(dir, 'data'),
      helperPath: '/nonexistent/helper',
      useKeychain: false,
      telemetry: false,
      revealResults: false,
      env: {},
      settingsOverride: { allowedRoots: [dir] },
    });
    try {
      const first = await rt.submit('build a folder and move a file into it', 'text', false, null, async (executor) => {
        executor.addPlan({
          goal: 'g',
          tasks: [
            { id: 'mk', tool: 'fs.mkdir', args: { path: join(dir, 'out') } },
            { id: 'mv', tool: 'fs.move', args: { from: join(dir, 'input.txt'), to: join(dir, 'out', 'input.txt') }, dependsOn: ['mk'] },
            { id: 'note', tool: 'fs.writeText', args: { path: join(dir, 'out', 'done.txt'), content: 'ok' }, dependsOn: ['mv'] },
          ],
        });
        executor.seal();
        return { mode: 'fast', intent: 'file_operations', confidence: 1, via: 'procedure', reason: 'test', slots: {}, needsFullPreview: false };
      });
      const s1 = await rt.waitForRun(first);
      expect(s1.state).toBe('partial');
      expect(s1.succeededCount).toBe(1);

      await writeFile(join(dir, 'input.txt'), 'hello'); // the cause of the failure is fixed
      const second = await rt.resume(first);
      const s2 = await rt.waitForRun(second);
      expect(s2.state).toBe('succeeded');
      const snap = await rt.getRun(second);
      const mk = snap.events.filter((e) => e.type === 'task_state' && e.taskId === 'mk');
      expect(mk.map((e) => (e.type === 'task_state' ? e.state : ''))).toEqual(['succeeded']);
      expect(mk[0]?.type === 'task_state' && mk[0].detail).toMatch(/restored from checkpoint/);
      expect(snap.events.some((e) => e.type === 'task_state' && e.taskId === 'mv' && e.state === 'running')).toBe(true);
      await expect(rt.resume(second)).rejects.toThrow(/nothing to resume/);
    } finally {
      await rt.shutdown();
    }
  });
});
