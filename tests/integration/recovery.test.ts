import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '@commandos/contracts';
import { BrowserHub, ModelGateway } from '@commandos/providers';
import { ApprovalBroker, createRecovery, type ExecutorEvent, RunExecutor, UndoJournal, webFormPlan } from '@commandos/runtime';
import { createDefaultRegistry, HelperClient } from '@commandos/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLocalEnv } from '../../scripts/lib/env';
import { tempDir } from '../../packages/runtime/test/helpers';

loadLocalEnv();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function serve(dir: string): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/+/, '') || 'index.html';
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { 'content-type': extname(path) === '.css' ? 'text/css' : 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function runWebForm(base: string, variant: string, models: ModelGateway | null) {
  const hub = new BrowserHub(async () => null);
  const dir = await tempDir('commandos-w6-');
  const events: ExecutorEvent[] = [];
  // the runtime forwards gateway calls into the run's events; do the same here
  const off = models?.onCall((call) => events.push({ type: 'model_call', call }));
  const controller = new AbortController();
  const approvals = new ApprovalBroker({ requested: () => {}, resolved: () => {} });
  const executor = new RunExecutor(
    {
      registry: createDefaultRegistry(),
      settings: () => defaultSettings(),
      helper: new HelperClient('/nonexistent'),
      models: () => models,
      providers: { get: async <T>(n: string) => (n === 'browser' ? (hub as T) : Promise.reject(new Error('none'))) },
      approvals,
      emit: (e) => events.push(e),
      audit: () => {},
      recover: createRecovery(models, 'run_w6'),
    },
    { runId: 'run_w6', artifactsDir: dir, journal: new UndoJournal(join(dir, 'j.jsonl'), 'run_w6'), dryRun: false, signal: controller.signal, deadlineAt: Date.now() + 120_000 },
  );
  executor.addPlan(
    webFormPlan({
      baseUrl: base,
      provider: 'local',
      headless: true,
      company: 'Rivera Labs',
      email: 'ops@rivera.example',
      quantity: 40,
      neededBy: null,
      notes: null,
      sku: null,
      criteria: 'cheapest in stock',
      variant,
    }),
  );
  executor.seal();
  const result = await executor.done();
  off?.();
  await hub.closeAll();
  return { result, events, executor };
}

let site: { server: Server; base: string };
beforeAll(async () => {
  site = await serve(join(ROOT, 'fixtures', 'site'));
});
afterAll(() => site?.server.close());

describe('Workflow 6: failure detection and selective recovery (real browser)', () => {
  it('layout A fills by selector on the first attempt', async () => {
    const { result, executor } = await runWebForm(site.base, '', null);
    expect(result.failed).toBe(0);
    expect(executor.get('fill')?.attempt).toBe(1);
    expect(executor.outputOf('pick')).toMatchObject({ rows: [{ SKU: 'NW-2210' }] });
  });

  it('layout B breaks selectors; only the failed node is retried, via label matching, with zero model calls', async () => {
    const { result, events, executor } = await runWebForm(site.base, 'b', null);
    expect(result.failed).toBe(0);
    const fill = executor.get('fill');
    expect(fill?.state).toBe('succeeded');
    expect(fill?.attempt).toBe(2);
    expect((fill?.output as { filled: Array<{ by: string }> }).filled.every((f) => f.by === 'label')).toBe(true);
    const narration = events.flatMap((e) => (e.type === 'narration' ? [e.text] : []));
    expect(narration.some((t) => /recovering \(alternative\): locate fields by visible label/.test(t))).toBe(true);
    // upstream tasks ran exactly once: no full replan
    for (const id of ['open', 'catalog', 'pick', 'goto']) expect(executor.get(id)?.attempt).toBe(1);
    expect(events.filter((e) => e.type === 'model_call')).toHaveLength(0);
  });

  it('without a model, layout C (relabelled fields) fails cleanly instead of guessing', async () => {
    const { result, executor } = await runWebForm(site.base, 'c', null);
    expect(executor.get('fill')?.state).toBe('failed');
    expect(executor.get('fill')?.error).toMatch(/Fields on this page: .*Work email address/);
    expect(executor.get('evidence')?.state).toBe('skipped');
    expect(result.failed).toBe(1);
  });

  it.skipIf(!process.env.OPENAI_API_KEY)(`layout C is repaired by the model tier (${process.env.OPENAI_API_KEY ? 'live' : 'skipped: OPENAI_API_KEY not set'})`, async () => {
    const s = defaultSettings();
    const models = new ModelGateway({ apiKey: process.env.OPENAI_API_KEY as string, models: s.models, efforts: s.efforts });
    const { result, events, executor } = await runWebForm(site.base, 'c', models);
    expect(result.failed).toBe(0);
    expect(executor.get('fill')?.state).toBe('succeeded');
    const repairCalls = events.filter((e) => e.type === 'model_call' && e.call.purpose === 'repair_node');
    expect(repairCalls.length).toBeGreaterThanOrEqual(1);
    const narration = events.flatMap((e) => (e.type === 'narration' ? [e.text] : []));
    expect(narration.some((t) => /recovering \(repair, fast model\)/.test(t))).toBe(true);
    // upstream steps were not re-run
    for (const id of ['open', 'catalog', 'pick', 'goto']) expect(executor.get(id)?.attempt).toBe(1);
    const filled = (executor.get('fill')?.output as { filled: Array<{ field: string; by: string }> }).filled;
    console.log('layout C repaired:', narration.filter((t) => t.includes('recovering')).join(' | '), '→', filled.map((f) => `${f.field} by ${f.by}`).join(', '));
  }, 240_000);
});
