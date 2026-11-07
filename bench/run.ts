/**
 * CommandOS benchmark suite. Every number comes from real runs through the runtime (real tools,
 * real Swift helper, real browser). Correctness is measured separately from latency: a run only
 * counts as a success when it reached `succeeded` AND every task's verification passed.
 *
 *   pnpm bench                 # offline scenarios (+ live ones when credentials exist)
 *   pnpm bench --quick         # fewer repetitions
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, mkdtemp, cp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { RouteDecision, RunMetrics, TaskSpecInput } from '@commandos/contracts';
import { transcribePcm } from '@commandos/providers';
import { CommandRuntime, webFormPlan } from '@commandos/runtime';
import { findHelperBinary } from '@commandos/tools';
import { populateScreenshotInbox } from '../scripts/gen-fixtures';
import { loadLocalEnv, ROOT } from '../scripts/lib/env';
import { wavPcm, wordErrorRate } from '../scripts/verify-providers';

loadLocalEnv();
const QUICK = process.argv.includes('--quick');
const HELPER = findHelperBinary(ROOT);

interface Sample {
  ok: boolean;
  totalMs: number;
  ttfaMs?: number;
  modelCalls: number;
  unnecessaryModelCalls: number;
  recovered: number;
  note?: string;
}

interface ScenarioResult {
  id: string;
  title: string;
  kind: 'offline' | 'live';
  status: 'ran' | 'skipped';
  reason?: string;
  runs: number;
  successRate: number;
  p50TotalMs: number | null;
  p95TotalMs: number | null;
  p50TtfaMs: number | null;
  p95TtfaMs: number | null;
  avgModelCalls: number;
  unnecessaryModelCalls: number;
  recoveredTasks: number;
  extra: Record<string, unknown>;
}

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round((sorted[idx] as number) * 10) / 10;
}

function summarize(id: string, title: string, kind: ScenarioResult['kind'], samples: Sample[], extra: Record<string, unknown> = {}): ScenarioResult {
  const ttfa = samples.flatMap((s) => (s.ttfaMs !== undefined ? [s.ttfaMs] : []));
  return {
    id,
    title,
    kind,
    status: 'ran',
    runs: samples.length,
    successRate: samples.length ? samples.filter((s) => s.ok).length / samples.length : 0,
    p50TotalMs: pct(samples.map((s) => s.totalMs), 50),
    p95TotalMs: pct(samples.map((s) => s.totalMs), 95),
    p50TtfaMs: pct(ttfa, 50),
    p95TtfaMs: pct(ttfa, 95),
    avgModelCalls: samples.length ? samples.reduce((a, s) => a + s.modelCalls, 0) / samples.length : 0,
    unnecessaryModelCalls: samples.reduce((a, s) => a + s.unnecessaryModelCalls, 0),
    recoveredTasks: samples.reduce((a, s) => a + s.recovered, 0),
    extra,
  };
}

function skipped(id: string, title: string, reason: string): ScenarioResult {
  return { id, title, kind: 'live', status: 'skipped', reason, runs: 0, successRate: 0, p50TotalMs: null, p95TotalMs: null, p50TtfaMs: null, p95TtfaMs: null, avgModelCalls: 0, unnecessaryModelCalls: 0, recoveredTasks: 0, extra: {} };
}

function sampleFrom(m: RunMetrics, ok: boolean, note?: string): Sample {
  return {
    ok: ok && m.verifiedSuccess,
    totalMs: m.totalMs ?? 0,
    ...(m.timeToFirstActionMs !== undefined ? { ttfaMs: m.timeToFirstActionMs } : {}),
    modelCalls: m.modelCalls,
    unnecessaryModelCalls: m.unnecessaryModelCalls,
    recovered: m.recoveredTasks,
    ...(note ? { note } : {}),
  };
}

async function runtimeFor(dir: string, extra: Parameters<typeof CommandRuntime.create>[0]['settingsOverride'] = {}): Promise<CommandRuntime> {
  return CommandRuntime.create({
    dataDir: join(dir, 'data'),
    helperPath: HELPER,
    revealResults: false,
    // benchmarks must never wait on a human: an unexpected approval fails the run quickly
    settingsOverride: { allowedRoots: [dir], screenshotRoots: [join(dir, 'Screenshots')], approvalTimeoutMs: 5_000, ...extra },
  });
}

const planned = (decision: Partial<RouteDecision> = {}) => async (): Promise<RouteDecision> => ({
  mode: 'fast',
  intent: 'general',
  confidence: 1,
  via: 'procedure',
  reason: 'benchmark plan',
  slots: {},
  needsFullPreview: false,
  ...decision,
});

/** A: the flagship FAST command (no renaming → no model), followed by undo, K times. */
async function fastOrganize(k: number): Promise<ScenarioResult> {
  const dir = await mkdtemp(join(tmpdir(), 'bench-fast-'));
  const rt = await runtimeFor(dir);
  const samples: Sample[] = [];
  let undoOk = 0;
  try {
    for (let i = 0; i < k; i++) {
      await populateScreenshotInbox(join(dir, 'Screenshots'), { clean: true });
      const before = (await readdir(join(dir, 'Screenshots'))).sort().join('|');
      const runId = await rt.submit(`Move my 5 latest screenshots into a folder called Bench ${i}`, 'bench');
      const s = await rt.waitForRun(runId);
      samples.push(sampleFrom(await rt.runMetrics(runId), s.state === 'succeeded'));
      const u = await rt.undo(runId);
      if (u.ok && (await readdir(join(dir, 'Screenshots'))).sort().join('|') === before) undoOk++;
    }
  } finally {
    await rt.shutdown();
  }
  return summarize('fast-organize', 'FAST screenshot organize (grammar route, 0 model calls) + undo', 'offline', samples, { undoRestoredExactly: `${undoOk}/${k}` });
}

