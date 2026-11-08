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
    if (await options.backend.get(key) !== value) throw new Error(`${label} could not be verified in Keychain. Setup did not finish.`);
    options.write(`${label}: saved and verified in Keychain.`);
    ready.push(key);
  }
  return ready;
}
