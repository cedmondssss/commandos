import { describe, expect, it, vi } from 'vitest';
import type { SecretBackend } from '@commandos/providers';
import { configureDesktopCredentials } from '../../scripts/lib/desktop-setup';

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
