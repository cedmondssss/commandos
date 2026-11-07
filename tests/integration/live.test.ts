import { existsSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandRuntime } from '@commandos/runtime';
import { findHelperBinary, HelperClient } from '@commandos/tools';
import { afterAll, describe, expect, it } from 'vitest';
import { loadLocalEnv } from '../../scripts/lib/env';
import { tempDir } from '../../packages/runtime/test/helpers';

loadLocalEnv();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = findHelperBinary(ROOT);
const helper = existsSync(HELPER) ? new HelperClient(HELPER) : null;
const perms = helper ? await helper.call('permissions.status', {}).catch(() => null) : null;
const textEditRunning = helper ? (await helper.call('apps.info', { bundleId: 'com.apple.TextEdit' }).catch(() => null))?.running ?? true : true;
const axReady = Boolean(perms?.accessibility) && !textEditRunning;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(() => helper?.stop());

describe.skipIf(!axReady)(
  `Accessibility write on a real app (${!perms?.accessibility ? 'skipped: Accessibility not granted to this process' : textEditRunning ? 'skipped: TextEdit already open' : 'TextEdit'})`,
  () => {
    it('types into a new TextEdit document via AXValue and verifies by read-back', async () => {
      const h = helper as HelperClient;
      await h.call('apps.launch', { bundleId: 'com.apple.TextEdit', activate: true });
      await sleep(1500);
      await h.call('keyboard.press', { key: 'n', modifiers: ['command'] });
      await sleep(1000);
      try {
        const found = await h.call('ax.find', { bundleId: 'com.apple.TextEdit', query: { role: 'AXTextArea' }, maxResults: 1, maxDepth: 20 });
        const ref = found.elements[0]?.ref;
        expect(ref).toBeTruthy();
        const text = `CommandOS AX check ${Date.now()}`;
        await h.call('ax.setValue', { ref: ref as string, value: text });
        expect((await h.call('ax.getValue', { ref: ref as string })).value).toBe(text);
      } finally {
        // TextEdit was not running before this test, so every open document is ours
        await h.call('apps.quit', { bundleId: 'com.apple.TextEdit', force: true });
      }
    });
  },
);

describe.skipIf(!process.env.OPENAI_API_KEY)(
  `STANDARD planner with gpt-6.1-sol (${process.env.OPENAI_API_KEY ? 'live' : 'skipped: OPENAI_API_KEY not set'})`,
  () => {
    let rt: CommandRuntime | null = null;
    afterAll(() => rt?.shutdown());

    it('plans incrementally, extracts documents in parallel and writes a verified summary', async () => {
      const dir = await tempDir('commandos-standard-');
      await cp(join(ROOT, 'fixtures', 'fs', 'docs'), join(dir, 'Inbox'), { recursive: true });
      rt = await CommandRuntime.create({
        dataDir: join(dir, 'data'),
        helperPath: HELPER,
        useKeychain: false,
        revealResults: false,
        settingsOverride: { allowedRoots: [dir], screenshotRoots: [dir] },
      });
      const runId = await rt.submit(
        `Read every document in ${join(dir, 'Inbox')} and write a file called summary.md in that same folder with one bullet per document: its file name and a one-line summary.`,
        'text',
      );
      const summary = await rt.waitForRun(runId);
      const snap = await rt.getRun(runId);
      const tools = snap.events.flatMap((e) => (e.type === 'task_added' ? [e.task.tool] : []));
      expect(summary.mode).toBe('standard');
      expect(tools).toContain('docs.extract');
      expect(summary.state).toBe('succeeded');
      const files = await readdir(join(dir, 'Inbox'));
      expect(files).toContain('summary.md');
      const text = await readFile(join(dir, 'Inbox', 'summary.md'), 'utf8');
      expect(text).toMatch(/invoice/i);
      const m = await rt.runMetrics(runId);
      expect(m.modelCalls).toBeGreaterThanOrEqual(2);
      expect(m.verifiedSuccess).toBe(true);
    }, 240_000);
  },
);
