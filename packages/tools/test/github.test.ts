import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultSettings } from '@commandos/contracts';
import { describe, expect, it } from 'vitest';
import { githubRepositoryUrl, repoLocate } from '../src/github';
import { HelperClient } from '../src/helper/client';
import type { ToolContext } from '../src/types';
import { webOpen } from '../src/web';

function context(root: string): ToolContext {
  return { runId: 'run_locate', taskId: 'resolve', signal: new AbortController().signal, dryRun: false, settings: { ...defaultSettings(), allowedRoots: [root] }, helper: new HelperClient('/nonexistent'), models: null, providers: { get: async () => { throw new Error('No providers'); } }, journal: { record: async () => {} }, artifactsDir: root, log: () => {}, progress: () => {} };
}

async function checkout(dir: string, remote = 'https://github.com/example/checkout-demo.git') {
  await mkdir(dir, { recursive: true });
  await promisify(execFile)('git', ['init', '-q', dir]);
  await promisify(execFile)('git', ['-C', dir, 'config', '--local', 'remote.origin.url', remote]);
}

describe('GitHub repository resolution', () => {
  it.each([
    ['https://github.com/example/checkout-demo.git', 'https://github.com/example/checkout-demo'],
    ['git@github.com:example/checkout-demo.git', 'https://github.com/example/checkout-demo'],
    ['ssh://git@github.com/example/checkout-demo.git', 'https://github.com/example/checkout-demo'],
    ['https://username:password@github.com/example/checkout-demo.git', 'https://github.com/example/checkout-demo'],
    ['https://github.com/checkout-demo', null],
    ['https://other.example/example/checkout-demo', null],
  ])('canonicalizes a remote without disclosing credentials: %s', (remote, expected) => {
    expect(githubRepositoryUrl(remote)).toBe(expected);
  });

  it('finds the actual owner and local checkout without browser or model calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commandos-github-'));
    try {
      const repo = join(root, 'checkout-demo');
      await checkout(repo);
      expect(await repoLocate.run({ name: 'checkout-demo', roots: [root] }, context(root))).toEqual({ matches: [{ repoPath: repo, repositoryUrl: 'https://github.com/example/checkout-demo' }], truncated: false });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps multiple matches ambiguous and skips protected paths and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commandos-github-'));
    try {
      const first = join(root, 'A', 'checkout-demo');
      const second = join(root, 'B', 'checkout-demo');
      await checkout(first);
      await checkout(second, 'git@github.com:another/checkout-demo.git');
      const ctx = context(root);
      expect((await repoLocate.run({ name: 'checkout-demo', roots: [root] }, ctx)).matches).toHaveLength(2);
      ctx.settings.deniedPaths.push(join(root, 'B'));
      await symlink(second, join(root, 'checkout-demo'));
      expect((await repoLocate.run({ name: 'checkout-demo', roots: [root] }, ctx)).matches).toEqual([{ repoPath: first, repositoryUrl: 'https://github.com/example/checkout-demo' }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not associate a folder with a different GitHub repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commandos-github-'));
    try {
      await checkout(join(root, 'checkout-demo'), 'https://github.com/example/different.git');
      expect((await repoLocate.run({ name: 'checkout-demo', roots: [root] }, context(root))).matches).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects ownerless issue URLs before opening a browser', () => {
    expect(webOpen.args.safeParse({ url: 'https://github.com/checkout-demo/issues/1' }).success).toBe(false);
    expect(webOpen.args.safeParse({ url: 'https://github.com/example/checkout-demo/issues/1' }).success).toBe(true);
  });
});
