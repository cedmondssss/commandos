import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CredentialKeySchema } from '@commandos/contracts';
import type { SecretBackend } from './credentials';

/** Per-user fallback for Macs whose Keychain denies this development helper.
 * The JSON is owner-readable only, atomically replaced, and never logged. */
export class FileCredentialBackend implements SecretBackend {
  readonly source = 'file' as const;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  async exists(): Promise<boolean> {
    try { await lstat(this.file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  private async read(): Promise<Record<string, string>> {
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('Could not open the private credential file.');
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 200_000 || (info.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw new Error('The private credential file must belong to this user and allow access only to its owner.');
      }
      let data: unknown;
      try { data = JSON.parse(await handle.readFile('utf8')); }
      catch { throw new Error('The private credential file is not valid JSON.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The private credential file has an invalid format.');
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(data)) {
        if (!CredentialKeySchema.safeParse(key).success || typeof value !== 'string' || !value || /\s/.test(value) || value.length > 10_000) {
          throw new Error('The private credential file has an invalid setting.');
        }
        values[key] = value;
      }
      return values;
    } finally { await handle.close(); }
  }

  private update<T>(change: (values: Record<string, string>) => T): Promise<T> {
    const pending = this.pending.then(async () => {
      const values = await this.read();
      const result = change(values);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(values)); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.file);
      } finally { await rm(temporary, { force: true }); }
      return result;
    });
    this.pending = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async get(account: string): Promise<string | null> {
    if (!CredentialKeySchema.safeParse(account).success) return null;
    return (await this.read())[account] ?? null;
  }
  async list(): Promise<string[]> { return Object.keys(await this.read()); }
  async set(account: string, value: string): Promise<void> {
    if (!CredentialKeySchema.safeParse(account).success || !value || /\s/.test(value) || value.length > 10_000) throw new Error('Invalid credential setting.');
    await this.update((values) => { values[account] = value; });
  }
  delete(account: string): Promise<boolean> {
    return this.update((values) => { const exists = Object.hasOwn(values, account); delete values[account]; return exists; });
  }
}
