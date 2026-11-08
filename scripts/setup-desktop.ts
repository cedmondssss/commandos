import { KEYCHAIN_SERVICE } from '@commandos/contracts';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialBackend, type SecretBackend } from '@commandos/providers';
import { findHelperBinary, HelperClient } from '@commandos/tools';
import { configureDesktopCredentials, importDesktopCredentials, readSecret } from './lib/desktop-setup';
import { loadLocalEnv, ROOT } from './lib/env';

const helper = new HelperClient(findHelperBinary(ROOT));
try {
  if (process.platform !== 'darwin') throw new Error('CommandOS desktop setup requires macOS.');
  loadLocalEnv();
  const importAt = process.argv.indexOf('--import');
  const importPath = importAt < 0 ? null : process.argv[importAt + 1];
  if (importAt >= 0 && (!importPath || importPath.startsWith('--'))) throw new Error('Give the private setup file after --import.');
  console.log(importPath ? 'Importing the supplied CommandOS credentials onto this Mac.' : 'CommandOS one-time setup. Existing credentials will be reused.');
  if (!importPath) {
    console.log('Missing keys are entered privately and saved on this Mac.');
    console.log('You only need to enter each missing key once.\n');
  }
  const all = process.argv.includes('--all');
  if (all) console.log('All integrations are included. Extra integration values are optional; press Return to skip any you do not use.\n');
  await helper.start();
  const backend: SecretBackend = {
    get: async (account) => (await helper.call('keychain.get', { service: KEYCHAIN_SERVICE, account })).value,
    set: async (account, value) => { await helper.call('keychain.set', { service: KEYCHAIN_SERVICE, account, value }); },
    delete: async (account) => (await helper.call('keychain.delete', { service: KEYCHAIN_SERVICE, account })).deleted,
    list: async () => (await helper.call('keychain.list', { service: KEYCHAIN_SERVICE })).accounts,
  };
  const dataDir = process.env.COMMANDOS_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'CommandOS');
  const fileStore = new FileCredentialBackend(join(dataDir, 'credentials.json'));
  const useFileStore = await fileStore.exists();
  if (importPath) {
    let data: unknown;
    try {
      if ((await stat(importPath)).size > 200_000) throw new Error('too large');
      data = JSON.parse(await readFile(importPath, 'utf8'));
    } catch { throw new Error('Could not read the private setup file as credential JSON.'); }
    await importDesktopCredentials({ backend: useFileStore ? fileStore : backend, fallback: useFileStore ? undefined : fileStore, data, write: (message) => console.log(message) });
  } else {
    await configureDesktopCredentials({ backend: useFileStore ? fileStore : backend, env: process.env, prompt: readSecret, all, write: (message) => console.log(message) });
  }
  console.log('\nSetup saved. Starting CommandOS…');
} catch (error) {
  console.error(`Setup did not complete: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  helper.stop();
}
