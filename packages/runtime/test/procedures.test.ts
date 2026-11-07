import { defaultSettings, type RouteDecision } from '@commandos/contracts';
import { createDefaultRegistry, fsMkdir, reportWrite } from '@commandos/tools';
import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../src/executor';
import { bindDeterministic, buildProcedure, checkFingerprint, extractParameters, instantiate, toolVersion } from '../src/procedures';
import { matchRepoFix, matchReplay } from '../src/router';

const decision = (intent: RouteDecision['intent']): RouteDecision => ({
  mode: 'fast',
  intent,
  confidence: 0.9,
  via: 'grammar',
  reason: 'test',
  slots: {},
  needsFullPreview: false,
});

const fingerprint = { tools: {}, apps: {}, sites: {}, os: '25' };

describe('procedure memory records', () => {
  it('replays the screenshot template on a new folder with zero model calls', () => {
    const proc = buildProcedure({
      runId: 'run_a',
      command: 'organize my 3 latest screenshots from ~/A into a folder called Sorted',
      decision: decision('organize_screenshots'),
      organize: {
        count: 3,
        sourceFolder: '~/A',
        destinationFolder: null,
        destinationName: 'Sorted',
        renameByContent: true,
        groupByCategory: true,
        withinDays: null,
        report: true,
        reportTitle: null,
      },
      records: [],
      fingerprint,
      durationMs: 1200,
      summary: 'Moved 3 file(s) into ~/A/Sorted.',
    });
    expect(proc.mode).toBe('template');
    const values = bindDeterministic(proc, 'Do the same for ~/B please');
    expect(values).toEqual({ sourceFolder: '~/B' });
    const plan = instantiate(proc, values ?? {}, defaultSettings(), { reveal: false });
    const find = plan.tasks.find((t) => t.id === 'find');
    expect(find?.args).toMatchObject({ roots: ['~/B'], limit: 3 });
    const organize = plan.tasks.find((t) => t.id === 'organize');
    expect(String(organize?.args.destinationDir)).toMatch(/\/B\/Sorted$/);
    expect(plan.tasks.map((t) => t.tool)).toContain('report.write');
  });

  it('extracts and rebases path parameters of planned procedures', () => {
    const records = [
      { spec: { id: 't1', tool: 'fs.mkdir', args: { path: '~/Demo/In/out' }, dependsOn: [], bind: [], preconditions: [], postconditions: [] }, tool: fsMkdir },
      {
        spec: { id: 't2', tool: 'report.write', args: { title: 'Summary', outputPath: '~/Demo/In/out/summary.md', entries: [] }, dependsOn: ['t1'], bind: [], preconditions: [], postconditions: [] },
        tool: reportWrite,
      },
    ] as unknown as TaskRecord[];
    const params = extractParameters(records, 'write a summary of ~/Demo/In');
    expect(params.map((p) => p.name)).toEqual(['t1.path', 't2.title', 't2.outputPath']);
    const proc = buildProcedure({ runId: 'r', command: 'write a summary of ~/Demo/In', decision: decision('file_operations'), records, fingerprint, durationMs: 1, summary: 's' });
    expect(proc.mode).toBe('plan');
    const values = bindDeterministic(proc, 'do the same in ~/Other');
    expect(values).toEqual({ 't1.path': '~/Other/out', 't2.outputPath': '~/Other/out/summary.md' });
    const plan = instantiate(proc, values ?? {}, defaultSettings());
    expect(plan.tasks[1]?.args).toMatchObject({ outputPath: '~/Other/out/summary.md' });
    expect(plan.tasks[1]?.dependsOn).toEqual(['t1']);
  });

  it('detects tool contract changes in fingerprints', async () => {
    const registry = createDefaultRegistry();
    const ok = await checkFingerprint({ ...fingerprint, os: (await import('node:os')).release().split('.')[0] as string, tools: { 'fs.mkdir': toolVersion(registry, 'fs.mkdir') } }, registry, null);
    expect(ok).toEqual([]);
    const changed = await checkFingerprint({ ...fingerprint, tools: { 'fs.mkdir': 'old' } }, registry, null);
    expect(changed.join()).toMatch(/tool fs.mkdir changed/);
  });

  it('routes replay and repo-fix phrasings locally', () => {
    expect(matchReplay('Do the same for my Downloads folder')).toBe(true);
    expect(matchReplay('repeat that on ~/Desktop/Inbox')).toBe(true);
    expect(matchReplay('rename these files')).toBe(false);
    expect(matchRepoFix('Run the tests in ~/code/calc-lib and fix the failures')).toEqual({ repoPath: '~/code/calc-lib' });
    expect(matchRepoFix('run the tests in ~/code/x and push a fix')).toBeNull();
  });
});