/** B: simple native operations (mkdir, write, move) + undo, many times. */
async function nativeOps(k: number): Promise<ScenarioResult> {
  const dir = await mkdtemp(join(tmpdir(), 'bench-native-'));
  const rt = await runtimeFor(dir);
  const samples: Sample[] = [];
  try {
    for (let i = 0; i < k; i++) {
      const base = join(dir, `op${i}`);
      const runId = await rt.submit(
        `native op ${i}`,
        'bench',
        false,
        null,
        async (executor) => {
          executor.addPlan({
            goal: 'native ops',
            tasks: [
              { id: 'mk', tool: 'fs.mkdir', args: { path: base } },
              { id: 'write', tool: 'fs.writeText', args: { path: join(base, 'a.txt'), content: `run ${i}` }, dependsOn: ['mk'] },
              { id: 'move', tool: 'fs.move', args: { from: join(base, 'a.txt'), to: join(base, 'b.txt') }, dependsOn: ['write'] },
            ],
          });
          executor.seal();
          return planned()();
        },
      );
      const s = await rt.waitForRun(runId);
      const u = await rt.undo(runId);
      samples.push(sampleFrom(await rt.runMetrics(runId), s.state === 'succeeded' && u.ok, u.ok ? undefined : u.failures.join('; ')));
    }
  } finally {
    await rt.shutdown();
  }
  return summarize('native-ops', 'Simple native operations (mkdir → write → move, verified) + undo', 'offline', samples);
}

/**
 * C: a multi-branch command (W5): independent OCR, two separate browser branches, document
 * extraction and a file search — run with concurrency 6 vs 1.
 */
