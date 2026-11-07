import {
  CREDENTIAL_INFO,
  CredentialKeySchema,
  type CredentialKey,
  type CredentialSource,
  type CredentialStatus,
} from '@commandos/contracts';

/** Storage for secrets. The runtime implements this with the Swift helper's Keychain methods. */
export interface SecretBackend {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
  list(): Promise<string[]>;
}

export class MissingCredentialError extends Error {
  readonly keys: CredentialKey[];
  constructor(keys: CredentialKey[]) {
    super(`missing credentials: ${keys.join(', ')}`);
    this.name = 'MissingCredentialError';
    this.keys = keys;
  }
}

/**
 * Resolves credentials with precedence Keychain → environment. Values are cached in memory
 * inside the runtime process only; they are never sent to the renderer or written to logs.
 */
type ResolvedCredential = { value: string; source: Exclude<CredentialSource, 'missing'> };

export class CredentialResolver {
  private cache = new Map<CredentialKey, ResolvedCredential | null>();
  private pending = new Map<CredentialKey, Promise<ResolvedCredential | null>>();
  private keychainAccounts: Set<string> | null = null;
  private indexPending: Promise<Set<string>> | null = null;
  private generation = 0;
  private versions = new Map<CredentialKey, number>();

  constructor(
    private readonly backend: SecretBackend | null,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async loadKeychainIndex(): Promise<Set<string>> {
    if (this.keychainAccounts) return this.keychainAccounts;
    if (!this.backend) return (this.keychainAccounts = new Set());
    if (this.indexPending) return this.indexPending;
    const generation = this.generation;
    const pending = this.backend.list().then((accounts) => new Set(accounts), () => new Set<string>()).then((accounts) => {
      if (generation === this.generation) this.keychainAccounts = accounts;
      return accounts;
    }).finally(() => { if (this.indexPending === pending) this.indexPending = null; });
    this.indexPending = pending;
    return pending;
  }

  async getWithSource(key: CredentialKey): Promise<{ value: string; source: Exclude<CredentialSource, 'missing'> } | null> {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const version = this.versions.get(key) ?? 0;
    const pending = (async () => {
      let entry: ResolvedCredential | null = null;
      const index = await this.loadKeychainIndex();
      if (this.backend && index.has(key)) {
        try {
          const value = await this.backend.get(key);
          if (value) entry = { value, source: 'keychain' };
        } catch {
          // The native backend refuses interactive access. Fall back without a password dialog.
        }
      }
      const envValue = this.env[key]?.trim();
      if (!entry && envValue) entry = { value: envValue, source: 'env' };
      if (generation === this.generation && version === (this.versions.get(key) ?? 0)) {
        this.cache.set(key, entry); // Remember missing/blocked reads; do not retry every request.
        return entry;
      }
      return this.cache.get(key) ?? null;
    })().finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
    this.pending.set(key, pending);
    return pending;
  }

  async get(key: CredentialKey): Promise<string | null> {
    return (await this.getWithSource(key))?.value ?? null;
  }

  async require(...keys: CredentialKey[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const missing: CredentialKey[] = [];
    for (const key of keys) {
      const v = await this.get(key);
      if (v) out[key] = v;
      else missing.push(key);
    }
    if (missing.length) throw new MissingCredentialError(missing);
    return out;
  }

  async has(...keys: CredentialKey[]): Promise<boolean> {
    for (const key of keys) if (!(await this.get(key))) return false;
    return true;
  }

  async status(): Promise<CredentialStatus[]> {
    // Listing account names does not retrieve secret data or trigger access approval per key.
    const index = await this.loadKeychainIndex();
    const out: CredentialStatus[] = [];
    for (const key of CredentialKeySchema.options) {
      const info = CREDENTIAL_INFO[key];
      const cached = this.cache.get(key);
      if (cached) out.push({ key, ...info, source: cached.source, access: 'available' });
      else if (index.has(key)) out.push({ key, ...info, source: 'keychain', access: this.cache.has(key) ? 'unavailable' : 'saved' });
      else {
        const hasEnv = Boolean(this.env[key]?.trim());
        out.push({ key, ...info, source: hasEnv ? 'env' : 'missing', ...(hasEnv ? { access: 'available' as const } : {}) });
      }
    }
    return out;
  }

  async set(key: CredentialKey, value: string): Promise<void> {
    if (!this.backend) throw new Error('no secure credential store available (Swift helper not running)');
    const index = await this.loadKeychainIndex();
    await this.backend.set(key, value);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.pending.delete(key);
    index.add(key);
    this.keychainAccounts = index;
    this.cache.set(key, { value, source: 'keychain' });
  }

  async delete(key: CredentialKey): Promise<void> {
    const index = await this.loadKeychainIndex();
    if (this.backend) await this.backend.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.pending.delete(key);
    index.delete(key);
    this.keychainAccounts = index;
    const envValue = this.env[key]?.trim();
    this.cache.set(key, envValue ? { value: envValue, source: 'env' } : null);
  }

  /** Drop cached values (e.g. after Settings changes). */
  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
    this.keychainAccounts = null;
    this.indexPending = null;
  }
}
