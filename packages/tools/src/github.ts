import { execFile } from 'node:child_process';
import { lstat, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PathArg } from './fs';
import { isWithin, resolveUserPath } from './paths';
import { scrubbedEnv } from './terminal';
import { defineTool } from './types';

/** Return only a canonical GitHub web URL, never credentials embedded in a remote. */
export function githubRepositoryUrl(remote: string): string | null {
  const normalized = remote.trim().replace(/^git@github\.com:/i, 'https://github.com/');
  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== 'github.com' || !['https:', 'http:', 'ssh:'].includes(url.protocol)) return null;
    const match = /^\/([\w.-]+)\/([\w.-]+?)\/?$/.exec(url.pathname.replace(/\.git\/?$/, ''));
    if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null;
    return `https://github.com/${match[1]}/${match[2]}`;
  } catch { return null; }
}

const SKIP = new Set(['node_modules', 'Library', 'dist', 'build', 'out', 'coverage', 'runs']);

/** Find named local checkouts before a planner has to infer a GitHub owner. */
export const repoLocate = defineTool({
  id: 'repo.locate',
  title: 'Resolve local GitHub checkout',
  description: 'Find a named local checkout and read its origin remote. Prefer direct children of the provided roots; if none match, search at most two levels deep. Returns canonical GitHub URLs, never credentials. Multiple matches are ambiguous; never guess the owner.',
  tier: 1,
  args: z.object({ name: z.string().regex(/^[\w.-]+$/).max(100).refine((s) => s !== '.' && s !== '..'), roots: z.array(PathArg).min(1).max(20) }),
  output: z.object({ matches: z.array(z.object({ repoPath: z.string(), repositoryUrl: z.string() })), truncated: z.boolean() }),
  effectClass: 'read',
  effects: ['fs_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 10_000,
  paths: (a) => ({ read: a.roots, write: [] }),
  async run(a, ctx) {
    const roots = a.roots.map(resolveUserPath);
    const denied = ctx.settings.deniedPaths.map(resolveUserPath);
    const visited = new Set<string>();
    const matches: Array<{ repoPath: string; repositoryUrl: string }> = [];
    let truncated = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (ctx.signal.aborted || visited.has(dir)) return;
      if (denied.some((d) => isWithin(d, dir)) || !roots.some((r) => isWithin(r, dir))) return;
      if (visited.size >= 500) { truncated = true; return; }
      visited.add(dir);
      const metadata = await lstat(dir).catch(() => null);
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return;
      if (basename(dir).toLowerCase() === a.name.toLowerCase()) {
        const git = await lstat(join(dir, '.git')).catch(() => null);
        if (git?.isDirectory() && !git.isSymbolicLink() && !denied.some((d) => isWithin(d, join(dir, '.git')))) {
          const remote = await promisify(execFile)('git', ['config', '--local', '--get', 'remote.origin.url'], { cwd: dir, env: scrubbedEnv(), timeout: 1500, maxBuffer: 4096, signal: ctx.signal }).catch(() => ({ stdout: '' }));
          const repositoryUrl = githubRepositoryUrl(remote.stdout);
          if (repositoryUrl?.split('/').at(-1)?.toLowerCase() === a.name.toLowerCase()) matches.push({ repoPath: dir, repositoryUrl });
        }
        return;
      }
      if (depth >= 2) return;
      const entries = await opendir(dir).catch(() => null);
      if (!entries) return;
      for await (const entry of entries) {
        if (ctx.signal.aborted) return;
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) await walk(join(dir, entry.name), depth + 1);
      }
    };
    // Check direct children first so a large unrelated tree does not consume the
    // entire search budget before other configured roots are examined.
    for (const root of roots) await walk(join(root, a.name), 2);
    if (matches.length) return { matches: matches.sort((x, y) => x.repoPath.localeCompare(y.repoPath)), truncated: false };
    for (const root of roots) await walk(root, 0);
    matches.sort((x, y) => x.repoPath.localeCompare(y.repoPath));
    return { matches, truncated };
  },
});