async function parallelDag(reps: number): Promise<ScenarioResult> {
  const dir = await mkdtemp(join(tmpdir(), 'bench-parallel-'));
  await populateScreenshotInbox(join(dir, 'Screenshots'));
  await cp(join(ROOT, 'fixtures', 'fs', 'docs'), join(dir, 'Docs'), { recursive: true });
  const site = await serve(join(ROOT, 'fixtures', 'site'));
  const files = (await readdir(join(dir, 'Screenshots'))).filter((f) => f.endsWith('.png')).slice(0, 4);
  const browserBranch = (n: string, page: string): TaskSpecInput[] => [
    { id: `open_${n}`, tool: 'web.open', args: { provider: 'local', url: `${site.base}/${page}`, headless: true } },
    { id: `read_${n}`, tool: 'web.extract', args: { sessionId: '' }, dependsOn: [`open_${n}`], bind: [{ arg: 'sessionId', from: `open_${n}.output.sessionId` }] },
    { id: `close_${n}`, tool: 'web.close', args: { sessionId: '' }, dependsOn: [`open_${n}`, `read_${n}`], bind: [{ arg: 'sessionId', from: `open_${n}.output.sessionId` }] },
  ];
  const tasks: TaskSpecInput[] = [
    ...files.map((f, i) => ({ id: `ocr${i}`, tool: 'image.ocr', args: { images: [join(dir, 'Screenshots', f)], level: 'accurate' } })),
    ...browserBranch('catalog', 'catalog.html'),
    ...browserBranch('order', 'order.html'),
    { id: 'docs', tool: 'docs.extract', args: { paths: [join(dir, 'Docs', 'invoice-INV-2026-0142.pdf'), join(dir, 'Docs', 'memo-office-move.docx'), join(dir, 'Docs', 'memo-office-move.rtf')] } },
    { id: 'find', tool: 'fs.find', args: { roots: [dir], extensions: ['.png', '.pdf'] } },
  ];
  const timeWith = async (concurrency: number): Promise<{ samples: Sample[]; overlap: number }> => {
    const rt = await runtimeFor(dir, { maxConcurrency: concurrency });
    const samples: Sample[] = [];
    let maxOverlap = 0;
    try {
      for (let r = 0; r < reps; r++) {
        const runId = await rt.submit(`multi-branch x${concurrency}`, 'bench', false, null, async (executor) => {
          executor.addPlan({ goal: 'independent branches', tasks });
          executor.seal();
          return planned()();
        });
        const s = await rt.waitForRun(runId);
        const snap = await rt.getRun(runId);
        let running = 0;
        for (const e of snap.events) {
          if (e.type !== 'task_state') continue;
          if (e.state === 'running') running++;
          if (['succeeded', 'failed', 'cancelled'].includes(e.state)) running--;
          maxOverlap = Math.max(maxOverlap, running);
        }
        samples.push(sampleFrom(await rt.runMetrics(runId), s.state === 'succeeded'));
      }
    } finally {
      await rt.shutdown();
    }
    return { samples, overlap: maxOverlap };
  };
  try {
    const seq = await timeWith(1);
    const par = await timeWith(6);
    const p50 = (xs: Sample[]) => pct(xs.map((s) => s.totalMs), 50) ?? 0;
    const speedup = p50(seq.samples) / Math.max(1, p50(par.samples));
    return summarize('parallel-dag', `Multi-branch DAG (${tasks.length} tasks: OCR, 2 browser branches, documents, search): concurrency 6 vs 1`, 'offline', par.samples, {
      sequentialP50Ms: p50(seq.samples),
      parallelP50Ms: p50(par.samples),
      speedup: Math.round(speedup * 100) / 100,
      maxConcurrentTasks: par.overlap,
      sequentialSuccess: seq.samples.filter((s) => s.ok).length / seq.samples.length,
    });
  } finally {
    site.server.close();
  }
}

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

/** D: failure detection + selective recovery (layout B breaks selectors), local headless browser. */
async function recoveryLayoutB(k: number): Promise<ScenarioResult> {
  const site = await serve(join(ROOT, 'fixtures', 'site'));
  const dir = await mkdtemp(join(tmpdir(), 'bench-recovery-'));
  const rt = await runtimeFor(dir);
  const samples: Sample[] = [];
  try {
    for (let i = 0; i < k; i++) {
      const runId = await rt.submit('fill the draft request on layout B', 'bench', false, null, async (executor) => {
        executor.addPlan(
          webFormPlan({
            baseUrl: site.base,
            provider: 'local',
            headless: true,
            company: 'Rivera Labs',
            email: 'ops@rivera.example',
            quantity: 40,
            neededBy: null,
            notes: null,
            sku: null,
            criteria: 'cheapest in stock',
            variant: 'b',
          }),
        );
        executor.seal();
        return planned({ intent: 'web_research_form' })();
      });
      const s = await rt.waitForRun(runId);
      samples.push(sampleFrom(await rt.runMetrics(runId), s.state === 'succeeded'));
    }
  } finally {
    await rt.shutdown();
    site.server.close();
  }
  return summarize('recovery-layout-b', 'Failure detection + selective recovery (selectors broken by redesign)', 'offline', samples);
}

