import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { CREDENTIAL_INFO, CredentialKeySchema, type CredentialKey } from '@commandos/contracts';
import { CredentialResolver, type SecretBackend } from '@commandos/providers';

const REQUIRED: CredentialKey[] = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY'];

/** Read directly from the terminal with readline's echo output discarded. Secrets
 * never become shell commands, process arguments, terminal output, or repo files. */
export function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run setup directly in Terminal so the API keys can be entered privately.');
  process.stdout.write(prompt);
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const wasRaw = process.stdin.isRaw;
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      if (process.stdin.isRaw !== wasRaw) process.stdin.setRawMode(wasRaw);
      muted.end();
      process.stdout.write('\n');
      if (value === undefined) reject(new Error('Setup cancelled. Previously saved keys were kept.'));
      else resolve(value);
    };
    rl.once('SIGINT', () => finish());
    rl.once('close', () => finish());
    rl.question('', (answer) => finish(answer));
  });
}

export async function configureDesktopCredentials(options: {
  backend: SecretBackend;
  env?: NodeJS.ProcessEnv;
  prompt: (label: string) => Promise<string>;
  write: (message: string) => void;
  all?: boolean;
}): Promise<CredentialKey[]> {
  const credentials = new CredentialResolver(options.backend, options.env ?? {});
  const storeName = options.backend.source === 'file' ? 'private credential file' : 'Keychain';
  const ready: CredentialKey[] = [];
  for (const key of options.all ? CredentialKeySchema.options : REQUIRED) {
    const label = CREDENTIAL_INFO[key].label.replace(/\s*\(optional\)/i, '');
    const optional = !REQUIRED.includes(key);
    // Reuse existing Keychain or private environment credentials without retyping.
    if (await credentials.get(key)) {
      options.write(`${label}: already configured.`);
      ready.push(key);
      continue;
    }
    const hint = optional ? 'optional; Return to skip; input is hidden' : 'paste, then press Return; input is hidden';
    const value = (await options.prompt(`${label} (${hint}): `)).trim();
    if (!value && optional) { options.write(`${label}: skipped.`); continue; }
    if (!value || /\s/.test(value) || value.length > 10_000) throw new Error(`${label} must be a non-empty value without spaces or line breaks. Setup did not finish.`);
    await credentials.set(key, value);
    // Read from the actual store, bypassing the resolver's in-memory cache.
    if (await options.backend.get(key) !== value) throw new Error(`${label} could not be verified in ${storeName}. Setup did not finish.`);
    options.write(`${label}: saved and verified in ${storeName}.`);
    ready.push(key);
  }
  return ready;
}

/** Import only the app's known settings. Validate the entire private payload before
 * writing anything, and read each value back from the native store. */
export async function importDesktopCredentials(options: {
  backend: SecretBackend;
  fallback?: SecretBackend;
  data: unknown;
  write: (message: string) => void;
}): Promise<CredentialKey[]> {
  if (!options.data || typeof options.data !== 'object' || Array.isArray(options.data)) throw new Error('The private setup file must contain a credential object.');
  const entries = Object.entries(options.data);
  const values = new Map<CredentialKey, string>();
  for (const [key, value] of entries) {
    const known = CredentialKeySchema.safeParse(key);
    if (!known.success || typeof value !== 'string' || !value.trim() || /\s/.test(value) || value.length > 10_000) {
      throw new Error('The private setup file contains an unknown setting or invalid value. Nothing was imported.');
    }
    values.set(known.data, value);
  }
  if (REQUIRED.some((key) => !values.has(key))) throw new Error('The private setup file must include both the planning and voice keys.');
  const stores = options.fallback ? [options.backend, options.fallback] : [options.backend];
  for (const [index, store] of stores.entries()) {
    try {
      const saved: CredentialKey[] = [];
      for (const key of CredentialKeySchema.options) {
        const value = values.get(key);
        if (value === undefined) continue;
        const existing = await store.get(key).catch(() => null);
        if (existing !== value) await store.set(key, value);
        const storeName = store.source === 'file' ? 'the private credential file' : 'Keychain';
        if (await store.get(key) !== value) throw new Error(`${CREDENTIAL_INFO[key].label} could not be verified in ${storeName}. Import did not finish.`);
        options.write(`${CREDENTIAL_INFO[key].label}: saved and verified.`);
        saved.push(key);
      }
      return saved;
    } catch (error) {
      if (index === stores.length - 1) throw error;
      options.write('Keychain access is unavailable. Saving the supplied values in an owner-only private credential file.');
    }
  }
  throw new Error('No credential store completed the import.');
}

/** The returned installer contains credentials and belongs in a private file,
 * outside the repository. Base64 is transport encoding, not encryption. */
export function prefilledDesktopInstaller(values: Partial<Record<CredentialKey, string>>): string {
  if (REQUIRED.some((key) => !values[key])) throw new Error('Both planning and voice keys are needed to create the installer.');
  const payload = Buffer.from(JSON.stringify(values), 'utf8').toString('base64').match(/.{1,76}/g)!.join('\n');
  return `#!/bin/bash
set +x
set -euo pipefail
umask 077
task_repo="$HOME/commandos"
task_credentials=""
cleanup() { if [ -n "$task_credentials" ]; then rm -f "$task_credentials"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ ! -d "$task_repo/.git" ]; then
  git clone https://github.com/cedmondssss/commandos.git "$task_repo"
fi
cd "$task_repo"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build:helper
task_credentials="$(mktemp "\${TMPDIR:-/tmp}/commandos-credentials.XXXXXX")"
/usr/bin/base64 -D > "$task_credentials" <<'COMMANDOS_CREDENTIALS'
${payload}
COMMANDOS_CREDENTIALS
pnpm exec tsx scripts/setup-desktop.ts --import "$task_credentials"
rm -f "$task_credentials"
task_credentials=""
COMMANDOS_OPEN_DASHBOARD=1 pnpm --filter @commandos/desktop dev
`;
}
