import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Procedure, RecalledProcedure } from '@commandos/providers';
import { describe, expect, it, vi } from 'vitest';
import type { RunExecutor } from '../src/executor';
import { CommandRuntime } from '../src/runtime';
import { tempDir } from './helpers';

async function harness() {
  const dir = await tempDir('commandos-providers-');
  const rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: '/nonexistent', useKeychain: false, telemetry: false, revealResults: false, env: {}, settingsOverride: { allowedRoots: [dir], screenshotRoots: [join(dir, 'A')] } });
  return { dir, rt };
}

describe('provider-backed workflows', () => {
  it('recalls the previous operation for “do the same”, binds new inputs, and moves the files', async () => {
    const { dir, rt } = await harness();
    const saved: Procedure[] = [];
    const recall = vi.fn(async (query: string): Promise<RecalledProcedure[]> => saved.filter((p) => p.command === query).map((procedure) => ({ procedure, score: 1, memoryId: procedure.id })));
    const read = vi.fn(async (source: { procedureId: string }) => { const procedure = saved.findLast((p) => p.id === source.procedureId); return procedure ? { procedure, score: 1, memoryId: procedure.id } : null; });
    rt.registerProvider('memory', async () => ({ rememberProcedure: async (p: Procedure) => { saved.push(p); return { memoryId: p.id, sessionId: `session_${p.id}` }; }, rememberOutcome: async () => {}, recallProcedures: recall, readProcedure: read }));
    try {
      for (const name of ['A', 'B', 'C']) {
        await mkdir(join(dir, name));
        await writeFile(join(dir, name, 'Screenshot test.png'), 'fixture');
      }
      const command = `Move my 1 latest screenshot from ${join(dir, 'A')} into a folder called Sorted`;
      const first = await rt.submit(command, 'text');
      expect((await rt.waitForRun(first)).state).toBe('succeeded');
      const repeat = await rt.submit(`Do the same for ${join(dir, 'B')}`, 'text');
      const summary = await rt.waitForRun(repeat);
      expect(summary.state).toBe('succeeded');
      expect(summary.modelCalls).toBe(0);
      expect(read).toHaveBeenCalledOnce();
      expect(recall).not.toHaveBeenCalled();
      expect(await readdir(join(dir, 'B', 'Sorted'))).toContain('Screenshot test.png');
      expect((await rt.getRun(repeat)).events.some((e) => e.type === 'route' && e.decision.via === 'procedure')).toBe(true);
      expect((await rt.getRun(first)).events).toContainEqual(expect.objectContaining({ type: 'log', data: expect.objectContaining({ provider: 'surrealdb', activity: 'saved', procedureId: expect.any(String), memoryId: expect.any(String) }) }));
      expect((await rt.getRun(repeat)).events).toContainEqual(expect.objectContaining({ type: 'log', data: expect.objectContaining({ provider: 'surrealdb', activity: 'recalled', procedureId: expect.any(String) }) }));
      const again = await rt.submit(`Do the same for ${join(dir, 'C')}`, 'text');
      expect((await rt.waitForRun(again)).state).toBe('succeeded');
      expect(read).toHaveBeenCalledTimes(2);
      expect(await readdir(join(dir, 'C', 'Sorted'))).toContain('Screenshot test.png');
    } finally { await rt.shutdown(); }
  });

  it.each(['needs_user', 'blocked'])('does not report success or save an active procedure when the planner finishes %s', async (outcome) => {
    const { dir, rt } = await harness();
    const rememberProcedure = vi.fn();
    rt.registerProvider('memory', async () => ({ rememberProcedure, rememberOutcome: async () => {} }));
    const plannable = rt as unknown as { plan: (run: unknown, route: unknown, executor: RunExecutor) => Promise<{ outcome: string; summary: string }> };
    vi.spyOn(plannable, 'plan').mockImplementation(async (_run, _route, executor) => {
      executor.addPlan({ goal: 'Inspect before asking', tasks: [{ id: 'list', tool: 'fs.list', args: { path: dir } }] });
      executor.seal();
      return { outcome, summary: 'Please specify the remaining work.' };
    });
    try {
      const id = await rt.submit('List the files here', 'text');
      const summary = await rt.waitForRun(id);
      expect(summary.state).toBe('partial');
      expect(summary.summary).not.toMatch(/All .* steps succeeded/);
      expect((await rt.runMetrics(id)).verifiedSuccess).toBe(false);
      expect(rememberProcedure).not.toHaveBeenCalled();
    } finally { await rt.shutdown(); }
  });

  it('bounds optional memory hints so an unresponsive service cannot stall planning', async () => {
    const { rt } = await harness();
    rt.registerProvider('memory', async () => ({ recallProcedures: () => new Promise(() => {}) }));
    try {
      const started = performance.now();
      const context = await (rt as unknown as { planningContext: (command: string) => Promise<string[]> }).planningContext('summarize these documents');
      expect(context).toEqual([]);
      expect(performance.now() - started).toBeLessThan(900);
    } finally { await rt.shutdown(); }
  });
});