/** E (live): speech-to-transcript latency through ElevenLabs Scribe v2 Realtime. */
async function voiceLatency(k: number): Promise<ScenarioResult> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return skipped('voice-stt', 'Voice: speech end → committed transcript (ElevenLabs)', 'ELEVENLABS_API_KEY not set');
  const sentence = 'Find my five latest screenshots and put them in a folder called receipts.';
  const dir = await mkdtemp(join(tmpdir(), 'bench-voice-'));
  const wav = join(dir, 'u.wav');
  execFileSync('/usr/bin/say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@16000', sentence]);
  const pcm = wavPcm(await readFile(wav));
  const samples: Sample[] = [];
  const wers: number[] = [];
  for (let i = 0; i < k; i++) {
    const t0 = performance.now();
    try {
      const r = await transcribePcm(key, pcm, { realtime: true, chunkMs: 100 });
      const wer = wordErrorRate(sentence, r.text);
      wers.push(wer);
      samples.push({ ok: wer <= 0.25, totalMs: r.metrics.speechEndToCommitMs ?? performance.now() - t0, modelCalls: 0, unnecessaryModelCalls: 0, recovered: 0 });
    } catch (e) {
      samples.push({ ok: false, totalMs: performance.now() - t0, modelCalls: 0, unnecessaryModelCalls: 0, recovered: 0, note: String(e) });
    }
  }
  const res = summarize('voice-stt', 'Voice: speech end → committed transcript (ElevenLabs Scribe v2 Realtime)', 'live', samples, { meanWer: wers.length ? wers.reduce((a, b) => a + b, 0) / wers.length : null });
  return { ...res, kind: 'live' };
}

/** F (live): STANDARD planning — time to first action while the model is still streaming. */
async function standardPlanner(k: number): Promise<ScenarioResult> {
  if (!process.env.OPENAI_API_KEY) return skipped('standard-planner', 'STANDARD planner (streamed tool calls)', 'OPENAI_API_KEY not set');
  const dir = await mkdtemp(join(tmpdir(), 'bench-standard-'));
  await cp(join(ROOT, 'fixtures', 'fs', 'docs'), join(dir, 'Inbox'), { recursive: true });
  const rt = await runtimeFor(dir);
  const samples: Sample[] = [];
  try {
    for (let i = 0; i < k; i++) {
      const runId = await rt.submit(`Read every document in ${join(dir, 'Inbox')} and write summary-${i}.md in that folder with one bullet per document.`, 'bench');
      const s = await rt.waitForRun(runId);
      samples.push(sampleFrom(await rt.runMetrics(runId), s.state === 'succeeded'));
    }
  } finally {
    await rt.shutdown();
  }
  return { ...summarize('standard-planner', 'STANDARD planner: document summary (streamed tool calls)', 'live', samples), kind: 'live' };
}

/**
 * G (live): everyday commands, prompt → done. Each run only counts as a success when the run
 * verified AND its output is what the user asked for (files, contents, the answer).
 */
