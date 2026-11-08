import { describe, expect, it, vi } from 'vitest';
import type { SecretBackend } from '@commandos/providers';
import { CREDENTIAL_INFO, CredentialKeySchema } from '@commandos/contracts';
import { spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CredentialResolver, FileCredentialBackend } from '@commandos/providers';
import { CommandRuntime } from '@commandos/runtime';
import { configureDesktopCredentials, importDesktopCredentials, prefilledDesktopInstaller } from '../../scripts/lib/desktop-setup';

function harness(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const backend: SecretBackend = {
    list: vi.fn(async () => [...values.keys()]),
    get: vi.fn(async (key) => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }),
    delete: vi.fn(async (key) => values.delete(key)),
  };
  const output: string[] = [];
  const prompt = vi.fn(async (label: string): Promise<string> => label.startsWith('OpenAI') ? 'test-openai-secret' : 'test-elevenlabs-secret');
  const options = { backend, prompt, write: (message: string) => { output.push(message); } };
  return { values, output, options, prompt, backend };
}

describe('One-time desktop credential setup', () => {
  it('recovers from Charlotte’s exact Keychain read failure and loads the values on a fresh runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-keychain-fallback-'));
    const helperPath = join(dir, 'locked-helper.cjs');
    const dataDir = join(dir, 'data');
    const input = join(dir, 'supplied.json');
    const values = { OPENAI_API_KEY: 'fallback-planning', ELEVENLABS_API_KEY: 'fallback-voice', SPECTRON_URL: 'https://memory.example.invalid', SPECTRON_CONTEXT_ID: 'fallback-context-fixture', SPECTRON_API_KEY: 'fallback-memory' };
    await writeFile(input, JSON.stringify(values), { mode: 0o600 });
    // This helper cannot control apps. It reproduces the actual import failure.
    await writeFile(helperPath, `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});\nconsole.log(JSON.stringify({event:'ready',version:'fixture'}));\nrl.on('line',line=>{const r=JSON.parse(line); const error={code:'keychain_locked',message:'Keychain access is unavailable for this helper. No password dialog was opened.'}; console.log(JSON.stringify(r.method==='keychain.get'?{id:r.id,ok:false,error}:{id:r.id,ok:true,result:r.method==='keychain.list'?{accounts:[]}:{ok:true}}));});\n`);
    await chmod(helperPath, 0o700);
    const env: NodeJS.ProcessEnv = { ...process.env, COMMANDOS_HELPER_PATH: helperPath, COMMANDOS_DATA_DIR: dataDir };
    for (const key of CredentialKeySchema.options) delete env[key];
    let runtime: CommandRuntime | undefined;
    try {
      const result = await promisify(execFile)('pnpm', ['exec', 'tsx', 'scripts/setup-desktop.ts', '--import', input], { cwd: resolve('.'), env, timeout: 25_000 });
      expect(result.stdout).toContain('owner-only private credential file');
      expect(result.stdout).toContain('Setup saved');
      for (const value of Object.values(values)) expect(result.stdout + result.stderr).not.toContain(value);
      const file = join(dataDir, 'credentials.json');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(values);
      runtime = await CommandRuntime.create({ dataDir, helperPath, env: {}, telemetry: false, revealResults: false });
      expect(await runtime.credentials.getWithSource('OPENAI_API_KEY')).toEqual({ value: 'fallback-planning', source: 'file' });
      expect(await runtime.credentials.get('ELEVENLABS_API_KEY')).toBe('fallback-voice');
      expect((await runtime.credentialStatus()).find((item) => item.key === 'SPECTRON_API_KEY')).toMatchObject({ source: 'file' });
      const resolver = new CredentialResolver(new FileCredentialBackend(file), {});
      expect(await resolver.get('SPECTRON_API_KEY')).toBe('fallback-memory');
    } finally { await runtime?.shutdown(); await rm(dir, { recursive: true, force: true }); }
  });

  it('imports prefilled values without prompting and reuses identical stored values', async () => {
    const h = harness();
    const data = { OPENAI_API_KEY: 'imported-planning', ELEVENLABS_API_KEY: 'imported-voice', SPECTRON_URL: 'https://memory.example.invalid', SPECTRON_CONTEXT_ID: 'fixture-context', SPECTRON_API_KEY: 'imported-memory' };
    expect(await importDesktopCredentials({ ...h.options, data })).toEqual(Object.keys(data));
    expect(Object.fromEntries(h.values)).toEqual(data);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.output.join('\n')).not.toMatch(/imported-planning|imported-voice|imported-memory/);
    const writes = vi.mocked(h.backend.set).mock.calls.length;
    await importDesktopCredentials({ ...h.options, data });
    expect(h.backend.set).toHaveBeenCalledTimes(writes);
  });

  it.each([null, [], { OPENAI_API_KEY: 'partial' }, { OPENAI_API_KEY: 'a', ELEVENLABS_API_KEY: 'b', UNRECOGNIZED: 'payload' }, { OPENAI_API_KEY: 'a\nb', ELEVENLABS_API_KEY: 'c' }])('validates the complete import before writing any values: %j', async (data) => {
    const h = harness();
    await expect(importDesktopCredentials({ ...h.options, data })).rejects.toThrow();
    expect(h.backend.set).not.toHaveBeenCalled();
    expect(h.output).toEqual([]);
  });

  it('refuses an import whose native store fails read-back', async () => {
    const h = harness();
    vi.mocked(h.backend.set).mockResolvedValue(undefined);
    await expect(importDesktopCredentials({ ...h.options, data: { OPENAI_API_KEY: 'a', ELEVENLABS_API_KEY: 'b' } })).rejects.toThrow('could not be verified in Keychain');
    expect(h.output).toEqual([]);
  });

  it('builds a valid shell installer with credentials transported as data', () => {
    const data = { OPENAI_API_KEY: 'fake-quote\'"$HOME;$(id)', ELEVENLABS_API_KEY: 'fake-voice' };
    const installer = prefilledDesktopInstaller(data);
    const parsed = spawnSync('/bin/bash', ['-n'], { input: installer, encoding: 'utf8' });
    expect(parsed.status).toBe(0);
    const payload = /<<'COMMANDOS_CREDENTIALS'\n([A-Za-z0-9+/=\n]+)\nCOMMANDOS_CREDENTIALS/.exec(installer)?.[1];
    expect(JSON.parse(Buffer.from(payload!, 'base64').toString('utf8'))).toEqual(data);
    expect(installer).not.toContain(data.OPENAI_API_KEY);
    expect(installer).toContain('umask 077');
    expect(installer).toContain('trap cleanup EXIT');
    expect(installer).toContain('--import "$task_credentials"');
  });

  it('includes every integration credential and configuration value in all-integrations mode', async () => {
    const h = harness();
    h.prompt.mockResolvedValue('fixture-credential');
    expect(await configureDesktopCredentials({ ...h.options, all: true })).toEqual(CredentialKeySchema.options);
    for (const key of CredentialKeySchema.options) {
      expect(h.values.get(key)).toBe('fixture-credential');
      expect(h.prompt.mock.calls.some(([label]) => label.startsWith(CREDENTIAL_INFO[key].label.replace(/\s*\(optional\)/i, '')))).toBe(true);
    }
    expect(h.output.join('\n')).not.toContain('fixture-credential');
  });

  it('allows unused integrations to be skipped while preserving the required planning and voice keys', async () => {
    const h = harness({ OPENAI_API_KEY: 'existing-planning', ELEVENLABS_API_KEY: 'existing-voice' });
    h.prompt.mockResolvedValue('');
    expect(await configureDesktopCredentials({ ...h.options, all: true })).toEqual(['OPENAI_API_KEY', 'ELEVENLABS_API_KEY']);
    expect(h.backend.set).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledTimes(CredentialKeySchema.options.length - 2);
    expect(h.prompt.mock.calls.every(([label]) => label.includes('Return to skip'))).toBe(true);
    expect(h.output.join('\n')).toContain('skipped');
  });

  it('saves both keys, verifies persistent storage and keeps values out of output', async () => {
    const h = harness();
    expect(await configureDesktopCredentials(h.options)).toEqual(['OPENAI_API_KEY', 'ELEVENLABS_API_KEY']);
    expect(h.values.get('OPENAI_API_KEY')).toBe('test-openai-secret');
    expect(h.values.get('ELEVENLABS_API_KEY')).toBe('test-elevenlabs-secret');
    expect(h.output.join('\n')).not.toMatch(/test-openai-secret|test-elevenlabs-secret/);
    expect(h.output.join('\n')).toContain('saved and verified');
    h.prompt.mockClear();
    await configureDesktopCredentials(h.options);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.backend.set).toHaveBeenCalledTimes(2);
  });

  it('reuses existing private environment credentials without copying or prompting', async () => {
    const h = harness();
    await configureDesktopCredentials({ ...h.options, env: { OPENAI_API_KEY: 'existing-openai', ELEVENLABS_API_KEY: 'existing-voice' } });
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.backend.set).not.toHaveBeenCalled();
    expect(h.output.join('\n')).not.toMatch(/existing-openai|existing-voice/);
  });

  it('stops if the native store does not retain the entered value', async () => {
    const h = harness();
    vi.mocked(h.backend.set).mockResolvedValue(undefined);
    await expect(configureDesktopCredentials(h.options)).rejects.toThrow('could not be verified in Keychain');
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.output).toEqual([]);
  });

  it.each(['', 'two keys', 'key\nsecond-key'])('rejects invalid input without writing a secret: %j', async (value) => {
    const h = harness();
    h.prompt.mockResolvedValue(value);
    await expect(configureDesktopCredentials(h.options)).rejects.toThrow('Setup did not finish');
    expect(h.backend.set).not.toHaveBeenCalled();
  });

  it('keeps existing credentials when input is cancelled and stops setup', async () => {
    const h = harness({ OPENAI_API_KEY: 'keep-this-key' });
    h.prompt.mockRejectedValue(new Error('Setup cancelled'));
    await expect(configureDesktopCredentials(h.options)).rejects.toThrow('Setup cancelled');
    expect(h.values.get('OPENAI_API_KEY')).toBe('keep-this-key');
    expect(h.backend.set).not.toHaveBeenCalled();
  });
});
