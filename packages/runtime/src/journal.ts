import { appendFile, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type JournalEntry, JournalEntrySchema, type UndoOp, type UndoReport } from '@commandos/contracts';
import { displayPath, type HelperClient, movePath, pathExists, runOsaTemplate, sha256File } from '@commandos/tools';

/** Per-run undo journal (JSON lines). Tools record the inverse of every reversible step. */
export class UndoJournal {
  private seq = 0;
  private recorded = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    readonly runId: string,
  ) {}

  get entryCount(): number { return this.recorded; }

  record(taskId: string, op: UndoOp): Promise<void> {
    const entry: JournalEntry = { seq: this.seq++, runId: this.runId, taskId, at: Date.now(), op };
    const next = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      this.recorded++;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  static async read(file: string): Promise<JournalEntry[]> {
    const text = await readFile(file, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JournalEntrySchema.parse(JSON.parse(l)));
  }
}

async function undoOne(op: UndoOp, helper: HelperClient | null): Promise<string | null> {
  switch (op.kind) {
    case 'applescript': {
      if (!helper) return `cannot ${op.description}: native helper unavailable`;
      await runOsaTemplate(helper, op.template, op.params);
      return null;
    }
    case 'ax_restore_value': {
      if (!helper) return 'cannot restore a UI field value: native helper unavailable';
      await helper.call('ax.setValue', { ref: op.ref, value: op.value });
      return null;
    }
    case 'move_back': {
      if (!(await pathExists(op.to))) return `cannot move back ${displayPath(op.to)}: it is no longer there`;
      if (await pathExists(op.from)) return `cannot move back to ${displayPath(op.from)}: something is already there`;
      await movePath(op.to, op.from);
      return null;
    }
    case 'delete_created': {
      if (!(await pathExists(op.path))) return null;
      if (op.isDir) {
        const entries = (await readdir(op.path)).filter((e) => e !== '.DS_Store');
        if (entries.length) return `left ${displayPath(op.path)} in place: folder is not empty`;
        await rm(`${op.path}/.DS_Store`, { force: true });
        await rmdir(op.path);
        return null;
      }
      if (op.sha256 && (await sha256File(op.path)) !== op.sha256) {
        return `left ${displayPath(op.path)} in place: it changed after CommandOS created it`;
      }
      await rm(op.path, { force: true });
      return null;
    }
    case 'restore_backup': {
      if (!(await pathExists(op.backupPath))) return `backup for ${displayPath(op.path)} is missing`;
      if (await pathExists(op.path)) await rm(op.path, { recursive: true, force: true });
      await movePath(op.backupPath, op.path);
      return null;
    }
    case 'untrash': {
      if (!(await pathExists(op.trashedPath))) return `${displayPath(op.originalPath)} is no longer in the Trash`;
      if (await pathExists(op.originalPath)) return `cannot restore ${displayPath(op.originalPath)}: something is already there`;
      await movePath(op.trashedPath, op.originalPath);
      return null;
    }
  }
}

/** Replays inverse operations newest-first. Each step checks its own preconditions. */
export async function undoEntries(entries: JournalEntry[], helper: HelperClient | null = null): Promise<UndoReport> {
  const failures: string[] = [];
  let steps = 0;
  for (const entry of [...entries].sort((a, b) => b.seq - a.seq)) {
    try {
      const failure = await undoOne(entry.op, helper);
      if (failure) failures.push(failure);
      else steps++;
    } catch (e) {
      failures.push(`${entry.op.kind} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: failures.length === 0, steps, failures };
}
