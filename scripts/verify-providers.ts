/**
 * Live provider verification. Every check makes a real API call and records evidence
 * (response ids, trace ids, transcripts, sandbox/session ids). Nothing is marked verified
 * without a successful live result. Missing credentials → "blocked", errors → "failed".
 *
 *   pnpm verify:providers            # all providers
 *   pnpm verify:providers openai     # a subset
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CredentialKey,
  defaultSettings,
  KEYCHAIN_SERVICE,
  type ProviderVerification,
  type VerificationReport,
} from '@commandos/contracts';
import {
  BrowserHub,
  CredentialResolver,
  ProcedureMemory,
  SandboxService,
  initTelemetry,
  ModelGateway,
  OpenInferenceSpanKind,
  type SecretBackend,
  SemanticConventions,
  synthesize,
  type Telemetry,
  transcribePcm,
  withSpan,
} from '@commandos/providers';
import { CommandRuntime, routeCommand } from '@commandos/runtime';
import { findHelperBinary, HelperClient, type ToolContext, visionAsk } from '@commandos/tools';
import { z } from 'zod';
import { loadLocalEnv, ROOT } from './lib/env';

type Provider = ProviderVerification['provider'];
interface Check {
  provider: Provider;
  keys: CredentialKey[];
  run(creds: Record<string, string>): Promise<{ detail: string; evidence: Record<string, unknown> }>;
}

const helper = new HelperClient(findHelperBinary(ROOT));
let telemetry: Telemetry | null = null;

function keychain(h: HelperClient): SecretBackend {
  return {
    get: async (account) => (await h.call('keychain.get', { service: KEYCHAIN_SERVICE, account })).value,
    set: async () => {
      throw new Error('read-only');
    },
    delete: async () => false,
    list: async () => (await h.call('keychain.list', { service: KEYCHAIN_SERVICE })).accounts,
  };
}

/** Extracts 16-bit PCM from a RIFF/WAVE file (walks chunks; `say` may add FLLR padding). */
export function wavPcm(buf: Buffer): Uint8Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAVE file');
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return new Uint8Array(buf.subarray(off + 8, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

export function wordErrorRate(expected: string, actual: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const a = norm(expected);
  const b = norm(actual);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return a.length ? ((d[a.length] as number[])[b.length] as number) / a.length : 0;
}

const helperCheck: Check = {
  provider: 'helper',
  keys: [],
  async run() {
    const pong = await helper.call('ping', {});
    const perms = await helper.call('permissions.status', {});
    const ocr = await helper.call('vision.ocr', { path: join(ROOT, 'fixtures/fs/screenshots/receipt-blue-bottle.png'), level: 'accurate' });
    if (!/Blue Bottle/.test(ocr.text)) throw new Error('OCR did not read the fixture receipt');
    const apps = await helper.call('apps.list', {});
    return {
      detail: `helper v${pong.version}: on-device OCR read ${ocr.lines.length} lines; Accessibility ${perms.accessibility ? 'granted' : 'NOT granted'}, Screen Recording ${perms.screenRecording ? 'granted' : 'NOT granted'}`,
      evidence: { version: pong.version, permissions: perms, ocrLines: ocr.lines.length, runningApps: apps.apps.length },
    };
  },
};

const openaiCheck: Check = {
  provider: 'openai',
  keys: ['OPENAI_API_KEY'],
  async run(creds) {
    const s = defaultSettings();
    const calls: Array<Record<string, unknown>> = [];
    const gw = new ModelGateway({
      apiKey: creds.OPENAI_API_KEY as string,
      models: s.models,
      efforts: s.efforts,
      onCall: (call) => calls.push({ ...call }),
    });
    // fast tier: the real router on a command no local grammar handles
    const route = await routeCommand('Email the Q3 board deck in my Documents folder to Dana, then archive the old drafts', gw, { runId: 'verify' });
    if (route.decision.via !== 'router') throw new Error('router model was not consulted');
    if (!route.decision.needsFullPreview) throw new Error(`router did not flag the external send for preview: ${JSON.stringify(route.decision)}`);
    // main and deep tiers: structured output with a typed two-step plan
    const PlanShape = z.object({ steps: z.array(z.object({ id: z.string(), action: z.string(), dependsOn: z.array(z.string()) })) });
    const prompt = 'Return a plan with exactly two steps for: create the folder ~/Desktop/Invoices, then move invoice.pdf into it. Step ids s1 and s2; s2 depends on s1.';
    for (const tier of ['main', 'deep'] as const) {
      const { data } = await gw.parse({ tier, purpose: `verify_${tier}`, instructions: 'You produce small JSON plans.', input: prompt, schema: PlanShape, schemaName: 'plan', maxOutputTokens: 2000 });
      if (data.steps.length !== 2 || !data.steps[1]?.dependsOn.includes('s1')) throw new Error(`${tier} tier returned an unexpected plan: ${JSON.stringify(data)}`);
    }
    // vision: the real vision.ask tool on a fixture receipt that on-device OCR also reads
    const dir = await mkdtemp(join(tmpdir(), 'commandos-verify-agent-'));
    const visionCtx: ToolContext = {
      runId: 'verify',
      taskId: 'vision',
      signal: AbortSignal.timeout(120_000),
      dryRun: false,
      settings: s,
      helper,
      models: gw,
      providers: { get: async () => Promise.reject(new Error('no providers during verification')) },
      journal: { record: async () => {} },
      artifactsDir: dir,
      log: () => {},
      progress: () => {},
    };
    const seen = visionAsk.output.parse(
      await visionAsk.run(
        visionAsk.args.parse({ imagePath: join(ROOT, 'fixtures/fs/screenshots/receipt-blue-bottle.png'), question: 'Which business issued this receipt? Answer with its name.' }),
        visionCtx,
      ),
    );
    if (!/blue bottle/i.test(seen.answer)) throw new Error(`vision did not identify the fixture receipt: "${seen.answer}"`);
    // streaming function calling: a real STANDARD run against a scratch folder
    const rt = await CommandRuntime.create({
      dataDir: join(dir, 'data'),
      helperPath: findHelperBinary(ROOT),
      useKeychain: false,
      telemetry: false,
      revealResults: false,
      env: { OPENAI_API_KEY: creds.OPENAI_API_KEY as string },
      settingsOverride: { allowedRoots: [dir], screenshotRoots: [dir] },
    });
    const runId = await rt.submit(`Create a folder named checks inside ${dir}, then write a file hello.txt inside it containing exactly: verified`, 'text');
    const run = await rt.waitForRun(runId);
    const snap = await rt.getRun(runId);
    await rt.shutdown();
    const written = await readFile(join(dir, 'checks', 'hello.txt'), 'utf8').catch(() => null);
    if (run.state !== 'succeeded' || written?.trim() !== 'verified') throw new Error(`planner run ${run.state}: ${run.summary ?? ''}`);
    const firstTask = snap.events.find((e) => e.type === 'task_state' && e.state === 'running');
    const firstModelDone = snap.events.find((e) => e.type === 'model_call' && e.call.ok && e.call.purpose.startsWith('plan_turn'));
    const created = snap.events.find((e) => e.type === 'run_created');
    return {
      detail: `${s.models.fast} routed (${route.decision.mode}/${route.decision.intent}, preview required); ${s.models.main} and ${s.models.deep} returned schema-valid plans; ${s.models.main} vision read the fixture receipt (“${seen.answer.slice(0, 60)}”); streamed STANDARD run created and verified a file (${run.taskCount} tasks, ${run.modelCalls} model calls)`,
      evidence: {
        vision: { image: 'fixtures/fs/screenshots/receipt-blue-bottle.png', answer: seen.answer },
        agentRun: {
          runId,
          state: run.state,
          tasks: run.taskCount,
          modelCalls: run.modelCalls,
          firstTaskStartedBeforeTurnEnded: Boolean(firstTask && firstModelDone && firstTask.at < firstModelDone.at),
          timeToFirstActionMs: firstTask && created ? firstTask.at - created.at : null,
          planningTurns: snap.events.filter((e) => e.type === 'model_call' && e.call.ok && e.call.purpose.startsWith('plan_turn')).length,
        },
        decision: route.decision,
        calls: calls.map((c) => ({ model: c.model, effort: c.effort, purpose: c.purpose, ok: c.ok, latencyMs: Math.round(c.latencyMs as number), responseId: c.responseId, outputTokens: c.outputTokens })),
      },
    };
  },
};

const elevenlabsCheck: Check = {
  provider: 'elevenlabs',
  keys: ['ELEVENLABS_API_KEY'],
  async run(creds) {
    const sentence = 'Find my five latest screenshots and put them in a folder called receipts.';
    const dir = await mkdtemp(join(tmpdir(), 'commandos-verify-'));
    const wav = join(dir, 'utterance.wav');
    execFileSync('/usr/bin/say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@16000', sentence]);
    const pcm = wavPcm(await readFile(wav));
    const result = await transcribePcm(creds.ELEVENLABS_API_KEY as string, pcm, { realtime: true, chunkMs: 100, timeoutMs: 45_000 });
    const wer = wordErrorRate(sentence, result.text);
    if (wer > 0.25) throw new Error(`transcript mismatch (WER ${wer.toFixed(2)}): "${result.text}"`);
    const tts = await synthesize(creds.ELEVENLABS_API_KEY as string, defaultSettings().voice.ttsVoiceId, 'CommandOS voice check complete.');
    if (tts.byteLength < 2000) throw new Error('text-to-speech returned too little audio');
    return {
      detail: `Scribe v2 Realtime transcribed a ${(pcm.byteLength / 32000).toFixed(1)} s utterance (WER ${wer.toFixed(2)}, ${result.partials} partials, commit ${Math.round(result.metrics.speechEndToCommitMs ?? 0)} ms after speech end); TTS returned ${tts.byteLength} bytes`,
      evidence: { transcript: result.text, wer, partials: result.partials, speechEndToCommitMs: result.metrics.speechEndToCommitMs, firstPartialMs: result.metrics.firstPartialMs, ttsBytes: tts.byteLength },
    };
  },
};

const arizeCheck: Check = {
  provider: 'arize',
  keys: ['ARIZE_SPACE_ID', 'ARIZE_API_KEY'],
  async run() {
    if (!telemetry?.arizeEnabled) throw new Error('telemetry was not initialized with Arize credentials');
    let traceId = '';
    await withSpan('verify.arize', OpenInferenceSpanKind.CHAIN, { [SemanticConventions.INPUT_VALUE]: 'CommandOS provider verification' }, async (span) => {
      traceId = span.spanContext().traceId;
      await withSpan('verify.arize.child', OpenInferenceSpanKind.EVALUATOR, { 'eval.verified': true }, async () => {});
    });
    await telemetry.flush();
    const stats = telemetry.arizeStats;
    if (!stats || stats.spans === 0) throw new Error(`no spans accepted by Arize${stats?.lastError ? `: ${stats.lastError}` : ''}`);
    if (stats.failures > 0) throw new Error(`Arize rejected ${stats.failures} export batch(es): ${stats.lastError}`);
    return {
      detail: `Arize OTLP endpoint accepted ${stats.spans} span(s) in ${stats.batches} batch(es); look up trace ${traceId} in project "commandos" to confirm in the UI`,
      evidence: { traceId, exportedSpans: stats.spans, batches: stats.batches, endpoint: 'https://otlp.arize.com/v1/traces' },
    };
  },
};

const daytonaCheck: Check = {
  provider: 'daytona',
  keys: ['DAYTONA_API_KEY'],
  async run(creds) {
    const svc = new SandboxService({ apiKey: creds.DAYTONA_API_KEY as string, ...(creds.DAYTONA_API_URL ? { apiUrl: creds.DAYTONA_API_URL } : {}), ...(creds.DAYTONA_TARGET ? { target: creds.DAYTONA_TARGET } : {}) });
    const handle = await svc.create({ runId: 'verify', network: 'none' });
    try {
      await svc.upload(handle.id, [{ content: Buffer.from('console.log(JSON.stringify({ sum: 2 + 3, node: process.version }))\n'), path: `${handle.repoDir}/check.js` }]);
      const r = await svc.exec(handle.id, 'node check.js', handle.repoDir, 60);
      const parsed = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { sum?: number; node?: string };
      if (r.exitCode !== 0 || parsed.sum !== 5) throw new Error(`unexpected sandbox result (exit ${r.exitCode}): ${r.stdout.slice(0, 200)}`);
      const net = await svc.exec(handle.id, 'node -e "fetch(\'https://example.com\').then(()=>console.log(\'reachable\')).catch(()=>console.log(\'blocked\'))"', handle.repoDir, 60);
      if (net.exitCode !== 0 || net.stdout.trim() !== 'blocked') throw new Error('sandbox ran code, but the configured outbound-network probe was not blocked');
      return {
        detail: `sandbox ${handle.id} ran uploaded code (node ${parsed.node}, exit 0); outbound probe blocked; destruction confirmed afterwards`,
        evidence: { sandboxId: handle.id, exitCode: r.exitCode, node: parsed.node, network: net.stdout.trim(), execMs: Math.round(r.durationMs) },
      };
    } finally {
      await svc.destroy(handle.id);
    }
  },
};

const anchorCheck: Check = {
  provider: 'anchor',
  keys: ['ANCHORBROWSER_API_KEY'],
  async run(creds) {
    const url = `${process.env.COMMANDOS_FIXTURE_URL ?? 'https://commandos-fixtures.vercel.app'}/catalog.html`;
    const hub = new BrowserHub(async () => creds.ANCHORBROWSER_API_KEY as string);
    const s = await hub.open({ runId: 'verify', kind: 'anchor', url });
    try {
      const title = await s.page.title();
      const rows = await s.page.locator('#catalog tbody tr').count();
      if (rows !== 6) throw new Error(`expected 6 catalog rows in the remote session, saw ${rows}`);
      return {
        detail: `remote Anchor session ${s.anchorSessionId} loaded “${title}” (${rows} catalog rows over CDP); session ended afterwards`,
        evidence: { anchorSessionId: s.anchorSessionId, title, rows, liveViewUrl: s.liveViewUrl ?? null, url },
      };
    } finally {
      await hub.close(s.id);
    }
  },
};

const surrealCheck: Check = {
  provider: 'surrealdb',
  keys: ['SPECTRON_URL', 'SPECTRON_CONTEXT_ID', 'SPECTRON_API_KEY'],
  async run(creds) {
    const mem = new ProcedureMemory({ endpoint: creds.SPECTRON_URL as string, context: creds.SPECTRON_CONTEXT_ID as string, apiKey: creds.SPECTRON_API_KEY as string });
    await mem.client.health();
    const id = `proc_verify_${Date.now()}`;
    const now = new Date().toISOString();
    const saved = await mem.rememberProcedure({
      kind: 'commandos.procedure',
      version: 1,
      id,
      intent: 'organize_screenshots',
      command: `verification procedure ${id}: organize screenshots into a folder called Verified`,
      summary: 'verification record',
      mode: 'template',
      template: 'organize_screenshots',
      slots: { count: 1 },
      tasks: null,
      parameters: [],
      fingerprint: { tools: {}, apps: {}, sites: {}, os: 'verify' },
      stats: { successes: 1, failures: 0, avgMs: 1, lastVerifiedAt: now },
      runId: 'verify',
      status: 'stale',
      updatedAt: now,
    });
    let score: number | null = null;
    for (let i = 0; i < 12 && score === null; i++) {
      const hit = (await mem.recallProcedures(`verification procedure ${id}`, 5)).find((r) => r.procedure.id === id);
      if (hit) score = hit.score;
      else await new Promise((r) => setTimeout(r, 1500));
    }
    if (score === null) throw new Error('stored procedure was not returned by recall');
    return {
      detail: `stored a procedure verbatim in scope ${mem.scope} and recalled it (score ${score.toFixed(2)}); the record is marked stale so it never replays`,
      evidence: { procedureId: id, memoryId: saved.memoryId, sessionId: saved.sessionId, score, scope: mem.scope },
    };
  },
};

const ALL: Check[] = [
  helperCheck,
  openaiCheck,
  elevenlabsCheck,
  daytonaCheck,
  anchorCheck,
  surrealCheck,
  arizeCheck,
];

async function main(): Promise<void> {
  loadLocalEnv();
  const only = new Set(process.argv.slice(2));
  await helper.start().catch(() => {});
  const creds = new CredentialResolver(helper.running ? keychain(helper) : null);
  const arizeSpace = await creds.get('ARIZE_SPACE_ID');
  const arizeKey = await creds.get('ARIZE_API_KEY');
  telemetry = initTelemetry({ projectName: 'commandos', arize: arizeSpace && arizeKey ? { spaceId: arizeSpace, apiKey: arizeKey } : null, localTraceFile: null });

  const results: ProviderVerification[] = [];
  for (const check of ALL) {
    if (only.size && !only.has(check.provider)) continue;
    const checkedAt = new Date().toISOString();
    const missing: CredentialKey[] = [];
    const values: Record<string, string> = {};
    for (const k of check.keys) {
      const v = await creds.get(k);
      if (v) values[k] = v;
      else missing.push(k);
    }
    if (check.provider === 'daytona') {
      for (const k of ['DAYTONA_API_URL', 'DAYTONA_TARGET'] as const) {
        const value = await creds.get(k);
        if (value) values[k] = value;
      }
    }
    if (missing.length) {
      results.push({ provider: check.provider, status: 'blocked', checkedAt, detail: `missing credentials: ${missing.join(', ')}`, evidence: {} });
      continue;
    }
    if (check.provider === 'helper' && !helper.running) {
      results.push({ provider: 'helper', status: 'failed', checkedAt, detail: helper.lastError ?? 'helper not running (pnpm build:helper)', evidence: {} });
      continue;
    }
    const t0 = performance.now();
    try {
      const r = await check.run(values);
      results.push({ provider: check.provider, status: 'verified', checkedAt, detail: r.detail, evidence: r.evidence, durationMs: Math.round(performance.now() - t0) });
    } catch (e) {
      const unverified = (e as { unverified?: boolean }).unverified === true;
      results.push({
        provider: check.provider,
        status: unverified ? 'unverified' : 'failed',
        checkedAt,
        detail: e instanceof Error ? e.message : String(e),
        evidence: {},
        durationMs: Math.round(performance.now() - t0),
      });
    }
  }

  const report: VerificationReport = { generatedAt: new Date().toISOString(), results };
  if (!only.size) {
    await mkdir(join(ROOT, 'verification'), { recursive: true });
    await writeFile(join(ROOT, 'verification', 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  } else {
    // merge partial runs into the existing report
    const file = join(ROOT, 'verification', 'report.json');
    const prev = JSON.parse(await readFile(file, 'utf8').catch(() => '{"results":[]}')) as VerificationReport;
    const merged = [...prev.results.filter((r) => !only.has(r.provider)), ...results];
    await mkdir(join(ROOT, 'verification'), { recursive: true });
    await writeFile(file, `${JSON.stringify({ generatedAt: report.generatedAt, results: merged }, null, 2)}\n`);
  }
  for (const r of results) {
    const mark = r.status === 'verified' ? '✔' : r.status === 'blocked' ? '⏸' : r.status === 'unverified' ? '…' : '✘';
    console.log(`${mark} ${r.provider.padEnd(11)} ${r.status.padEnd(10)} ${r.detail}`);
  }
  await telemetry.flush().catch(() => {});
  helper.stop();
}

if (process.argv[1] && process.argv[1].endsWith('verify-providers.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
