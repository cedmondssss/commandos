import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '@commandos/contracts';
import { describe, expect, it } from 'vitest';
import { docsExtract } from '../src/docs';
import { gmailAccountFromTitle, gmailComposeUrl } from '../src/gmail';
import { HelperClient } from '../src/helper/client';
import { asString, OSA_TEMPLATES } from '../src/osa';
import { classifyCommand, scrubbedEnv, terminalRun } from '../src/terminal';
import type { ToolContext } from '../src/types';
import { RISKY_LABEL, uiPress } from '../src/ui';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = join(ROOT, 'fixtures', 'fs', 'docs');

function ctx(dir: string): ToolContext {
  return {
    runId: 'run_t',
    taskId: 't1',
    signal: new AbortController().signal,
    dryRun: false,
    settings: { ...defaultSettings(), allowedRoots: [dir] },
    helper: new HelperClient('/nonexistent'),
    models: null,
    providers: { get: () => Promise.reject(new Error('none')) },
    journal: { record: async () => {} },
    artifactsDir: join(dir, '.artifacts'),
    log: () => {},
    progress: () => {},
  };
}

describe('terminal allowlist', () => {
  it('classifies commands without a shell', () => {
    expect(classifyCommand(['ls', '-la']).cls).toBe('read');
    expect(classifyCommand(['git', 'status']).cls).toBe('read');
    expect(classifyCommand(['git', 'log', '--oneline']).cls).toBe('read');
    expect(classifyCommand(['git', 'commit', '-m', 'x']).cls).toBe('approve');
    expect(classifyCommand(['git', 'push']).cls).toBe('deny');
    expect(classifyCommand(['git', 'branch', '-D', 'main']).cls).toBe('approve');
    expect(classifyCommand(['npm', 'test']).cls).toBe('approve');
    expect(classifyCommand(['node', '--version']).cls).toBe('read');
    expect(classifyCommand(['rm', '-rf', '/']).cls).toBe('deny');
    expect(classifyCommand(['/usr/bin/sudo', 'ls']).cls).toBe('deny');
    expect(classifyCommand(['find', '.', '-delete']).cls).toBe('deny');
    expect(classifyCommand(['curl', 'https://x']).cls).toBe('deny');
    expect(classifyCommand(['osascript', '-e', 'x']).cls).toBe('deny');
    expect(classifyCommand(['totally-unknown']).cls).toBe('deny');
  });

  it('never leaks credentials into child processes', () => {
    process.env.OPENAI_API_KEY = 'sk-test-should-not-leak';
    const env = scrubbedEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBeTruthy();
    delete process.env.OPENAI_API_KEY;
  });

  it('runs an allowed command and refuses a denied one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-term-'));
    await writeFile(join(dir, 'a.txt'), 'hello');
    const out = await terminalRun.run({ argv: ['ls'], cwd: dir, timeoutMs: 5000, expectZeroExit: true }, ctx(dir));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('a.txt');
    await expect(terminalRun.run({ argv: ['rm', 'a.txt'], cwd: dir, timeoutMs: 5000, expectZeroExit: false }, ctx(dir))).rejects.toThrow(/not allowed/);
  });

  it('kills commands that exceed their timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commandos-term-'));
    const out = await terminalRun.run({ argv: ['tail', '-f', '/dev/null'], cwd: dir, timeoutMs: 300, expectZeroExit: false }, ctx(dir));
    expect(out.signal).toBe('SIGKILL');
  });
});

describe('document extraction', () => {
  it('extracts PDF, DOCX, RTF and Markdown text locally', async () => {
    const out = await docsExtract.run(
      {
        paths: [
          join(DOCS, 'invoice-INV-2026-0142.pdf'),
          join(DOCS, 'memo-office-move.docx'),
          join(DOCS, 'memo-office-move.rtf'),
          join(DOCS, 'launch-checklist.md'),
        ],
        maxCharsPerFile: 20_000,
      },
      ctx(DOCS),
    );
    const [pdf, docx, rtf, md] = out.documents;
    expect(pdf).toMatchObject({ kind: 'pdf', pages: 1, error: null });
    expect(pdf?.text).toMatch(/Total due: \$7,500\.00/);
    expect(docx?.text).toMatch(/5th floor on Friday, November 7/);
    expect(rtf?.text).toMatch(/Pack desks by Thursday/);
    expect(md?.text).toMatch(/Launch date/);
  });
});

describe('Apple Events and UI safety', () => {
  it('escapes AppleScript string parameters', () => {
    expect(asString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
    const src = OSA_TEMPLATES['notes.create']?.({ title: 'x" & (do shell script "rm -rf ~") & "', body: '' }) ?? '';
    expect(src).toContain('name:"x\\" & (do shell script \\"rm -rf ~\\") & \\""');
  });

  it('treats consequential button labels as external actions', () => {
    expect(RISKY_LABEL.test('Send')).toBe(true);
    expect(RISKY_LABEL.test('Place order')).toBe(true);
    expect(RISKY_LABEL.test('New Document')).toBe(false);
    expect(typeof uiPress.effectClass === 'function' && uiPress.effectClass({ bundleId: 'com.apple.mail', target: { text: 'Send' }, expectLabel: 'Send' })).toBe('external');
  });
});

describe('Gmail helpers', () => {
  it('reads the signed-in account from Chrome window titles', () => {
    expect(gmailAccountFromTitle('Inbox (3) - you.name+x@gmail.com - Gmail')).toBe('you.name+x@gmail.com');
    expect(gmailAccountFromTitle('Compose Mail - me@work.co.uk - Work Mail - Gmail - Google Chrome')).toBe('me@work.co.uk');
    expect(gmailAccountFromTitle('Google')).toBeNull();
    expect(gmailAccountFromTitle('Contact us at sales@x.com - Example')).toBeNull();
  });

  it('builds an encoded compose link for the right account', () => {
    const url = new URL(gmailComposeUrl({ to: 'me@x.com', subject: 'Hi & bye', body: 'line 1\nline 2 ✓', account: 'me@x.com' }));
    expect(url.origin + url.pathname).toBe('https://mail.google.com/mail/');
    expect(url.searchParams.get('view')).toBe('cm');
    expect(url.searchParams.get('to')).toBe('me@x.com');
    expect(url.searchParams.get('su')).toBe('Hi & bye');
    expect(url.searchParams.get('body')).toBe('line 1\nline 2 ✓');
    expect(url.searchParams.get('authuser')).toBe('me@x.com');
    expect(gmailComposeUrl({ to: 'a@b.co', subject: '', body: '', account: null })).not.toContain('authuser');
  });
});
