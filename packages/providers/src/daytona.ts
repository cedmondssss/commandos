import { Daytona, type Sandbox } from '@daytona/sdk';

export interface DaytonaConfig {
  apiKey: string;
  apiUrl?: string;
  target?: string;
}

export interface SandboxHandle {
  id: string;
  workDir: string;
  repoDir: string;
  createdAt: number;
  network: 'none' | 'registries';
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  durationMs: number;
}

/** Package registries a sandbox may reach when dependency installs are needed. */
export const REGISTRY_DOMAINS = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'registry.yarnpkg.com'];

/**
 * Daytona sandboxes for isolated execution. Sandboxes get no environment variables or
 * secrets, block all network by default, auto-stop quickly and remain available until explicitly deleted.
 */
export class SandboxService {
  private readonly client: Daytona;
  private readonly live = new Map<string, { sandbox: Sandbox; handle: SandboxHandle; runId: string; deleting?: Promise<boolean> }>();

  constructor(cfg: DaytonaConfig) {
    this.client = new Daytona({ apiKey: cfg.apiKey, ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}), ...(cfg.target ? { target: cfg.target } : {}) });
  }

  async create(opts: { runId: string; network: 'none' | 'registries'; labels?: Record<string, string> }): Promise<SandboxHandle> {
    const sandbox = await this.client.create(
      {
        language: 'typescript',
        envVars: {},
        labels: { app: 'commandos', run: opts.runId.slice(0, 60), ...(opts.labels ?? {}) },
        autoStopInterval: 15,
        ...(opts.network === 'none' ? { networkBlockAll: true } : { domainAllowList: REGISTRY_DOMAINS.join(',') }),
      },
      { timeout: 120 },
    );
    const workDir = (await sandbox.getWorkDir()) ?? '/home/daytona';
    const handle: SandboxHandle = { id: sandbox.id, workDir, repoDir: `${workDir}/repo`, createdAt: Date.now(), network: opts.network };
    this.live.set(sandbox.id, { sandbox, handle, runId: opts.runId });
    return handle;
  }

  private get(id: string): Sandbox {
    const entry = this.live.get(id);
    if (!entry) throw new Error(`sandbox ${id} is not active in this session`);
    return entry.sandbox;
  }

  async upload(id: string, files: Array<{ content: Buffer; path: string }>): Promise<void> {
    const sandbox = this.get(id);
    // uploadFiles creates parent folders; batch to keep requests bounded
    for (let i = 0; i < files.length; i += 100) {
      await sandbox.fs.uploadFiles(
        files.slice(i, i + 100).map((f) => ({ source: f.content, destination: f.path })),
        300,
      );
    }
  }

  async exec(id: string, command: string, cwd: string, timeoutSec: number): Promise<ExecResult> {
    const sandbox = this.get(id);
    const started = performance.now();
    const r = await sandbox.process.executeCommand(command, cwd, {}, timeoutSec);
    return { exitCode: r.exitCode, stdout: r.result ?? '', durationMs: performance.now() - started };
  }

  async download(id: string, path: string): Promise<Buffer> {
    return this.get(id).fs.downloadFile(path);
  }

  async destroy(id: string): Promise<boolean> {
    const entry = this.live.get(id);
    if (!entry) return false;
    if (entry.deleting) return entry.deleting;
    // Keep the handle until destruction is confirmed so a failed cleanup can be retried.
    entry.deleting = entry.sandbox.delete(60, true).then(() => {
      this.live.delete(id);
      return true;
    }).finally(() => { delete entry.deleting; });
    return entry.deleting;
  }

  /** Deletes every sandbox created for a run (or all of them) when explicitly requested. */
  async destroyAll(runId?: string): Promise<number> {
    const ids = [...this.live.entries()].filter(([, e]) => !runId || e.runId === runId).map(([id]) => id);
    const results = await Promise.allSettled(ids.map((id) => this.destroy(id)));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((r) => r.reason), `failed to delete ${failures.length} of ${ids.length} sandbox(es); handles retained for retry`);
    return results.filter((r) => r.status === 'fulfilled' && r.value).length;
  }

  activeIds(runId?: string): string[] {
    return [...this.live.entries()].filter(([, entry]) => !runId || entry.runId === runId).map(([id]) => id);
  }
}
