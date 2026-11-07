import { CredentialKeySchema } from '@commandos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CredentialResolver, type SecretBackend } from '../src/credentials';

function backend(): SecretBackend {
  return { list: vi.fn(async () => ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY']), get: vi.fn(async () => 'stored-value'), set: vi.fn(async () => {}), delete: vi.fn(async () => true) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('quiet credential access', () => {
  it('renders all credential metadata without retrieving any secret', async () => {
    const store = backend();
    const resolver = new CredentialResolver(store, {});
    const statuses = await Promise.all(Array.from({ length: 10 }, () => resolver.status()));
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(store.get).not.toHaveBeenCalled();
    expect(statuses[0]).toHaveLength(CredentialKeySchema.options.length);
    expect(statuses[0]?.find((item) => item.key === 'ELEVENLABS_API_KEY')).toMatchObject({ source: 'keychain', access: 'saved' });
    expect(JSON.stringify(statuses)).not.toContain('stored-value');
  });

  it('coalesces concurrent reads of the same credential and prefers usable Keychain values', async () => {
    const store = backend(); const value = deferred<string | null>();
    vi.mocked(store.get).mockReturnValue(value.promise);
    const resolver = new CredentialResolver(store, { OPENAI_API_KEY: 'fallback-value' });
    const reads = Array.from({ length: 10 }, () => resolver.get('OPENAI_API_KEY'));
    await vi.waitFor(() => expect(store.get).toHaveBeenCalledTimes(1));
    expect((await resolver.status()).find((item) => item.key === 'OPENAI_API_KEY')?.access).toBe('saved');
    value.resolve('keychain-value');
    expect(await Promise.all(reads)).toEqual(Array(10).fill('keychain-value'));
    expect(await resolver.getWithSource('OPENAI_API_KEY')).toEqual({ value: 'keychain-value', source: 'keychain' });
  });

  it('uses environment fallback for blocked Keychain access without repeated retries', async () => {
    const store = backend(); vi.mocked(store.get).mockRejectedValue(new Error('keychain_locked'));
    const resolver = new CredentialResolver(store, { ELEVENLABS_API_KEY: 'fallback-value' });
    expect(await resolver.get('ELEVENLABS_API_KEY')).toBe('fallback-value');
    expect(await resolver.get('ELEVENLABS_API_KEY')).toBe('fallback-value');
    expect(store.get).toHaveBeenCalledTimes(1);
    const statuses = await resolver.status();
    expect(statuses.find((item) => item.key === 'ELEVENLABS_API_KEY')).toMatchObject({ source: 'env', access: 'available' });
    expect(JSON.stringify(statuses)).not.toContain('fallback-value');
  });

  it('remembers blocked reads until explicit invalidation and surfaces access unavailable', async () => {
    const store = backend(); vi.mocked(store.get).mockRejectedValue(new Error('keychain_locked'));
    const resolver = new CredentialResolver(store, {});
    expect(await resolver.get('OPENAI_API_KEY')).toBeNull();
    expect(await resolver.get('OPENAI_API_KEY')).toBeNull();
    expect(store.get).toHaveBeenCalledTimes(1);
    expect((await resolver.status()).find((item) => item.key === 'OPENAI_API_KEY')).toMatchObject({ source: 'keychain', access: 'unavailable' });
    resolver.invalidate();
    vi.mocked(store.get).mockResolvedValue('newly-authorized-value');
    expect(await resolver.get('OPENAI_API_KEY')).toBe('newly-authorized-value');
    expect(store.get).toHaveBeenCalledTimes(2);
  });

  it('does not let an older in-flight read overwrite a newly saved value', async () => {
    const store = backend(); const value = deferred<string | null>();
    vi.mocked(store.get).mockReturnValue(value.promise);
    const resolver = new CredentialResolver(store, {});
    const oldRead = resolver.get('OPENAI_API_KEY');
    await vi.waitFor(() => expect(store.get).toHaveBeenCalledTimes(1));
    await resolver.set('OPENAI_API_KEY', 'new-value');
    value.resolve('old-value');
    expect(await oldRead).toBe('new-value');
    expect(await resolver.get('OPENAI_API_KEY')).toBe('new-value');
  });

  it('keeps environment fallback after removing a stored Keychain value', async () => {
    const store = backend();
    const resolver = new CredentialResolver(store, { OPENAI_API_KEY: 'environment-value' });
    await resolver.delete('OPENAI_API_KEY');
    expect(await resolver.getWithSource('OPENAI_API_KEY')).toEqual({ value: 'environment-value', source: 'env' });
    expect(store.get).not.toHaveBeenCalled();
  });

  it('does not cache a stale result across invalidation', async () => {
    const store = backend(); const value = deferred<string | null>();
    vi.mocked(store.get).mockReturnValueOnce(value.promise);
    const resolver = new CredentialResolver(store, {});
    const oldRead = resolver.get('OPENAI_API_KEY');
    await vi.waitFor(() => expect(store.get).toHaveBeenCalledTimes(1));
    resolver.invalidate(); value.resolve('stale-value');
    expect(await oldRead).toBeNull();
    vi.mocked(store.get).mockResolvedValue('fresh-value');
    expect(await resolver.get('OPENAI_API_KEY')).toBe('fresh-value');
  });
});
