import { defaultSettings } from '@commandos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { webAgentTask } from '../src/web';
import type { ToolContext } from '../src/types';

describe('Anchor structured results', () => {
  function context(result: unknown) {
    const agentTask = vi.fn(async (_id: string, _prompt: string, options: { onStep: (step: unknown) => void }) => {
      options.onStep({ action: { type: 'navigate' }, screenshot: 'must not be logged' });
      return { data: { result } };
    });
    const progress = vi.fn();
    return { agentTask, progress, ctx: { settings: defaultSettings(), signal: new AbortController().signal,
      providers: { get: async () => ({ agentTask }) }, progress,
    } as unknown as ToolContext };
  }

  it('decodes structured JSON under result and reports a readable step count', async () => {
    const c = context('{"internalUrls":["https://example.com/a"],"text":"Observed page"}');
    expect(await webAgentTask.run(webAgentTask.args.parse({ sessionId: 's', prompt: 'Read', outputSchema: { type: 'object' } }), c.ctx))
      .toEqual({ result: { internalUrls: ['https://example.com/a'], text: 'Observed page' } });
    expect(c.progress).toHaveBeenCalledWith('Anchor browser step 1');
  });

  it('keeps unstructured text under result when no schema was requested', async () => {
    expect(await webAgentTask.run(webAgentTask.args.parse({ sessionId: 's', prompt: 'Read' }), context('Observed page').ctx)).toEqual({ result: 'Observed page' });
  });

  it('rejects malformed structured JSON instead of manufacturing missing fields', async () => {
    await expect(webAgentTask.run(webAgentTask.args.parse({ sessionId: 's', prompt: 'Read', outputSchema: { type: 'object' } }), context('not JSON').ctx))
      .rejects.toMatchObject({ code: 'invalid_output' });
  });
});
