import { join } from 'node:path';
import {
  type AppStatus,
  type PushChannel,
  RuntimeOutboundSchema,
  type RuntimeInbound,
} from '@commandos/contracts';
import { type UtilityProcess, utilityProcess } from 'electron';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RuntimeHostOptions {
  entry: string;
  env: Record<string, string>;
  onPush: (channel: PushChannel, payload: unknown) => void;
  log: (message: string) => void;
}

/**
 * Owns the runtime utilityProcess: request/response correlation, push forwarding, crash
 * restarts, and a hard kill for emergency stop when the runtime does not respond in time.
 */
export class RuntimeHost {
  private child: UtilityProcess | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stopping = false;
  private readyWaiters: Array<() => void> = [];
  status: AppStatus['runtime'] = 'starting';

  constructor(private readonly opts: RuntimeHostOptions) {}

  start(): void {
    this.status = this.child ? 'restarting' : 'starting';
    const child = utilityProcess.fork(this.opts.entry, [], {
      serviceName: 'CommandOS Runtime',
      stdio: 'pipe',
      env: { ...this.opts.env },
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => this.opts.log(`[runtime] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => this.opts.log(`[runtime:err] ${d.toString().trimEnd()}`));
    child.on('message', (raw: unknown) => {
      const parsed = RuntimeOutboundSchema.safeParse(raw);
      if (!parsed.success) {
        this.opts.log(`dropped malformed runtime message: ${parsed.error.message}`);
        return;
      }
      const msg = parsed.data;
      switch (msg.kind) {
        case 'ready':
          this.status = 'ready';
          for (const w of this.readyWaiters.splice(0)) w();
          this.opts.onPush('app:status', { runtime: 'ready', activeRunIds: [], pendingApprovals: 0 });
          break;
        case 'push':
          this.opts.onPush(msg.channel, msg.payload);
          break;
        case 'response':
        case 'error': {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.kind === 'response') p.resolve(msg.result);
          else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
          break;
        }
      }
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`runtime exited (code ${code})`));
        this.pending.delete(id);
      }
      if (this.stopping) return;
      this.status = 'crashed';
      this.opts.onPush('app:status', { runtime: 'crashed', activeRunIds: [], pendingApprovals: 0 });
      this.opts.log(`runtime exited with code ${code}; restarting`);
      setTimeout(() => {
        if (!this.stopping) this.start();
      }, 1000);
    });
  }

  ready(): Promise<void> {
    if (this.status === 'ready') return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  private post(msg: RuntimeInbound): void {
    if (!this.child) throw new Error('runtime is not running');
    this.child.postMessage(msg);
  }

  async request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const started = Date.now();
    let readyTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.ready(), new Promise((_, rej) => { readyTimer = setTimeout(() => rej(new Error('runtime not ready')), Math.min(timeoutMs, 15_000)); })]);
    } finally { clearTimeout(readyTimer); }
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`runtime request ${method} timed out`));
      }, Math.max(1, timeoutMs - (Date.now() - started)));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.post({ kind: 'request', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  sendAudio(chunk: Uint8Array<ArrayBuffer>): void {
    if (this.status !== 'ready' || !this.child) return;
    this.child.postMessage({ kind: 'audio', data: chunk } satisfies RuntimeInbound);
  }

  /** Soft stop through the runtime; if it does not answer within 2 s, kill and restart it. */
  async emergencyStop(): Promise<'soft' | 'hard'> {
    try {
      await this.request('emergency.stop', {}, 2_000);
      return 'soft';
    } catch {
      this.opts.log('runtime did not acknowledge emergency stop in 2 s; killing it');
      this.child?.kill();
      return 'hard';
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.child) return;
    try {
      this.post({ kind: 'shutdown' });
    } catch {
      // already gone
    }
    const child = this.child;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export function runtimeEntry(mainDir: string): string {
  return join(mainDir, 'runtime.js');
}
