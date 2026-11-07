/**
 * Demo harness.
 *
 *   pnpm demo --prepare [--root DIR]   create the demo folder (default ~/CommandOS-Demo)
 *   pnpm demo --run [--root DIR] [--yes]   run the six workflows headlessly, recording evidence
 *
 * Workflows that need missing credentials are reported as blocked, never faked.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve } from 'node:path';
import type { RouteDecision } from '@commandos/contracts';
import { CommandRuntime, webFormPlan } from '@commandos/runtime';
import { findHelperBinary } from '@commandos/tools';
import { populateScreenshotInbox } from './gen-fixtures';
import { DEMO_ROOT, loadLocalEnv, ROOT } from './lib/env';

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const root = rootIdx >= 0 && argv[rootIdx + 1] ? resolve(argv[rootIdx + 1] as string) : DEMO_ROOT;
const onlyIdx = argv.indexOf('--only');
const only = new Set(onlyIdx < 0 ? [] : (argv[onlyIdx + 1] ?? '').toUpperCase().split(',').filter((id) => /^W[1-6]$/.test(id)));
const MARKER = '.commandos-demo';

async function prepare(): Promise<void> {
  if (existsSync(root) && !existsSync(join(root, MARKER))) {
    throw new Error(`${root} exists and was not created by CommandOS; refusing to modify it (use --root)`);
  }
  await rm(join(root, 'calc-lib'), { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, MARKER), 'Created by `pnpm demo --prepare`. Safe to delete.\n');
  await populateScreenshotInbox(join(root, 'Screenshots'), { clean: true });
  await populateScreenshotInbox(join(root, 'Inbox2'), { clean: true, now: Date.now() - 3 * 86_400_000 });
  await rm(join(root, 'Docs'), { recursive: true, force: true });
  await cp(join(ROOT, 'fixtures', 'fs', 'docs'), join(root, 'Docs'), { recursive: true });
  await cp(join(ROOT, 'fixtures', 'repos', 'calc-lib'), join(root, 'calc-lib'), { recursive: true });
  console.log(`Demo folder ready: ${root}
  Screenshots/  8 screenshots (newest first)
  Inbox2/       8 older screenshots for “do the same for …”
  Docs/         PDF, DOCX, RTF and Markdown documents
  calc-lib/     Node repo with 3 failing tests (2 bugs)
See docs/demo-scenario.md for the script.`);
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

interface Evidence {
  workflow: string;
  status: 'succeeded' | 'failed' | 'partial' | 'blocked' | string;
  detail: string;
  runId?: string;
  traceId?: string;
  metrics?: unknown;
  checks?: string[];
}

async function run(): Promise<void> {
  loadLocalEnv();
  if (!existsSync(join(root, MARKER))) await prepare();
  const rt = await CommandRuntime.create({
    dataDir: join(root, '.data'),
    helperPath: findHelperBinary(ROOT),
    revealResults: false,
    settingsOverride: { allowedRoots: [root], screenshotRoots: [join(root, 'Screenshots')] },
    verificationReportPath: join(ROOT, 'verification', 'report.json'),
  });
  if (argv.includes('--yes')) {
    rt.on('run', (e) => {
      if (e.type === 'approval_requested') {
        console.log(`  ✓ auto-approving: ${e.approval.title} — ${e.approval.preview.summary}`);
        rt.respondApproval(e.approval.id, 'approve');
      }
    });
  } else {
    rt.on('run', (e) => {
      if (e.type === 'approval_requested') {
        console.log(`  ✗ denying (pass --yes to approve): ${e.approval.title}`);
        rt.respondApproval(e.approval.id, 'deny');
      }
    });
  }
  const evidence: Evidence[] = [];
  const has = async (...keys: Parameters<typeof rt.credentials.get>[0][]) => {
    for (const k of keys) if (!(await rt.credentials.get(k))) return k;
    return null;
  };
  const exec = async (workflow: string, command: string, needs: Parameters<typeof rt.credentials.get>[0][], override?: Parameters<typeof rt.submit>[4]) => {
    if (only.size && !only.has(workflow.split(' ')[0] as string)) return null;
    const missing = await has(...needs);
    if (missing) {
      evidence.push({ workflow, status: 'blocked', detail: `missing ${missing}` });
      console.log(`⏸ ${workflow}: blocked (missing ${missing})`);
      return null;
    }
    console.log(`▶ ${workflow}: ${command}`);
    const runId = await rt.submit(command, 'replay', false, null, override ?? null);
    const s = await rt.waitForRun(runId);
    const m = await rt.runMetrics(runId);
    const snapshot = await rt.getRun(runId);
    const problems = snapshot.events.flatMap((e) => e.type === 'log' && e.level === 'warn' && /^memory:|^cleanup:.*failed/.test(e.message) ? [e.message] : []);
    if (workflow.startsWith('W4') && !snapshot.events.some((e) => e.type === 'route' && e.decision.via === 'procedure')) problems.push('No verified procedure was replayed');
    if (!m.verifiedSuccess) problems.push('The run did not reach verified success');
    const status = problems.length ? 'failed' : s.state;
    const detail = [s.summary ?? '', ...problems].join(' ');
    evidence.push({ workflow, status, detail, runId, ...(s.traceId ? { traceId: s.traceId } : {}), metrics: m });
    console.log(`  ${status}: ${detail}  [first action ${m.timeToFirstActionMs?.toFixed(0) ?? '-'} ms, ${m.modelCalls} model calls${s.traceId ? `, trace ${s.traceId}` : ''}]`);
    return runId;
  };
  try {
    const w1 = await exec('W1 organize screenshots', `Find my five latest screenshots in ${join(root, 'Screenshots')}, sort them into categories, put them in a folder called Sorted and write a report`, ['OPENAI_API_KEY']);
    if (!w1) await exec('W1 organize screenshots (no renaming)', `Move my 5 latest screenshots from ${join(root, 'Screenshots')} into a folder called Sorted and write a report`, []);
    await exec('W4 replay procedure', `Do the same for ${join(root, 'Inbox2')}`, ['SPECTRON_URL', 'SPECTRON_CONTEXT_ID', 'SPECTRON_API_KEY']);
    await exec('W2 repo test and fix', `Run the tests in ${join(root, 'calc-lib')} and fix the failures`, ['DAYTONA_API_KEY', 'OPENAI_API_KEY']);
    // without an Anchor key the runtime drives local Chromium instead; the label says which ran
    const anchor = Boolean(await rt.credentials.get('ANCHORBROWSER_API_KEY'));
    await exec(
      `W3 web form (${anchor ? 'Anchor cloud browser' : 'local Chromium: ANCHORBROWSER_API_KEY not set'})`,
      'Open the Northwind partner portal and fill a draft purchase request for Rivera Labs, ops@rivera.example, 40 units of the cheapest in-stock product. Do not submit it.',
      ['OPENAI_API_KEY'],
    );
    // W6 runs offline against the local fixture site so it is always reproducible
    const site = await serve(join(ROOT, 'fixtures', 'site'));
    try {
      await exec('W6 failure + recovery (layout B)', 'Fill the draft purchase request on the redesigned layout B', [], async (executor) => {
        executor.addPlan(
          webFormPlan({ baseUrl: site.base, provider: 'local', headless: true, company: 'Rivera Labs', email: 'ops@rivera.example', quantity: 40, neededBy: null, notes: null, sku: null, criteria: 'cheapest in stock', variant: 'b' }),
        );
        executor.seal();
        return { mode: 'fast', intent: 'web_research_form', confidence: 1, via: 'procedure', reason: 'demo plan', slots: {}, needsFullPreview: false } satisfies RouteDecision;
      });
    } finally {
      site.server.close();
    }
    await exec(
      'W5 parallel DAG',
      `In parallel: summarize the documents in ${join(root, 'Docs')} into a report called docs-summary.md in that folder, find my three latest screenshots in ${join(root, 'Screenshots')}, and list what is in ${join(root, 'Inbox2')}`,
      ['OPENAI_API_KEY'],
    );
  } finally {
    await rt.shutdown();
  }
  await mkdir(join(ROOT, 'verification'), { recursive: true });
  const file = only.size ? `demo-run-${[...only].sort().join('-')}.json` : 'demo-run.json';
  await writeFile(join(ROOT, 'verification', file), `${JSON.stringify({ generatedAt: new Date().toISOString(), root, evidence }, null, 2)}\n`);
  console.log(`\nEvidence written to verification/${file}`);
  if (evidence.some((e) => e.status === 'failed' || e.status === 'partial')) process.exitCode = 1;
}

(async () => {
  if (argv.includes('--prepare')) await prepare();
  else if (argv.includes('--run')) await run();
  else console.log('usage: pnpm demo --prepare | --run [--yes] [--root DIR]');
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
