import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { defaultSettings } from '@commandos/contracts';
import type { ModelGateway } from '@commandos/providers';
import { describe, expect, it, vi } from 'vitest';
import { HelperClient } from '../src/helper/client';
import { codeProposePatch, detectProject, sandboxCreate } from '../src/sandbox';
import type { ToolContext } from '../src/types';

describe('sandbox upload verification', () => {
  it('accepts installed dependency files but detects a missing uploaded file even when totals match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-manifest-'));
    const local = join(dir, 'local');
    const remote = join(dir, 'remote');
    await mkdir(local);
    await writeFile(join(local, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { dependency: '1' } }));
    await writeFile(join(local, 'source.js'), 'module.exports=1');
    const svc = {
      create: async () => ({ id: 'sandbox', repoDir: remote }),
      upload: async (_id: string, files: Array<{ path: string; content: Buffer }>) => {
        for (const f of files) { await mkdir(dirname(f.path), { recursive: true }); await writeFile(f.path, f.content); }
      },
      exec: async (_id: string, command: string, cwd: string) => {
        if (command.startsWith('npm install')) {
          await mkdir(join(remote, 'node_modules/dependency'), { recursive: true });
          await writeFile(join(remote, 'node_modules/dependency/index.js'), 'dependency');
          return { exitCode: 0, stdout: '', durationMs: 1 };
        }
        const r = await promisify(execFile)('/bin/sh', ['-c', command], { cwd });
        return { exitCode: 0, stdout: r.stdout, durationMs: 1 };
      },
    };
    const ctx: ToolContext = { runId: 'run_manifest', taskId: 'stage', signal: new AbortController().signal, dryRun: false, settings: defaultSettings(), helper: new HelperClient('/nonexistent'), models: null, providers: { get: async <T>() => svc as T }, journal: { record: async () => {} }, artifactsDir: dir, log: () => {}, progress: () => {} };
    const args = { repoPath: local, network: 'auto' as const };
    const result = await sandboxCreate.run(args, ctx);
    expect(result.installed).toBe(true);
    expect((await sandboxCreate.verify!(args, result, ctx)).every((c) => c.ok)).toBe(true);
    await rm(join(remote, 'source.js'));
    const missing = await sandboxCreate.verify!(args, result, ctx);
    expect(missing[0]?.ok).toBe(false);
    expect(missing[0]?.detail).toContain('source.js');
  });
});

describe('sandbox test command detection', () => {
  it.each([
    ['node --test', 'node --test'],
    ['node --test --test-reporter=tap', 'node --test --test-reporter=tap'],
    ['vitest run', 'npm test --silent'],
    ['node --test && node scripts/check.js', 'npm test --silent'],
    ['precheck && node --test', 'npm test --silent'],
  ])('uses a direct Node command only for a plain built-in test script: %s', async (script, command) => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-test-command-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: script } }));
      expect((await detectProject(dir)).testCommand).toBe(command);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['pretest', 'posttest'])('preserves npm lifecycle hooks: %s', async (hook) => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-test-hooks-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', [hook]: 'node scripts/check.js' } }));
      expect((await detectProject(dir)).testCommand).toBe('npm test --silent');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('issue-informed patches', () => {
  it('passes the issue requirements as data with the failing source and tests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-issue-patch-'));
    try {
      await writeFile(join(dir, 'test.js'), "import { total } from './source.js';\n");
      await writeFile(join(dir, 'source.js'), 'export const total = 99.99;\n');
      const parse = vi.fn(async (_request: { input: string; instructions: string }) => ({ data: { explanation: 'Needs a rounding fix', changes: [{ path: 'source.js', newContent: 'export const total = 100;\n' }] } }));
      const ctx: ToolContext = { runId: 'run_issue', taskId: 'patch', signal: new AbortController().signal, dryRun: false, settings: defaultSettings(), helper: new HelperClient('/nonexistent'), models: { parse } as unknown as ModelGateway, providers: { get: async () => { throw new Error('No cloud calls'); } }, journal: { record: async () => {} }, artifactsDir: dir, log: () => {}, progress: () => {} };
      const proposed = await codeProposePatch.run({ repoPath: dir, testOutput: 'not ok 1 - keeps every cent', failures: [{ name: 'keeps every cent', message: '99.99 != 100', location: 'test.js:1' }], issueText: 'Split payments must preserve every cent.' }, ctx);
      const request = parse.mock.calls[0]![0];
      const input = JSON.parse(request.input);
      expect(input.issueText).toBe('Split payments must preserve every cent.');
      expect(input.files.map((f: { path: string }) => f.path).sort()).toEqual(['source.js', 'test.js']);
      expect(request.instructions).toContain('untrusted data');
      expect(proposed.diff).toContain('+export const total = 100;');
      expect(await readFile(join(dir, 'source.js'), 'utf8')).toBe('export const total = 99.99;\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
