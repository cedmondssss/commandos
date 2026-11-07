import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { RiskLevel } from '@commandos/contracts';
import { z } from 'zod';
import { PathArg } from './fs';
import { displayPath, resolveUserPath } from './paths';
import { defineTool, ToolError } from './types';

export type CommandClass = 'read' | 'approve' | 'deny';

const READ_ONLY = new Set([
  'ls', 'pwd', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df', 'which', 'uname', 'sw_vers', 'date', 'echo', 'sort', 'uniq',
  'cut', 'tr', 'shasum', 'md5', 'mdls', 'mdfind', 'cat', 'tree', 'jq', 'grep', 'egrep', 'rg', 'diff', 'cmp', 'basename', 'dirname',
]);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'remote', 'tag', 'config']);
const GIT_WRITE = new Set(['add', 'commit', 'checkout', 'switch', 'stash', 'merge', 'pull', 'fetch', 'apply', 'restore', 'mv', 'init']);
const ALWAYS_DENY = new Set([
  'sudo', 'su', 'doas', 'rm', 'rmdir', 'dd', 'mkfs', 'diskutil', 'launchctl', 'chmod', 'chown', 'chflags', 'ssh', 'scp', 'sftp', 'rsync',
  'curl', 'wget', 'nc', 'ncat', 'telnet', 'osascript', 'security', 'shutdown', 'reboot', 'halt', 'kill', 'killall', 'pkill', 'crontab',
  'bash', 'sh', 'zsh', 'fish', 'eval', 'exec', 'open', 'csrutil', 'nvram', 'pmset', 'spctl', 'tccutil', 'defaults',
]);

/**
 * Classifies an argv command. There is no shell: arguments are passed verbatim, so pipes,
 * redirects and substitutions are impossible. Read-only inspection runs freely; commands that
 * change repositories or run project code need approval; dangerous binaries are refused.
 */
