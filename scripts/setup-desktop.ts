import { KEYCHAIN_SERVICE } from '@commandos/contracts';
import type { SecretBackend } from '@commandos/providers';
import { findHelperBinary, HelperClient } from '@commandos/tools';
import { configureDesktopCredentials, readSecret } from './lib/desktop-setup';
import { loadLocalEnv, ROOT } from './lib/env';

const helper = new HelperClient(findHelperBinary(ROOT));
try {
  if (process.platform !== 'darwin') throw new Error('CommandOS desktop setup requires macOS.');
  loadLocalEnv();
  console.log('CommandOS one-time setup. Existing credentials will be reused.');
  console.log('Missing keys are entered privately and saved in this Mac’s Keychain.');
  console.log('You only need to enter each missing key once.\n');
  await helper.start();
  const backend: SecretBackend = {
    get: async (account) => (await helper.call('keychain.get', { service: KEYCHAIN_SERVICE, account })).value,
    set: async (account, value) => { await helper.call('keychain.set', { service: KEYCHAIN_SERVICE, account, value }); },
    delete: async (account) => (await helper.call('keychain.delete', { service: KEYCHAIN_SERVICE, account })).deleted,
    list: async () => (await helper.call('keychain.list', { service: KEYCHAIN_SERVICE })).accounts,
  };
  await configureDesktopCredentials({ backend, env: process.env, prompt: readSecret, write: (message) => console.log(message) });
  console.log('\nCredentials are ready. Starting CommandOS…');
} catch (error) {
  console.error(`Setup did not complete: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  helper.stop();
}
