import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HelperClient } from '../src/helper/client';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
it('does not send a queued native command if cancellation arrives while the helper starts', async () => {
  dir = await mkdtemp(join(tmpdir(), 'commandos-helper-stop-'));
  const received = join(dir, 'requests.jsonl');
  const binary = join(dir, 'fake-helper.cjs');
  // This fixture records RPC messages only; it cannot control the computer.
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.stdin.on('data', d => fs.appendFileSync(${JSON.stringify(received)}, d));\nsetTimeout(() => process.stdout.write(JSON.stringify({event:'ready',version:'fixture'})+'\\n'), 150);\n`);
  await chmod(binary, 0o700);
  const helper = new HelperClient(binary);
  const controller = new AbortController();
  try {
    const call = helper.call('keyboard.press', { key: 'return', modifiers: ['command'] }, { signal: controller.signal });
    const cancelled = expect(call).rejects.toMatchObject({ code: 'aborted' });
    controller.abort();
    await cancelled;
    expect(await readFile(received, 'utf8').catch(() => '')).toBe('');
  } finally { helper.stop(true); }
});
