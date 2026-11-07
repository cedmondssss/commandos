import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  defaultSettings,
  type RunEvent,
  RunEventSchema,
  type RunSummary,
  RunSummarySchema,
  type Settings,
  type SettingsPatch,
  SettingsSchema,
} from '@commandos/contracts';

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export class SettingsStore {
  private current: Settings = defaultSettings();

  constructor(readonly file: string) {}

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      const merged = { ...defaultSettings(), ...raw, voice: { ...defaultSettings().voice, ...(raw.voice ?? {}) } };
      const parsed = SettingsSchema.safeParse(merged);
      this.current = parsed.success ? parsed.data : defaultSettings();
    } catch {
      this.current = defaultSettings();
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const next = SettingsSchema.parse({ ...this.current, ...patch });
    await writeJsonAtomic(this.file, next);
    this.current = next;
    return next;
  }

  /** In-memory override (tests, CLI flags) without persisting. */
  override(patch: SettingsPatch): Settings {
    this.current = SettingsSchema.parse({ ...this.current, ...patch });
    return this.current;
  }
}

/** Persists each run's event stream and summary under <dataDir>/runs/<runId>/. */
export class RunStore {
  constructor(readonly runsDir: string) {}

  dirFor(runId: string): string {
    return join(this.runsDir, runId);
  }

  async appendEvents(runId: string, events: RunEvent[]): Promise<void> {
    if (!events.length) return;
    const dir = this.dirFor(runId);
    await mkdir(dir, { recursive: true });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  }

  async writeSummary(summary: RunSummary): Promise<void> {
    await writeJsonAtomic(join(this.dirFor(summary.runId), 'summary.json'), summary);
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    const text = await readFile(join(this.dirFor(runId), 'events.jsonl'), 'utf8').catch(() => '');
    const out: RunEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const parsed = RunEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  async readSummary(runId: string): Promise<RunSummary | null> {
    try {
      const parsed = RunSummarySchema.safeParse(JSON.parse(await readFile(join(this.dirFor(runId), 'summary.json'), 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async listSummaries(limit = 100): Promise<RunSummary[]> {
    const dirs = await readdir(this.runsDir).catch(() => [] as string[]);
    const summaries: RunSummary[] = [];
    for (const d of dirs.sort().reverse().slice(0, limit * 2)) {
      const s = await this.readSummary(d);
      if (s) summaries.push(s);
      if (summaries.length >= limit) break;
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** Per-run checkpoint files: every task spec as added, and every verified output. */
export class CheckpointStore {
  constructor(readonly runsDir: string) {}

  private dir(runId: string): string {
    return join(this.runsDir, runId, 'checkpoints');
  }

  taskAdded(runId: string, spec: unknown): void {
    void mkdir(this.dir(runId), { recursive: true })
      .then(async () => {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(join(this.dir(runId), 'tasks.jsonl'), `${JSON.stringify(spec)}\n`, 'utf8');
      })
      .catch(() => {});
  }

  taskSucceeded(runId: string, taskId: string, output: unknown): void {
    void writeJsonAtomic(join(this.dir(runId), 'outputs', `${taskId}.json`), output).catch(() => {});
  }

  async load(runId: string): Promise<{ specs: unknown[]; outputs: Map<string, unknown> }> {
    const text = await readFile(join(this.dir(runId), 'tasks.jsonl'), 'utf8').catch(() => '');
    const specs = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
    const outputs = new Map<string, unknown>();
    const files = await readdir(join(this.dir(runId), 'outputs')).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      outputs.set(f.slice(0, -5), JSON.parse(await readFile(join(this.dir(runId), 'outputs', f), 'utf8')));
    }
    return { specs, outputs };
  }
}
