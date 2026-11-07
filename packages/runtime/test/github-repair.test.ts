import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelGateway, StreamRequest } from '@commandos/providers';
import { describe, expect, it, vi } from 'vitest';
import { CommandRuntime } from '../src/runtime';

describe('GitHub issue repair identity', () => {
  it('provides verified owner/repo and checkout to the first planner turn for the original spoken command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commandos-repair-identity-'));
    const local = join(root, 'checkout-demo');
    await mkdir(local);
    await promisify(execFile)('git', ['init', '-q', local]);
    await promisify(execFile)('git', ['-C', local, 'config', '--local', 'remote.origin.url', 'git@github.com:example/checkout-demo.git']);
    const stream = vi.fn(async (_request: StreamRequest) => ({ response: { id: 'response', output: [{ type: 'function_call', name: 'finish', call_id: 'finish_identity_test', arguments: JSON.stringify({ outcome: 'needs_user', summary: 'Identity test only; no cloud calls.' }) }], output_text: '' } }));
    const rt = await CommandRuntime.create({ dataDir: join(root, 'data'), helperPath: '/nonexistent', useKeychain: false, telemetry: false, revealResults: false, env: {}, settingsOverride: { allowedRoots: [root] } });
    vi.spyOn(rt, 'getModels').mockResolvedValue({ stream } as unknown as ModelGateway);
    try {
      const id = await rt.submit('Open my checkout-demo GitHub repo in Chrome. Read issue one with Anchor, then fix it in Daytona using the local copy listed in the issue. Show the patch and test results. Keep the sandbox, and don’t push changes', 'text');
      await rt.waitForRun(id);
      expect(stream).toHaveBeenCalledOnce();
      const context = JSON.stringify(stream.mock.calls[0]![0].input);
      expect(context).toContain('https://github.com/example/checkout-demo');
      expect(context).toContain(local);
      expect(context).toContain('Verified local Git metadata');
      expect((await rt.getRun(id)).events).toContainEqual(expect.objectContaining({ type: 'task_state', taskId: 'resolve_repository', state: 'succeeded' }));
    } finally { await rt.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
});
