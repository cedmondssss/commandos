import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelCall } from '@commandos/contracts';
import { defaultSettings } from '@commandos/contracts';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';
import { hedged, ModelGateway } from '../src/openai';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

describe('hedged requests', () => {
  it('starts no second request when the first answers before the hedge delay', async () => {
    const started: number[] = [];
    const v = await hedged(
      async (signal, i) => {
        started.push(i);
        await sleep(10, signal);
        return `r${i}`;
      },
      { afterMs: 200 },
    );
    expect(v).toBe('r0');
    expect(started).toEqual([0]);
  });

  it('keeps the faster of two requests and aborts the slower one', async () => {
    const aborted: number[] = [];
    const v = await hedged(
      async (signal, i) => {
        signal.addEventListener('abort', () => aborted.push(i));
        await sleep(i === 0 ? 500 : 20, signal);
        return `r${i}`;
      },
      { afterMs: 0 },
    );
    expect(v).toBe('r1');
    expect(aborted).toEqual([0]);
  });

  it('starts the second request at once when the first fails, and rejects only when both fail', async () => {
    const started: Array<{ i: number; at: number }> = [];
    const t0 = performance.now();
    const ok = await hedged(
      async (_signal, i) => {
        started.push({ i, at: performance.now() - t0 });
        if (i === 0) throw new Error('first failed');
        return 'second';
      },
      { afterMs: 5_000 },
    );
    expect(ok).toBe('second');
    expect(started[1]!.at).toBeLessThan(1_000);
    await expect(
      hedged(
        async (_s, i) => {
          throw new Error(`fail ${i}`);
        },
        { afterMs: 0 },
      ),
    ).rejects.toThrow('fail 0');
  });

  it('stops when the caller aborts', async () => {
    const parent = new AbortController();
    const p = hedged(async (signal) => sleep(1_000, signal), { afterMs: 0, signal: parent.signal });
    setTimeout(() => parent.abort(new Error('stopped by user')), 20);
    await expect(p).rejects.toThrow('stopped by user');
  });
});

/** Serves Responses API streams: the first request waits `slowMs` before any output. */
async function fakeResponsesServer(slowMs: number) {
  let n = 0;
  const closedEarly: number[] = [];
  const server = createServer((req, res) => {
    const index = n++;
    let finished = false;
    req.on('data', () => {});
    res.on('close', () => {
      if (!finished) closedEarly.push(index);
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (ev: Record<string, unknown>) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    const response = { id: `resp_${index}`, object: 'response', status: 'in_progress', output: [], usage: null };
    send({ type: 'response.created', sequence_number: 0, response });
    setTimeout(
      () => {
        const item = { type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: 'schedule', arguments: '', status: 'in_progress' };
        send({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item });
        send({ type: 'response.function_call_arguments.delta', sequence_number: 2, output_index: 0, item_id: item.id, delta: `{"from":${index}}` });
        send({ type: 'response.function_call_arguments.done', sequence_number: 3, output_index: 0, item_id: item.id, arguments: `{"from":${index}}` });
        const done = { ...item, arguments: `{"from":${index}}`, status: 'completed' };
        send({ type: 'response.completed', sequence_number: 4, response: { ...response, status: 'completed', output: [done], usage: { input_tokens: 10, output_tokens: 5 } } });
        finished = true;
        res.end();
      },
      index === 0 ? slowMs : 10,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, closedEarly, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

describe('hedged streams', () => {
  it('delivers only the first stream to produce output and cancels the other before it can act', async () => {
    const fake = await fakeResponsesServer(1_500);
    try {
      const s = defaultSettings();
      const calls: ModelCall[] = [];
      const gw = new ModelGateway({ apiKey: 'test', baseURL: fake.baseURL, models: s.models, efforts: s.efforts, onCall: (c) => calls.push(c) });
      const seen: ResponseStreamEvent[] = [];
      const started = performance.now();
      const { response } = await gw.stream({ tier: 'main', purpose: 'plan_turn_1', instructions: 'x', input: [], tools: [], hedge: true, onEvent: (ev) => seen.push(ev) });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(response.id).toBe('resp_1');
      // every delivered event came from the winning stream
      const args = seen.flatMap((e) => (e.type === 'response.function_call_arguments.done' ? [e.arguments] : []));
      expect(args).toEqual(['{"from":1}']);
      await new Promise((r) => setTimeout(r, 100));
      expect(fake.closedEarly).toEqual([0]);
      expect(calls.find((c) => c.purpose === 'plan_turn_1')?.error).toMatch(/^cancelled: hedged/);
      expect(calls.find((c) => c.purpose === 'plan_turn_1_hedge')?.ok).toBe(true);
    } finally {
      fake.server.close();
    }
  });
});
