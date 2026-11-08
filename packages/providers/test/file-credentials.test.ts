import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialResolver } from '../src/credentials';
import { FileCredentialBackend } from '../src/file-credentials';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'commandos-private-store-')); dirs.push(dir);
  const file = join(dir, 'credentials.json');
  return { dir, file, backend: new FileCredentialBackend(file) };
}

describe('Protected per-user credential files', () => {
  it('persists concurrent updates with owner-only permissions and resolves them after restart', async () => {
    const h = await fixture();
    await Promise.all([h.backend.set('OPENAI_API_KEY', 'file-planning'), h.backend.set('ELEVENLABS_API_KEY', 'file-voice')]);
    expect((await stat(h.file)).mode & 0o777).toBe(0o600);
    const restarted = new CredentialResolver(new FileCredentialBackend(h.file), { OPENAI_API_KEY: 'old-environment-value' });
    expect(await restarted.getWithSource('OPENAI_API_KEY')).toEqual({ value: 'file-planning', source: 'file' });
    expect(await restarted.get('ELEVENLABS_API_KEY')).toBe('file-voice');
    expect((await restarted.status()).find((item) => item.key === 'OPENAI_API_KEY')).toMatchObject({ source: 'file', access: 'available' });
    await restarted.set('OPENAI_API_KEY', 'replacement');
    expect(await new FileCredentialBackend(h.file).get('OPENAI_API_KEY')).toBe('replacement');
    await restarted.delete('ELEVENLABS_API_KEY');
    expect(await new FileCredentialBackend(h.file).get('ELEVENLABS_API_KEY')).toBeNull();
    expect(await readFile(h.file, 'utf8')).not.toContain('file-voice');
  });

  it('refuses group-readable files and symlink replacements', async () => {
    const h = await fixture();
    await h.backend.set('OPENAI_API_KEY', 'fixture-value');
    await chmod(h.file, 0o644);
    await expect(h.backend.get('OPENAI_API_KEY')).rejects.toThrow('only to its owner');
    await chmod(h.file, 0o600);
    const link = join(h.dir, 'linked.json'); await symlink(h.file, link);
    await expect(new FileCredentialBackend(link).get('OPENAI_API_KEY')).rejects.toThrow('Could not open');
  });

  it('does not include credential contents in parse errors', async () => {
    const h = await fixture();
    await writeFile(h.file, '{"OPENAI_API_KEY":"secret-that-must-not-be-printed', { mode: 0o600 });
    await expect(h.backend.list()).rejects.toThrow('not valid JSON');
    const error = await h.backend.list().catch((error: Error) => error);
    expect(String(error)).not.toContain('secret-that-must-not-be-printed');
  });
});
