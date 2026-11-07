import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type AuditRecord, AuditRecordSchema } from '@commandos/contracts';
import { redactValue } from '@commandos/providers';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function hashRecord(prevHash: string, body: Omit<AuditRecord, 'hash' | 'prevHash'>): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(body)).digest('hex');
}

const GENESIS = 'genesis';

/**
 * Append-only, hash-chained audit log (JSON lines). Every record's hash covers the previous hash
 * and the record body, so edits or deletions break verification. Data is redacted before writing.
 */
export class AuditLog {
  private seq = 0;
  private prevHash = GENESIS;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const size = (await stat(this.file).catch(() => null))?.size ?? 0;
    if (size === 0) return;
    const fh = await open(this.file, 'r');
    try {
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const lines = buf.toString('utf8').trim().split('\n');
      const last = lines[lines.length - 1];
      if (last) {
        const rec = AuditRecordSchema.parse(JSON.parse(last));
        this.seq = rec.seq + 1;
        this.prevHash = rec.hash;
      }
    } finally {
      await fh.close();
    }
  }

  append(
    kind: string,
    actor: AuditRecord['actor'],
    data: unknown,
    ids: { runId?: string; taskId?: string } = {},
  ): Promise<AuditRecord> {
    const next = this.chain.then(async () => {
      const body = {
        seq: this.seq,
        at: Date.now(),
        kind,
        actor,
        ...(ids.runId ? { runId: ids.runId } : {}),
        ...(ids.taskId ? { taskId: ids.taskId } : {}),
        data: redactValue(data),
      };
      const hash = hashRecord(this.prevHash, body);
      const record: AuditRecord = { ...body, prevHash: this.prevHash, hash };
      await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
      this.seq++;
      this.prevHash = hash;
      return record;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  static async verify(file: string): Promise<{ ok: boolean; records: number; brokenAt?: number; reason?: string }> {
    const text = await readFile(file, 'utf8').catch(() => '');
    let prev = GENESIS;
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: AuditRecord;
      try {
        rec = AuditRecordSchema.parse(JSON.parse(line));
      } catch {
        return { ok: false, records: n, brokenAt: n, reason: 'unparseable record' };
      }
      if (rec.seq !== n) return { ok: false, records: n, brokenAt: n, reason: 'sequence gap' };
      if (rec.prevHash !== prev) return { ok: false, records: n, brokenAt: n, reason: 'previous hash mismatch' };
      const { hash, prevHash: _p, ...body } = rec;
      if (hashRecord(prev, body) !== hash) return { ok: false, records: n, brokenAt: n, reason: 'hash mismatch' };
      prev = hash;
      n++;
    }
    return { ok: true, records: n };
  }
}
