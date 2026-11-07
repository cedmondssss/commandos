import { join } from 'node:path';
import { type ModelGateway } from '@commandos/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchPageQuestion } from '../src/page-question';
import { routeLocally } from '../src/router';
import { CommandRuntime } from '../src/runtime';
import { tempDir } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('page-question routing', () => {
  it('recognizes the real Luma question without router or planning calls', () => {
    const r = routeLocally('open luma and figure out how many hackathon i have this month');
    expect(r?.decision).toMatchObject({ mode: 'fast', via: 'grammar' });
    expect(r?.pageQuestion).toMatchObject({ url: 'https://luma.com/home', scrollPages: 10 });
    expect(matchPageQuestion('Summarize this page in Arc')).toMatchObject({ browser: 'Arc', url: null, scrollPages: 0 });
    expect(matchPageQuestion('What are my upcoming events on Luma')).toMatchObject({ url: 'https://luma.com/home' });
    expect(matchPageQuestion('open https://example.com/report and tell me what it says')).toMatchObject({ url: 'https://example.com/report' });
  });

  it('leaves mutations, unsupported sites, and mixed commands to normal planning', () => {
    for (const text of [
      'open luma and register me for every hackathon',
      'open luma and list my events then delete one',
      'open gmail and read my messages and send a reply',
      'read this page and write a summary to ~/Desktop/report.md',
      'open luma and tell me my events and save a file',
      'open luma and click the next month button',
      'open luma and tell me my events then take a screenshot',
      'show me my files',
      'summarize my bank account',
      'open https://user:password@example.com and summarize it',
    ])
      expect(matchPageQuestion(text), text).toBeNull();
  });
});

describe('page answers through the full runtime', () => {
  async function harness(consent: 'allow' | 'deny' = 'allow') {
    const dir = await tempDir('commandos-page-');
    const rt = await CommandRuntime.create({
      dataDir: join(dir, 'data'),
      helperPath: '/nonexistent',
      useKeychain: false,
      telemetry: false,
      revealResults: false,
      env: {},
      settingsOverride: { allowedRoots: [dir], contentToModel: consent },
    });
    const parse = vi.fn(async (_request: Record<string, unknown>) => ({ data: { text: 'There are two hackathons this month.' } }));
    const stream = vi.fn(async () => {
      throw new Error('No planning should be needed');
    });
    vi.spyOn(rt, 'getModels').mockResolvedValue({ parse, stream } as unknown as ModelGateway);
    vi.spyOn(rt.helper, 'call').mockImplementation((async (method: string) => {
      if (method === 'workspace.open') return { opened: true };
      if (method === 'ax.enableWeb') return { ok: true, code: 0 };
      if (method === 'ax.webText')
        return { title: 'My events', url: 'https://luma.com/home', text: 'Hackathon A: October 20\nHackathon B: October 25', found: true, truncated: false, nodes: 10 };
      return { activated: true, ok: true };
    }) as typeof rt.helper.call);
    return { rt, parse, stream };
  }

  it('runs open → read → answer with one content call and shows the answer', async () => {
    const { rt, parse, stream } = await harness();
    try {
      const id = await rt.submit('open luma and figure out how many hackathon i have this month', 'text');
      const summary = await rt.waitForRun(id);
      expect(summary.state).toBe('succeeded');
      expect(summary.taskCount).toBe(3);
      expect(summary.summary).toContain('There are two hackathons');
      expect(parse).toHaveBeenCalledTimes(1);
      expect(parse.mock.calls[0]?.[0]).toMatchObject({ purpose: 'ai_write' });
      expect(stream).not.toHaveBeenCalled();
      const snap = await rt.getRun(id);
      expect(snap.events.filter((e) => e.type === 'task_added').map((e) => (e.type === 'task_added' ? e.task.tool : ''))).toEqual([
        'workspace.open',
        'browser.readPage',
        'ai.write',
      ]);
    } finally {
      await rt.shutdown();
    }
  });

  it('still enforces content consent before sending page text to the model', async () => {
    const { rt, parse } = await harness('deny');
    try {
      const id = await rt.submit('open luma and summarize my events', 'text');
      expect((await rt.waitForRun(id)).state).toBe('partial');
      expect(parse).not.toHaveBeenCalled();
    } finally {
      await rt.shutdown();
    }
  });
});
