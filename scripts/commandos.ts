/**
 * Headless CommandOS: runs a command through the same runtime the desktop app uses.
 *
 *   pnpm cmd "find my five latest screenshots, rename them by content and put them in a folder"
 *   pnpm cmd --demo --approve=yes "…"      # restrict to ~/CommandOS-Demo, auto-approve prompts
 *   pnpm cmd --dry-run "…"                 # plan + read-only steps, preview changes
 *   pnpm cmd runs | undo <runId|last> | metrics <runId|last> | audit
 */
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { RunEvent } from '@commandos/contracts';
import { AuditLog, CommandRuntime } from '@commandos/runtime';
import { findHelperBinary } from '@commandos/tools';
import { CLI_DATA_DIR, DEMO_ROOT, loadLocalEnv, ROOT } from './lib/env';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const positional = argv.filter((a) => !a.startsWith('--'));
const approveMode = (flag('approve') ?? (process.stdin.isTTY ? 'ask' : 'no')) as 'ask' | 'yes' | 'no';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function print(e: RunEvent, t0: number): void {
  const t = c.dim(`+${((e.at - t0) / 1000).toFixed(2)}s`.padStart(8));
  switch (e.type) {
    case 'route':
      console.log(`${t} ${c.cyan('route')} ${e.decision.mode.toUpperCase()} · ${e.decision.intent} via ${e.decision.via} (${Math.round(e.latencyMs)} ms)`);
      break;
    case 'task_added':
      console.log(`${t} ${c.dim('plan ')} ${e.task.id} ← ${e.task.tool}${e.task.dependsOn.length ? c.dim(` after ${e.task.dependsOn.join(', ')}`) : ''}`);
      break;
    case 'task_state':
      if (['running', 'succeeded', 'failed', 'denied', 'skipped', 'awaiting_approval', 'cancelled'].includes(e.state)) {
        const color = e.state === 'succeeded' ? c.green : e.state === 'failed' || e.state === 'denied' ? c.red : e.state === 'awaiting_approval' ? c.yellow : (s: string) => s;
        console.log(`${t} ${color(e.state.padEnd(9))} ${e.taskId}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}${e.error ? c.red(` — ${e.error}`) : e.detail ? c.dim(` — ${e.detail}`) : ''}`);
      }
      break;
    case 'verification':
      console.log(`${t} ${e.ok ? c.green('verify  ') : c.red('verify  ')} ${e.taskId}: ${e.checks.filter((x) => x.ok).length}/${e.checks.length} checks`);
      break;
    case 'model_call':
      console.log(`${t} ${c.dim('model ')} ${e.call.model} (${e.call.effort}) ${e.call.purpose} ${Math.round(e.call.latencyMs)} ms${e.call.ok ? '' : c.red(` ${e.call.error}`)}`);
      break;
    case 'narration':
      console.log(`${t} ${c.dim(`· ${e.text}`)}`);
      break;
    case 'run_state':
      if (e.summary) console.log(`${t} ${c.bold(e.state)} ${e.summary}`);
      break;
    case 'log':
      if (e.level !== 'debug') console.log(`${t} ${e.level === 'error' ? c.red(e.message) : c.dim(e.message)}`);
      break;
    default:
      break;
  }
}

async function main(): Promise<void> {
  const envLoaded = loadLocalEnv();
  const demo = flags.has('--demo');
  const rt = await CommandRuntime.create({
    dataDir: flag('data-dir') ?? CLI_DATA_DIR,
    helperPath: findHelperBinary(ROOT),
    revealResults: flags.has('--reveal'),
    verificationReportPath: join(ROOT, 'verification', 'report.json'),
    settingsOverride: demo
      ? { allowedRoots: [DEMO_ROOT], screenshotRoots: [join(DEMO_ROOT, 'Screenshots')] }
      : undefined,
    log: flags.has('--verbose') ? (m) => console.error(c.dim(m)) : undefined,
  });
  const [sub, arg] = positional;

  if (sub === 'runs') {
    for (const r of (await rt.listRuns()).slice(0, 20)) {
      console.log(`${r.runId}  ${r.state.padEnd(9)} ${r.mode ?? '-'}  ${r.command}`);
    }
  } else if (sub === 'undo' || sub === 'metrics') {
    const runs = await rt.listRuns();
    const id = arg === 'last' || !arg ? runs.find((r) => (sub === 'undo' ? r.undoable : true))?.runId : arg;
    if (!id) throw new Error('no matching run');
    console.log(JSON.stringify(sub === 'undo' ? await rt.undo(id) : await rt.runMetrics(id), null, 2));
  } else if (sub === 'audit') {
    console.log(JSON.stringify(await AuditLog.verify(rt.audit.file), null, 2));
  } else {
    const text = positional.join(' ').trim();
    if (!text) {
      console.error('usage: pnpm cmd [--demo] [--dry-run] [--approve=ask|yes|no] "<command>"');
      process.exitCode = 2;
      await rt.shutdown();
      return;
    }
    if (!envLoaded) console.error(c.dim('(no .env.local found; using Keychain/env credentials)'));
    let t0 = Date.now();
    const rl = approveMode === 'ask' ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    let runId = '';
    rt.on('run', (e) => {
      if (e.type === 'run_created') t0 = e.at;
      if (runId && e.runId !== runId) return;
      print(e, t0);
      if (e.type === 'approval_requested') {
        const a = e.approval;
        console.log(c.yellow(`  ? ${a.title} — ${a.preview.summary}`));
        for (const r of a.reasons) console.log(c.yellow(`    · ${r}`));
        if (a.irreversible) console.log(c.red('    · this cannot be undone'));
        if (approveMode === 'yes') rt.respondApproval(a.id, 'approve');
        else if (approveMode === 'no') rt.respondApproval(a.id, 'deny');
        else
          void rl?.question('    approve? [y/N] ').then((ans) => {
            rt.respondApproval(a.id, /^y(es)?$/i.test(ans.trim()) ? 'approve' : 'deny');
          });
      }
    });
    runId = await rt.submit(text, 'text', flags.has('--dry-run'));
    const summary = await rt.waitForRun(runId);
    rl?.close();
    const m = await rt.runMetrics(runId);
    console.log(
      c.dim(
        `run ${runId} · first action ${m.timeToFirstActionMs?.toFixed(0) ?? '-'} ms · total ${m.totalMs?.toFixed(0) ?? '-'} ms · model calls ${m.modelCalls} · verified ${m.verifiedSuccess}`,
      ),
    );
    if (flags.has('--json')) console.log(JSON.stringify({ summary, metrics: m }, null, 2));
    process.exitCode = summary.state === 'succeeded' ? 0 : 1;
  }
  await rt.shutdown();
}

main().catch((e) => {
  console.error(c.red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
