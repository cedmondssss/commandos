import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { containsSecret, findSecretKinds, redactText, redactValue } from '../src/redaction';

describe('redaction', () => {
  it('removes entire Anchor CDP endpoints from errors and structured output while preserving live-view links', () => {
    const cdp = 'wss://connect.anchorbrowser.io?apiKey=private-value&sessionId=session';
    expect(redactText(`connectOverCDP failed: ${cdp}`)).toBe('connectOverCDP failed: [REDACTED_ANCHOR_CDP_URL]');
    expect(redactValue({ cdp_url: cdp, cdpUrl: cdp, live_view_url: 'https://live.anchorbrowser.io/inspector.html?sessionId=session' })).toEqual({ cdp_url: '[REDACTED]', cdpUrl: '[REDACTED]', live_view_url: 'https://live.anchorbrowser.io/inspector.html?sessionId=session' });
  });
  it('masks provider keys, tokens and private keys', () => {
    const openai = ['sk-', 'proj-', 'AbCdEfGhIjKlMnOpQrStUvW', 'xYz0123456789'].join('');
    const eleven = ['sk_', '0123456789abcdef', '0123456789abcdef'].join('');
    const memory = ['sp-', 'live_', 'ABCDEFGHIJKLMNOPQRSTU'].join('');
    const github = ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'].join('');
    const aws = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const privateKey = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
    const text = [
      `openai ${openai}`,
      `eleven ${eleven}`,
      `memory ${memory}`,
      `github ${github}`,
      `aws ${aws}`,
      'password = hunter2',
      `${privateKey}\nMIIabc\n-----END RSA PRIVATE KEY-----`,
    ].join('\n');
    const out = redactText(text);
    expect(out).not.toMatch(/sk-proj-|sk_0123|sp-live|ghp_|AKIA|hunter2|MIIabc/);
    expect(out).toContain('password = [REDACTED]');
  });

  it('masks Luhn-valid card numbers but keeps other digit runs', () => {
    expect(redactText('card 4242 4242 4242 4242 exp 12/30')).toBe('card [REDACTED_CARD] exp 12/30');
    expect(redactText('order 1234 5678 9012 3456')).toBe('order 1234 5678 9012 3456');
  });

  it('replaces the home directory and optionally emails', () => {
    expect(redactText(`${homedir()}/Desktop/a.png`)).toBe('~/Desktop/a.png');
    expect(redactText('mail me: a.b@example.com', { emails: true })).toBe('mail me: [REDACTED_EMAIL]');
  });

  it('redacts sensitive keys in structured values', () => {
    expect(redactValue({ apiKey: 'abc', nested: { password: 'p', note: 'ok' } })).toEqual({
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]', note: 'ok' },
    });
  });

  it('detects secrets for staging and memory guards', () => {
    const openai = ['sk-', 'proj-', 'AbCdEfGhIjKlMnOpQrStUvW', 'xYz0123456789'].join('');
    expect(containsSecret(`export OPENAI_API_KEY=${openai}`)).toBe(true);
    expect(findSecretKinds('token: abcdef')).toContain('credential_assignment');
    expect(containsSecret('just a normal sentence about keys and tokens')).toBe(false);
  });
});