export function classifyCommand(argv: string[]): { cls: CommandClass; reason: string; risk: RiskLevel } {
  const bin = basename(argv[0] ?? '');
  const args = argv.slice(1);
  if (!bin) return { cls: 'deny', reason: 'empty command', risk: 'high' };
  if (ALWAYS_DENY.has(bin)) return { cls: 'deny', reason: `${bin} is not allowed (use the dedicated tools instead)`, risk: 'critical' };
  if (bin === 'find') {
    const bad = args.find((a) => ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fls'].includes(a));
    return bad ? { cls: 'deny', reason: `find ${bad} is not allowed`, risk: 'high' } : { cls: 'read', reason: 'read-only search', risk: 'none' };
  }
  if (bin === 'plutil') return args[0] === '-p' ? { cls: 'read', reason: 'print plist', risk: 'none' } : { cls: 'deny', reason: 'only plutil -p is allowed', risk: 'high' };
  if (bin === 'sips') return args.every((a) => !a.startsWith('--set') && !['-s', '-r', '-z', '-Z', '-c', '-p', '--out', '-o'].includes(a)) ? { cls: 'read', reason: 'image info', risk: 'none' } : { cls: 'deny', reason: 'sips may only read properties', risk: 'medium' };
  if (READ_ONLY.has(bin)) return { cls: 'read', reason: 'read-only command', risk: 'none' };
  if (bin === 'git') {
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    if (GIT_READ.has(sub)) {
      if (sub === 'config' && !args.includes('--get') && !args.includes('--list')) return { cls: 'approve', reason: 'git config changes settings', risk: 'medium' };
      if ((sub === 'branch' || sub === 'tag') && args.some((a) => ['-d', '-D', '--delete', '-m', '-M'].includes(a))) return { cls: 'approve', reason: `git ${sub} modifies refs`, risk: 'medium' };
      return { cls: 'read', reason: `git ${sub} is read-only`, risk: 'none' };
    }
    if (GIT_WRITE.has(sub)) return { cls: 'approve', reason: `git ${sub} changes the repository`, risk: 'medium' };
    return { cls: 'deny', reason: `git ${sub || '(no subcommand)'} is not allowed (push, reset, clean, rebase… are blocked)`, risk: 'high' };
  }
  if (['node', 'npm', 'pnpm', 'yarn', 'python3', 'python', 'swift', 'make', 'cargo', 'go', 'npx', 'bun', 'deno'].includes(bin)) {
    if (args.length === 1 && ['-v', '--version', 'version', '-V'].includes(args[0] as string)) return { cls: 'read', reason: 'version check', risk: 'none' };
    return { cls: 'approve', reason: `${bin} runs project code on this Mac (prefer sandbox.* tools)`, risk: 'high' };
  }
  if (bin === 'shortcuts') return args[0] === 'list' ? { cls: 'read', reason: 'list shortcuts', risk: 'none' } : { cls: 'approve', reason: 'runs a shortcut', risk: 'medium' };
  return { cls: 'deny', reason: `${bin} is not on the command allowlist`, risk: 'high' };
}

const SAFE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM'];

/** Child environment without credentials or tokens. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  env.PATH = env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';
  return env;
}

/** Process groups started by terminal.run, so emergency stop can kill them. */
export const runningProcesses = new Set<number>();

export function killAllProcesses(): number {
  let n = 0;
  for (const pid of runningProcesses) {
    try {
      process.kill(-pid, 'SIGKILL');
      n++;
    } catch {
      // already gone
    }
  }
  runningProcesses.clear();
  return n;
}

const MAX_OUT = 20_000;

export const terminalRun = defineTool({
  id: 'terminal.run',
  title: 'Run terminal command',
  description:
    'Run one allowlisted command as an argv array (no shell: no pipes, redirects or globs) in a working directory inside the allowed folders. Read-only commands (ls, cat, grep, find, git status/log/diff…) run freely; git changes and running project code need approval; rm, sudo, curl, osascript and similar are refused. Returns exit code, stdout and stderr (truncated).',
  tier: 1,
  args: z.object({
    argv: z.array(z.string().max(4000)).min(1).max(64),
    cwd: PathArg,
    timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
    expectZeroExit: z.boolean().default(false),
  }),
  output: z.object({
    argv: z.array(z.string()),
    cwd: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    durationMs: z.number(),
  }),
  effectClass: (a) => (classifyCommand(a.argv).cls === 'read' ? 'read' : 'irreversible_local'),
  effects: ['process_exec'],
  risk: (a) => classifyCommand(a.argv).risk,
  idempotent: false,
  defaultTimeoutMs: 620_000,
  paths: (a) => ({ read: [a.cwd], write: [] }),
  resources: (a) => (classifyCommand(a.argv).cls === 'read' ? [] : [`fs:${resolveUserPath(a.cwd)}`]),
  preview: (a) => ({ summary: `Run \`${a.argv.join(' ')}\` in ${displayPath(resolveUserPath(a.cwd))}`, details: [classifyCommand(a.argv).reason] }),
  async run(a, ctx) {
    const verdict = classifyCommand(a.argv);
    if (verdict.cls === 'deny') throw new ToolError('denied', verdict.reason);
    const cwd = resolveUserPath(a.cwd);
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const child = spawn(a.argv[0] as string, a.argv.slice(1), { cwd, env: scrubbedEnv(), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid) runningProcesses.add(child.pid);
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const append = (buf: Buffer, which: 'out' | 'err') => {
        const text = buf.toString('utf8');
        if (which === 'out') {
          if (stdout.length < MAX_OUT) stdout += text;
          else truncated = true;
        } else if (stderr.length < MAX_OUT) stderr += text;
        else truncated = true;
      };
      child.stdout.on('data', (b: Buffer) => append(b, 'out'));
      child.stderr.on('data', (b: Buffer) => append(b, 'err'));
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // gone
          }
        }
      };
      const timer = setTimeout(kill, a.timeoutMs);
      ctx.signal.addEventListener('abort', kill, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        if (child.pid) runningProcesses.delete(child.pid);
        reject(new ToolError('spawn_failed', e.message));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (child.pid) runningProcesses.delete(child.pid);
        resolve({
          argv: a.argv,
          cwd,
          exitCode: code,
          signal: signal ?? null,
          stdout: stdout.slice(0, MAX_OUT),
          stderr: stderr.slice(0, MAX_OUT),
          truncated: truncated || stdout.length > MAX_OUT || stderr.length > MAX_OUT,
          durationMs: performance.now() - started,
        });
      });
    });
  },
  async verify(a, o) {
    return a.expectZeroExit ? [{ label: `exit code 0 for ${a.argv[0]}`, ok: o.exitCode === 0, detail: `exit ${o.exitCode}` }] : [];
  },
  summarize: (o) => ({ argv: o.argv.join(' '), exitCode: o.exitCode, stdout: o.stdout.slice(0, 3000), stderr: o.stderr.slice(0, 1500), truncated: o.truncated }),
});

export const terminalTools = [terminalRun];