async function promptLatency(k: number): Promise<ScenarioResult> {
  if (!process.env.OPENAI_API_KEY) return skipped('prompt-latency', 'Prompt → done: everyday commands (live, output-checked)', 'OPENAI_API_KEY not set');
  const dir = await mkdtemp(join(tmpdir(), 'bench-latency-'));
  await cp(join(ROOT, 'fixtures', 'fs', 'docs'), join(dir, 'Docs'), { recursive: true });
  await populateScreenshotInbox(join(dir, 'Screenshots'), { clean: true });
  const rt = await runtimeFor(dir);
  // sending a fixture screenshot to the vision model is the one approval a user would give here
  rt.on('run', (e) => {
    if (e.type === 'approval_requested') rt.respondApproval(e.approval.id, /sends images to the model provider/.test(JSON.stringify(e.approval)) ? 'approve' : 'deny');
  });
  const read = (p: string) => readFile(join(dir, p), 'utf8').catch(() => '');
  const commands: Array<{ id: string; text: (i: number) => string; check: (i: number, summary: string) => Promise<boolean> }> = [
    {
      id: 'folder + file',
      text: (i) => `Create a folder named checks-${i} inside ${dir}, then write a file hello.txt inside it containing exactly: verified`,
      check: async (i) => (await read(`checks-${i}/hello.txt`)).trim() === 'verified',
    },
    {
      id: 'folder + 3 files',
      text: (i) => `Make a folder ${dir}/notes-${i} and write three files in it: a.txt with "alpha", b.txt with "beta", c.txt with "gamma"`,
      check: async (i) => [await read(`notes-${i}/a.txt`), await read(`notes-${i}/b.txt`), await read(`notes-${i}/c.txt`)].map((t) => t.trim()).join() === 'alpha,beta,gamma',
    },
    {
      id: 'list, then report',
      text: (i) => `List the files in ${dir}/notes-${i} and then write a report called inventory-${i}.md in ${dir} that lists them`,
      check: async (i) => /a\.txt/.test(await read(`inventory-${i}.md`)) && /c\.txt/.test(await read(`inventory-${i}.md`)),
    },
    {
      id: 'question about a screenshot',
      text: () => `Look at the newest screenshot in ${join(dir, 'Screenshots')} and tell me what it shows`,
      check: async (_i, summary) => /blue bottle|receipt/i.test(summary),
    },
    {
      id: 'summarize documents',
      text: (i) => `Read every document in ${join(dir, 'Docs')} and write a file called summary-${i}.md in that same folder with one bullet per document: its file name and a one-line summary.`,
      check: async (i) => {
        const t = await read(`Docs/summary-${i}.md`);
        return /invoice/i.test(t) && /checklist/i.test(t) && /memo/i.test(t);
      },
    },
  ];
  const samples: Sample[] = [];
  const perCommand: Record<string, number[]> = {};
  try {
    for (let i = 0; i < k; i++) {
      for (const c of commands) {
        const runId = await rt.submit(c.text(i), 'bench');
        const s = await rt.waitForRun(runId);
        const m = await rt.runMetrics(runId);
        const ok = s.state === 'succeeded' && (await c.check(i, s.summary ?? ''));
        samples.push(sampleFrom(m, ok, ok ? undefined : `${c.id}: ${s.state} ${s.summary ?? ''}`.slice(0, 200)));
        (perCommand[c.id] ??= []).push(m.totalMs ?? 0);
      }
    }
  } finally {
    await rt.shutdown();
  }
  const extra = Object.fromEntries(Object.entries(perCommand).map(([id, xs]) => [`${id} p50`, `${((pct(xs, 50) ?? 0) / 1000).toFixed(2)} s`]));
  const failures = samples.flatMap((x) => (x.note ? [x.note] : []));
  return { ...summarize('prompt-latency', 'Prompt → done: everyday commands (live, output-checked)', 'live', samples, failures.length ? { ...extra, failures: failures.join(' / ') } : extra), kind: 'live' };
}

