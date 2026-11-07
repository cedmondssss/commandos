import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type HelperMethodName,
  HelperMethods,
  type HelperParams,
  HelperResponseSchema,
  type HelperResult,
  type HelperStatus,
} from '@commandos/contracts';

export class HelperCallError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'HelperCallError';
  }
}

export class HelperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperUnavailableError';
  }
}

interface Pending {
  proc: ChildProcessWithoutNullStreams;
  method: string;
  resolve: (raw: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

export interface HelperClientOptions {
  defaultTimeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Typed JSON-lines RPC client for the Swift helper. Params and results are validated with the
 * shared Zod contracts on both sides of the wire. The process restarts lazily after a crash
 * (at most 5 times per minute).
 */
export class HelperClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private starting: Promise<void> | null = null;
  private restartTimes: number[] = [];
  private generation = 0;
  version: string | undefined;
  lastError: string | undefined;

  constructor(
    readonly binaryPath: string,
    private readonly opts: HelperClientOptions = {},
  ) {}

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  status(): HelperStatus {
    return {
      running: this.running,
      path: this.binaryPath,
      ...(this.version ? { version: this.version } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.running) return;
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < 60_000);
    if (this.restartTimes.length >= 5) {
      throw new HelperUnavailableError('helper crashed repeatedly; not restarting for a minute');
    }
    this.restartTimes.push(now);
    this.starting = new Promise<void>((resolve, reject) => {
      if (!existsSync(this.binaryPath)) {
        this.lastError = `helper binary not found at ${this.binaryPath} (run pnpm build:helper)`;
        reject(new HelperUnavailableError(this.lastError));
        return;
      }
      const proc = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      let ready = false;
      const readyTimer = setTimeout(() => {
        if (!ready) {
          this.lastError = 'helper did not report ready within 5 s';
          proc.kill('SIGKILL');
          reject(new HelperUnavailableError(this.lastError));
        }
      }, 5_000);
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const readyNow = this.onLine(line);
        if (readyNow && !ready) {
          ready = true;
          clearTimeout(readyTimer);
          this.lastError = undefined;
          resolve();
        }
      });
      proc.stderr.on('data', (d: Buffer) => this.opts.log?.(`helper stderr: ${d.toString().trim()}`));
      proc.on('error', (e) => {
        this.lastError = e.message;
        clearTimeout(readyTimer);
        if (!ready) reject(new HelperUnavailableError(e.message));
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(readyTimer);
        if (this.proc === proc) this.proc = null;
        const reason = `helper exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
        if (code !== 0 && code !== null) this.lastError = reason;
        for (const [id, p] of this.pending) {
          if (p.proc !== proc) continue;
          this.pending.delete(id);
          p.cleanup();
          p.reject(new HelperCallError(p.method, 'helper_exited', reason));
        }
        if (!ready) reject(new HelperUnavailableError(reason));
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Returns true when the line was the ready event. */
  private onLine(line: string): boolean {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.log?.(`helper sent non-JSON line: ${line.slice(0, 200)}`);
      return false;
    }
    if (msg && typeof msg === 'object' && 'event' in msg) {
      const ev = msg as { event: string; version?: string };
      if (ev.event === 'ready') {
        this.version = ev.version;
        return true;
      }
      return false;
    }
    const parsed = HelperResponseSchema.safeParse(msg);
    if (!parsed.success) {
      this.opts.log?.(`helper sent malformed response: ${line.slice(0, 200)}`);
      return false;
    }
    const p = this.pending.get(parsed.data.id);
    if (!p) return false;
    this.pending.delete(parsed.data.id);
    p.cleanup();
    if (parsed.data.ok) p.resolve(parsed.data.result);
    else p.reject(new HelperCallError(p.method, parsed.data.error.code, parsed.data.error.message));
    return false;
  }

  async call<M extends HelperMethodName>(
    method: M,
    params: HelperParams<M>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<HelperResult<M>> {
    const schema = HelperMethods[method];
    const validParams = schema.params.parse(params);
    if (opts.signal?.aborted) throw new HelperCallError(method, 'aborted', 'cancelled');
    const generation = this.generation;
    await this.start();
    if (opts.signal?.aborted || generation !== this.generation) throw new HelperCallError(method, 'aborted', 'cancelled');
    const proc = this.proc;
    if (!proc) throw new HelperUnavailableError('helper is not running');
    const id = String(++this.seq);
    const timeoutMs = opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? 15_000;
    return new Promise<HelperResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new HelperCallError(method, 'timeout', `timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        reject(new HelperCallError(method, 'aborted', 'cancelled'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        proc,
        method,
        cleanup,
        reject,
        resolve: (raw) => {
          const result = schema.result.safeParse(raw);
          if (result.success) resolve(result.data as HelperResult<M>);
          else reject(new HelperCallError(method, 'bad_result', `result failed validation: ${result.error.message}`));
        },
      });
      proc.stdin.write(`${JSON.stringify({ id, method, params: validParams })}\n`);
    });
  }

  stop(force = false): void {
    ++this.generation;
    this.restartTimes = []; // intentional stops are not repeated crashes
    const proc = this.proc;
    this.proc = null;
    for (const [id, p] of this.pending) {
      if (p.proc !== proc) continue;
      this.pending.delete(id);
      p.cleanup();
      p.reject(new HelperCallError(p.method, 'aborted', 'helper stopped'));
    }
    if (proc) {
      proc.stdin.end();
      proc.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  }
}

/** Locates the helper binary: env override, packaged resources, then the repo build output. */
export function findHelperBinary(startDir: string = process.cwd()): string {
  const env = process.env.COMMANDOS_HELPER_PATH;
  if (env && existsSync(env)) return env;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'bin', 'CommandOSHelper');
    if (existsSync(packaged)) return packaged;
  }
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'apps', 'desktop', 'resources', 'bin', 'CommandOSHelper');
    if (existsSync(candidate)) return candidate;
    const sibling = join(dir, 'resources', 'bin', 'CommandOSHelper');
    if (existsSync(sibling)) return sibling;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return env ?? join(startDir, 'apps', 'desktop', 'resources', 'bin', 'CommandOSHelper');
}
