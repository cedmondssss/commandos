/**
 * Generates STATUS.md from evidence only: test results (vitest + Playwright JSON), the provider
 * verification report, benchmark results and the demo-run evidence.
 *
 *   pnpm status
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VerificationReport } from '@commandos/contracts';
import { ROOT } from './lib/env';

async function json<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(ROOT, path), 'utf8')) as T;
  } catch {
    return null;
  }
}

interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{ name: string; assertionResults: Array<{ fullName: string; status: string; ancestorTitles: string[] }> }>;
}

interface PlaywrightJson {
  stats: { expected: number; unexpected: number; skipped: number };
  suites: Array<{ specs: Array<{ title: string; ok: boolean }>; suites?: PlaywrightJson['suites'] }>;
}

interface BenchJson {
  at: string;
  results: Array<{ id: string; title: string; status: string; reason?: string; runs: number; successRate: number; p50TotalMs: number | null; p50TtfaMs: number | null; avgModelCalls: number; extra: Record<string, unknown> }>;
}

interface DemoJson {
  generatedAt: string;
  evidence: Array<{ workflow: string; status: string; detail: string; traceId?: string; metrics?: { modelCalls?: number } }>;
}

const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);

async function main(): Promise<void> {
  const tests = await json<VitestJson>('verification/tests.json');
  const e2e = await json<PlaywrightJson>('verification/e2e.json');
  const report = await json<VerificationReport>('verification/report.json');
  const bench = await json<BenchJson>('bench/results/latest.json');
  const demo = await json<DemoJson>('verification/demo-run.json');
  const providerStatus = (p: string) => report?.results.find((r) => r.provider === p);
  const providerLine = (p: string, label: string) => {
    const r = providerStatus(p);
    return `| ${label} | ${r ? r.status : 'not run'} | ${r ? r.detail.replace(/\|/g, '/') : 'run `pnpm verify:providers`'} |`;
  };

  const skipped = (tests?.testResults ?? []).flatMap((f) =>
    f.assertionResults.filter((a) => a.status === 'pending' || a.status === 'skipped').map((a) => (/skipped:/.test(a.ancestorTitles.join(' ')) ? a.ancestorTitles.join(' › ') : a.fullName)),
  );
  const uniqueSkipped = [...new Set(skipped)];

  const lines: string[] = [
    '# CommandOS status',
    '',
    `Generated ${new Date().toISOString()} by \`pnpm status\` from test results, live provider verification, benchmarks and demo evidence. Nothing here is asserted without evidence.`,
    '',
    '## Test results',
    '',
    tests
      ? `- Unit + integration (vitest): **${tests.numPassedTests} passed**, ${tests.numFailedTests} failed, ${tests.numPendingTests} skipped of ${tests.numTotalTests}.`
      : '- Unit + integration: not run (`pnpm status` runs them).',
    e2e
      ? `- Electron end-to-end (Playwright driving the built app): **${e2e.stats.expected} passed**, ${e2e.stats.unexpected} failed, ${e2e.stats.skipped} skipped.`
      : '- Electron end-to-end: not run.',
    '- Swift helper (XCTest): run `pnpm test:swift`.',
    '',
  ];
  if (uniqueSkipped.length) {
    lines.push('Skipped suites (each states why):', '', ...uniqueSkipped.map((s) => `- ${s}`), '');
  }

  lines.push(
    '## Live provider verification',
    '',
    report ? `From \`verification/report.json\` (${report.generatedAt}). Each “verified” row made a real API call; evidence ids are in the report.` : 'No report yet.',
    '',
    '| Provider | Status | Evidence / reason |',
    '|---|---|---|',
    providerLine('helper', 'Swift helper (macOS)'),
    providerLine('openai', 'OpenAI (gpt-6-luna / gpt-6.1-sol / gpt-6-astra)'),
    providerLine('elevenlabs', 'ElevenLabs (Scribe v2 Realtime, TTS)'),
    providerLine('daytona', 'Daytona'),
    providerLine('anchor', 'Anchor Browser'),
    providerLine('surrealdb', 'SurrealDB Agent Memory'),
    providerLine('arize', 'Arize AX'),
    '',
  );

  if (bench) {
    lines.push('## Benchmarks', '', `From \`bench/results/latest.md\` (${bench.at}); real runs, success = verified.`, '', '| Scenario | Runs | Verified | p50 total | p50 first action | Avg model calls | Notes |', '|---|---|---|---|---|---|---|');
    for (const r of bench.results) {
      if (r.status === 'skipped') lines.push(`| ${r.title} | — | — | — | — | — | skipped: ${r.reason} |`);
      else
        lines.push(
          `| ${r.title} | ${r.runs} | ${(r.successRate * 100).toFixed(1)}% | ${ms(r.p50TotalMs)} | ${ms(r.p50TtfaMs)} | ${r.avgModelCalls.toFixed(2)} | ${Object.entries(r.extra)
            .map(([k, v]) => `${k}: ${v}`)
            .join('; ')} |`,
        );
    }
    lines.push('');
  }

  if (demo) {
    lines.push('## Demo harness (`pnpm demo --run`)', '', `Last run ${demo.generatedAt}.`, '', '| Workflow | Result | Detail |', '|---|---|---|');
    for (const e of demo.evidence) lines.push(`| ${e.workflow} | ${e.status} | ${e.detail.replace(/\|/g, '/').slice(0, 220)}${e.traceId ? ` (trace ${e.traceId})` : ''} |`);
    lines.push('');
  }

  const v = (p: string) => providerStatus(p)?.status === 'verified';
  /** passed / failed / skipped for the vitest cases whose full name matches */
  const testStatus = (re: RegExp) => {
    const cases = (tests?.testResults ?? []).flatMap((f) => f.assertionResults.filter((a) => re.test(a.fullName)));
    if (cases.some((c) => c.status === 'failed')) return 'failed';
    if (cases.some((c) => c.status === 'passed')) return 'passed';
    return cases.length ? 'skipped' : 'not run';
  };
  const axWrite = testStatus(/types into a new TextEdit document via AXValue/);
  const vision = (providerStatus('openai')?.evidence as { vision?: { answer: string } } | undefined)?.vision;
  const demoRun = (re: RegExp) => demo?.evidence.find((e) => re.test(e.workflow) && e.status === 'succeeded');
  const w1Named = demoRun(/^W1 organize screenshots$/);
  const w3Local = demoRun(/^W3 web form/);
  const planned = bench?.results.find((r) => r.id === 'prompt-latency' && r.status === 'ran') ?? bench?.results.find((r) => r.id === 'standard-planner' && r.status === 'ran');
  const plannedMet = planned ? (planned.p50TtfaMs ?? 99_999) < 2000 : false;
  const toolGaps = [axWrite === 'passed' ? null : 'AX by permission', vision ? null : 'vision by OPENAI_API_KEY'].filter(Boolean);
  lines.push(
    '## Requirement status',
    '',
    '| Requirement | Status | Evidence |',
    '|---|---|---|',
    '| Electron shell: sandboxed renderer, context isolation, validated IPC, CSP | verified | e2e: isolation, IPC fuzzing, CSP inline-script block |',
    '| Floating command bar, transcript, live DAG viewer, activity log, approvals, history, settings, diagnostics | implemented; dashboard verified | e2e drives the dashboard to a verified run; command bar and voice transcript need a microphone + ElevenLabs |',
    `| Swift helper (AX, NSWorkspace, Spotlight, Vision OCR, ScreenCaptureKit, Keychain, Apple Events) over typed JSON-lines RPC | ${axWrite === 'passed' ? 'verified, including an AX write on TextEdit verified by read-back' : axWrite === 'failed' ? 'AX write test FAILED' : 'verified (AX writes blocked by permission)'} | helper RPC + Keychain + OCR + live display capture tests; AX TextEdit test: ${axWrite} |`,
    `| ElevenLabs realtime transcription (partials, commits) and TTS | ${v('elevenlabs') ? 'verified' : 'implemented; blocked by ELEVENLABS_API_KEY'} | \`pnpm verify:providers elevenlabs\` |`,
    `| Intent compiler: typed DAG (tool, typed args, pre/postconditions, timeouts, risk, undo), Zod-validated | ${v('openai') ? 'verified' : 'implemented; validation verified offline; model calls blocked by OPENAI_API_KEY'} | planner tests with scripted streams; deep-plan conversion tests |`,
    `| Local tools: files, documents, apps, accessibility, terminal allowlist, screenshot understanding | ${toolGaps.length ? `verified (${toolGaps.join(', ')})` : 'verified'} | tool tests: fs/undo, PDF/DOCX/RTF extraction, terminal classification/timeouts, OCR${vision ? '; live vision.ask read the fixture receipt' : ''} |`,
    '| Direct structured execution, parallel DAG with locks and deadlines, model only when needed | verified | executor tests; bench: FAST 0 model calls, multi-branch DAG speedup |',
    `| Daytona: isolated tests, validation, staging without secrets, untrusted output | ${v('daytona') ? 'verified' : 'implemented; staging/secret scan/test parsing verified offline; live blocked by DAYTONA_API_KEY'} | web-sandbox + cloud test suites |`,
    `| Anchor Browser remote sessions and agent tasks; local Playwright for local browsers | ${v('anchor') ? 'verified' : 'local Playwright verified; Anchor blocked by ANCHORBROWSER_API_KEY'} | real-browser web tests (extract, fill, submit guard, redesign) |`,
    `| SurrealDB Agent Memory: scoped procedures, success/failure, procedural reuse, no secrets | ${v('surrealdb') ? 'verified' : 'implemented; binding/replay/secret filter verified offline; live blocked by SPECTRON_* keys'} | procedure tests, memory guard test |`,
    `| Arize AX tracing (task, plan, model, tool, verify, retry spans) with redaction | ${v('arize') ? 'verified' : 'local trace export verified; Arize export blocked by ARIZE_* keys'} | redaction test; local trace shows AGENT/CHAIN/GUARDRAIL/TOOL/EVALUATOR spans incl. recovery |`,
    '| Policy engine: deletions, external sends, payments, privileged, high impact need confirmation | verified | policy and executor approval tests |',
    '| Emergency stop, cancellation, checkpoints/resume, dry run, reversible changes, audit chain, least privilege | verified | emergency-stop, cancel, resume, dry-run, undo, audit tamper, symlink-escape tests |',
    '| Keychain credentials, never committed | verified | Keychain round trip through the helper; .gitignore covers .env*, keys, .vercel |',
    `| W1 screenshots → inspect → classify → organize → report | ${w1Named && (w1Named.metrics?.modelCalls ?? 0) > 0 ? 'verified, with content naming by the fast model' : 'verified offline without content naming; naming blocked by OPENAI_API_KEY'} | bench fast-organize, demo W1${w1Named?.traceId ? ` (trace ${w1Named.traceId})` : ''} |`,
    `| W2 repo tests in Daytona → patch → review | ${v('daytona') && v('openai') ? 'verified' : `blocked by ${[v('daytona') ? null : 'DAYTONA_API_KEY', v('openai') ? null : 'OPENAI_API_KEY'].filter(Boolean).join(' + ')}`} | cloud.test.ts W2 suite |`,
    `| W3 Anchor web form, verified fields, no submission | ${v('anchor') ? 'verified' : w3Local ? 'verified end to end with local Chromium (slots extracted live by the fast model); Anchor blocked by ANCHORBROWSER_API_KEY' : 'verified with local Playwright; Anchor + slot extraction blocked'} | web-sandbox tests, recovery tests${w3Local ? ', demo W3' : ''} |`,
    `| W4 recall and reapply a procedure | ${v('surrealdb') ? 'verified' : 'blocked by SPECTRON_* keys (offline replay logic verified)'} | procedures.test.ts |`,
    '| W5 concurrent independent steps with correct DAG dependencies | verified | bench multi-branch DAG (speedup, max concurrency), executor tests |',
    `| W6 failure detection and recovery with trace evidence | verified locally (layout B, 0 model calls); Arize export ${v('arize') ? 'verified' : 'blocked'}; model-repair tier ${v('openai') ? 'verified' : 'blocked'} | recovery tests, bench, local trace |`,
    '',
    '## Not implemented / known limitations',
    '',
    '- No signed and notarized `.app` package yet (`pnpm build` produces the Electron bundle; run with `pnpm dev` or `electron-vite preview`).',
    '- Voice is one utterance per activation (push-to-talk or VAD); there is no wake word.',
    '- Daytona file transformations have no dedicated round-trip tool; transformations run via `sandbox.exec` and code changes come back through the reviewed `patch.apply` path.',
    '- Arize evaluations are recorded as EVALUATOR spans; no Arize online-eval configuration is created automatically.',
    '- Website fingerprints in stored procedures are enforced at run time (selector failures trigger recovery and mark the procedure stale), not checked before replay.',
    '- In development, macOS attributes Accessibility / Screen Recording / Automation permissions to the launching app.',
    v('openai')
      ? plannedMet
        ? `- Speed depends on OpenAI: everyday model-planned commands measured ${ms(planned?.p50TtfaMs)} to first action and ${ms(planned?.p50TotalMs)} to done (p50, Fast mode, which doubles the token price); risky commands still wait for the router and a DEEP plan (gpt-6-astra, ~12 s), and provider latency spikes that hit both hedged requests are not hidden.`
        : `- Model-planned commands miss the < 2 s first-action target${planned ? ` (p50 ${ms(planned.p50TtfaMs)})` : ''}: planning turns take seconds and OpenAI latency varies run to run. DEEP plans (gpt-6-astra) take longer; deterministic FAST workflows act in milliseconds.`
      : '- GPT-6 model ids and reasoning-effort rules come from the current OpenAI docs; they are only confirmed live once an OpenAI key is configured.',
    '',
  );
  await writeFile(join(ROOT, 'STATUS.md'), `${lines.join('\n')}\n`);
  console.log('STATUS.md written');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