function renderMarkdown(results: ScenarioResult[], at: string): string {
  const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
  const lines = [
    `# CommandOS benchmark — ${at}`,
    '',
    `Machine: ${process.platform} ${process.arch}, Node ${process.version}. Every row comes from real runs; success requires a succeeded run with every verification passing.`,
    '',
    '| Scenario | Runs | Verified success | p50 total | p95 total | p50 first action | p95 first action | Avg model calls | Unnecessary model calls | Recovered tasks | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    if (r.status === 'skipped') {
      lines.push(`| ${r.title} | — | — | — | — | — | — | — | — | — | skipped: ${r.reason} |`);
      continue;
    }
    lines.push(
      `| ${r.title} | ${r.runs} | ${(r.successRate * 100).toFixed(1)}% | ${ms(r.p50TotalMs)} | ${ms(r.p95TotalMs)} | ${ms(r.p50TtfaMs)} | ${ms(r.p95TtfaMs)} | ${r.avgModelCalls.toFixed(2)} | ${r.unnecessaryModelCalls} | ${r.recoveredTasks} | ${Object.entries(r.extra)
        .map(([k, v]) => `${k}: ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`)
        .join('; ')} |`,
    );
  }
  const get = (id: string) => results.find((r) => r.id === id && r.status === 'ran');
  const fast = get('fast-organize');
  const native = get('native-ops');
  const par = get('parallel-dag');
  lines.push('', '## Targets (proposed engineering targets vs measured)', '', '| Target | Measured | Met? |', '|---|---|---|');
  const row = (t: string, m: string, ok: boolean | null) => lines.push(`| ${t} | ${m} | ${ok === null ? 'not measured' : ok ? 'yes' : 'no'} |`);
  row('Time to first visible action < 2 s (p50): deterministic FAST workflows', fast ? ms(fast.p50TtfaMs) : '—', fast ? (fast.p50TtfaMs ?? 99999) < 2000 : null);
  const planned = get('prompt-latency') ?? get('standard-planner');
  row(
    'Time to first visible action < 2 s (p50): model-planned everyday commands',
    planned ? `${ms(planned.p50TtfaMs)} (first streamed task)` : '—',
    planned ? (planned.p50TtfaMs ?? 99999) < 2000 : null,
  );
  row('Simple native operation success ≥ 99%', native ? `${(native.successRate * 100).toFixed(1)}% of ${native.runs}` : '—', native ? native.successRate >= 0.99 : null);
  const multi = results.filter((r) => r.status === 'ran' && r.id !== 'native-ops' && r.id !== 'voice-stt');
  const multiRate = multi.length ? multi.reduce((a, r) => a + r.successRate * r.runs, 0) / multi.reduce((a, r) => a + r.runs, 0) : null;
  row('Multistep workflow success ≥ 90%', multiRate === null ? '—' : `${(multiRate * 100).toFixed(1)}%`, multiRate === null ? null : multiRate >= 0.9);
  row('Unnecessary model calls = 0 for deterministic procedures', fast ? String(fast.unnecessaryModelCalls) : '—', fast ? fast.unnecessaryModelCalls === 0 : null);
  row('Parallel execution reduces completion time', par ? `${par.extra.speedup}× faster (${ms(par.extra.sequentialP50Ms as number)} → ${ms(par.extra.parallelP50Ms as number)})` : '—', par ? Number(par.extra.speedup) > 1 : null);
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const k = QUICK ? 5 : 20;
  const results: ScenarioResult[] = [];
  for (const [name, fn] of [
    ['fast-organize', () => fastOrganize(k)],
    ['native-ops', () => nativeOps(QUICK ? 20 : 100)],
    ['parallel-dag', () => parallelDag(QUICK ? 2 : 5)],
    ['recovery-layout-b', () => recoveryLayoutB(QUICK ? 3 : 10)],
    ['voice-stt', () => voiceLatency(QUICK ? 2 : 5)],
    ['standard-planner', () => standardPlanner(QUICK ? 1 : 3)],
    ['prompt-latency', () => promptLatency(QUICK ? 1 : 3)],
  ] as const) {
    process.stdout.write(`▶ ${name}… `);
    const t0 = performance.now();
    const r = await fn();
    results.push(r);
    console.log(r.status === 'skipped' ? `skipped (${r.reason})` : `${r.runs} runs, ${(r.successRate * 100).toFixed(0)}% verified, p50 ${r.p50TotalMs} ms (${Math.round((performance.now() - t0) / 1000)} s)`);
  }
  const at = new Date().toISOString();
  const out = join(ROOT, 'bench', 'results');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `${at.replace(/[:.]/g, '-')}.json`), `${JSON.stringify({ at, quick: QUICK, results }, null, 2)}\n`);
  await writeFile(join(out, 'latest.json'), `${JSON.stringify({ at, quick: QUICK, results }, null, 2)}\n`);
  const md = renderMarkdown(results, at);
  await writeFile(join(out, 'latest.md'), md);
  console.log(`\n${md}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
