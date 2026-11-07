import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SafetyReportSchema, safetyScore } from '@commandos/contracts';
import { fsWriteText } from '@commandos/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafetyLab, runSafetyLab } from '../src/safety';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('Safety Lab evidence', () => {
  it('executes all controls, coalesces simultaneous requests and persists validated evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-safety-report-')); dirs.push(dir);
    const lab = new SafetyLab(dir);
    expect(await lab.report()).toBeNull();
    const pending = lab.run();
    expect(lab.run()).toBe(pending);
    const report = await pending;
    expect(SafetyReportSchema.parse(report)).toEqual(report);
    expect(report.cases).toHaveLength(10);
    expect(report.cases.map((c) => [c.id, c.status])).toEqual([
      ['allowed-read', 'passed'], ['write-undo', 'passed'], ['outside-write', 'passed'],
      ['symlink-escape', 'passed'], ['injected-send', 'passed'], ['denied-delete', 'passed'],
      ['approval-timeout', 'passed'], ['stop-queued', 'passed'], ['submission-guard', 'passed'],
      ['selector-recovery', 'passed'],
    ]);
    expect(safetyScore(report.cases)).toEqual({ passed: 10, total: 10, percent: 100 });
    expect(safetyScore(report.cases, 'usefulness').total).toBe(2);
    expect(await lab.report()).toEqual(report);
    expect(JSON.parse(await readFile(join(dir, `${report.id}.json`), 'utf8'))).toEqual(report);
    const evidence = report.cases.find((c) => c.id === 'injected-send')!;
    expect(evidence.evidence.join('\n')).toContain('send: policy=require_approval');
    expect(evidence.evidence.join('\n')).toContain('denied; by=user (fixture response)');
    expect(JSON.stringify(report)).not.toMatch(/commandos-safety-[A-Za-z0-9]{6}\//);
  });

  it('keeps cancelled cases in the denominator and never fabricates passes', async () => {
    const controller = new AbortController(); controller.abort();
    const report = await runSafetyLab(controller.signal);
    expect(report.cases).toHaveLength(10);
    expect(report.cases.every((c) => c.status === 'cancelled' && c.evidence.length === 0)).toBe(true);
    expect(safetyScore(report.cases)).toEqual({ passed: 0, total: 10, percent: 0 });
    const changed = [...report.cases];
    changed[0] = { ...changed[0]!, status: 'error' };
    changed[1] = { ...changed[1]!, status: 'passed' };
    expect(safetyScore(changed)).toEqual({ passed: 1, total: 10, percent: 10 });
    expect(safetyScore([]).percent).toBeNull();
  });

  it('loads the repository CLI report in development when the app has no saved run yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commandos-safety-fallback-')); dirs.push(root);
    const source = new SafetyLab(join(root, 'cli'));
    const report = await source.run();
    const appLab = new SafetyLab(join(root, 'app'), join(root, 'cli', 'latest.json'));
    expect(await appLab.report()).toEqual(report);
    const appReport = await appLab.run();
    expect(await appLab.report()).toEqual(appReport);
    expect((await appLab.report())?.id).toBe(appReport.id);
  });

  it('cancels an in-flight run and saves its actual partial outcome', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-safety-cancel-')); dirs.push(dir);
    const lab = new SafetyLab(dir);
    const result = lab.run();
    expect(lab.cancel()).toBe(true);
    const report = await result;
    expect(report.cases.some((c) => c.status === 'cancelled')).toBe(true);
    expect(safetyScore(report.cases).passed).toBeLessThan(10);
    expect(await lab.report()).toEqual(report);
    expect(lab.cancel()).toBe(false);
  });

  it('reports an actual failed production verification as failure rather than a pass', async () => {
    vi.spyOn(fsWriteText, 'verify').mockResolvedValueOnce([{ label: 'Fault-injected read-back failure', ok: false }]);
    const report = await runSafetyLab();
    const write = report.cases.find((c) => c.id === 'write-undo')!;
    expect(write.status).toBe('failed');
    expect(write.checks.some((c) => !c.ok)).toBe(true);
    expect(write.evidence.join('\n')).toContain('Fault-injected read-back failure');
    expect(safetyScore(report.cases)).toEqual({ passed: 9, total: 10, percent: 90 });
  });
});
