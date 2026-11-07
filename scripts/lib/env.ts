import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Loads development credentials from .env.local and .env (both git-ignored); .env.local wins.
 * Keychain values take precedence over both at runtime.
 */
export function loadLocalEnv(): boolean {
  let loaded = false;
  for (const name of ['.env.local', '.env']) {
    const file = join(ROOT, name);
    if (!existsSync(file)) continue;
    config({ path: file, quiet: true });
    loaded = true;
  }
  return loaded;
}

export const CLI_DATA_DIR = process.env.COMMANDOS_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'CommandOS-CLI');
export const DEMO_ROOT = process.env.COMMANDOS_DEMO_ROOT ?? join(homedir(), 'CommandOS-Demo');
