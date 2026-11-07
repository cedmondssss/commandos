import {
  type PushChannel,
  RuntimeApi,
  RuntimeInboundSchema,
  type RuntimeMethod,
  type RuntimeOutbound,
} from '@commandos/contracts';
import { CommandRuntime } from '@commandos/runtime';
import { config as loadDotenv } from 'dotenv';
import type { z } from 'zod';

// Runs inside an Electron utilityProcess. Holds credentials and executes commands; talks to the
// main process only through validated messages.

for (const file of (process.env.COMMANDOS_DOTENV ?? '').split(',').filter(Boolean)) loadDotenv({ path: file, quiet: true });

const port = process.parentPort;
const post = (msg: RuntimeOutbound) => port.postMessage(msg);
const push = (channel: PushChannel, payload: unknown) => post({ kind: 'push', channel, payload });

const dataDir = process.env.COMMANDOS_DATA_DIR;
const helperPath = process.env.COMMANDOS_HELPER_PATH;
if (!dataDir || !helperPath) throw new Error('COMMANDOS_DATA_DIR and COMMANDOS_HELPER_PATH are required');

const rt = await CommandRuntime.create({
  dataDir,
  helperPath,
  verificationReportPath: process.env.COMMANDOS_VERIFICATION_REPORT,
  safetyReportFallbackPath: process.env.COMMANDOS_SAFETY_REPORT_FALLBACK,
  revealResults: process.env.COMMANDOS_REVEAL !== '0',
  log: (m) => console.log(m),
});

rt.on('run', (e) => push('run:event', e));
rt.on('voice', (e) => push('voice:event', e));
rt.on('status', (s) => push('app:status', s));

type Req<M extends RuntimeMethod> = z.output<(typeof RuntimeApi)[M]['req']>;
type Res<M extends RuntimeMethod> = z.input<(typeof RuntimeApi)[M]['res']>;
const handlers: { [M in RuntimeMethod]: (req: Req<M>) => Promise<Res<M>> } = {
  'safety.run': async () => rt.safetyLab.run(),
  'safety.report': async () => rt.safetyLab.report(),
  'safety.status': async () => ({ running: rt.safetyLab.running }),
  'safety.cancel': async () => ({ ok: rt.safetyLab.cancel() }),
  'command.submit': async ({ text, source, dryRun }) => ({ runId: await rt.submit(text, source, dryRun) }),
  'run.cancel': async ({ runId }) => ({ ok: rt.cancel(runId) }),
  'run.undo': async ({ runId }) => rt.undo(runId),
  'run.resume': async ({ runId }) => ({ runId: await rt.resume(runId) }),
  'run.get': async ({ runId }) => rt.getRun(runId),
  'run.image': async ({ runId, taskId }) => rt.runImage(runId, taskId),
  'browser.preview': async ({ runId, sessionId }) => rt.browserPreview(runId, sessionId),
  'run.metrics': async ({ runId }) => rt.runMetrics(runId),
  'runs.list': async () => ({ runs: await rt.listRuns() }),
  'approval.respond': async ({ approvalId, decision }) => ({ ok: rt.respondApproval(approvalId, decision) }),
  'emergency.stop': async () => {
    await rt.emergencyStop();
    return { ok: true };
  },
  'voice.start': async () => {
    await rt.voiceStart();
    return { ok: true };
  },
  'voice.stop': async ({ commit }) => {
    rt.voiceStop(commit);
    return { ok: true };
  },
  'settings.get': async () => rt.settings,
  'settings.update': async (patch) => rt.updateSettings(patch),
  'credentials.status': async () => ({ credentials: await rt.credentialStatus() }),
  'credentials.set': async ({ key, value }) => {
    await rt.setCredential(key, value);
    return { ok: true };
  },
  'credentials.delete': async ({ key }) => {
    await rt.deleteCredential(key);
    return { ok: true };
  },
  'permissions.status': async () => ({ status: await rt.permissions(), helper: rt.helper.status() }),
  'permissions.request': async ({ kind }) => ({ status: await rt.requestPermission(kind) }),
  'diagnostics.get': async () => rt.diagnostics(),
  'tools.list': async () => ({ tools: rt.toolDescriptors() }),
};

port.on('message', (event: { data: unknown }) => {
  const parsed = RuntimeInboundSchema.safeParse(event.data);
  if (!parsed.success) return;
  const msg = parsed.data;
  if (msg.kind === 'audio') {
    rt.pushAudio(msg.data);
    return;
  }
  if (msg.kind === 'shutdown') {
    void rt.shutdown().finally(() => process.exit(0));
    return;
  }
  const method = msg.method as RuntimeMethod;
  const spec = RuntimeApi[method];
  if (!spec) {
    post({ kind: 'error', id: msg.id, error: { code: 'unknown_method', message: `unknown method ${msg.method}` } });
    return;
  }
  const req = spec.req.safeParse(msg.params ?? {});
  if (!req.success) {
    post({ kind: 'error', id: msg.id, error: { code: 'bad_request', message: req.error.message } });
    return;
  }
  const handler = handlers[method] as (r: unknown) => Promise<unknown>;
  handler(req.data).then(
    (result) => post({ kind: 'response', id: msg.id, result }),
    (e: unknown) =>
      post({
        kind: 'error',
        id: msg.id,
        error: { code: (e as { code?: string }).code ?? 'error', message: e instanceof Error ? e.message : String(e) },
      }),
  );
});

post({ kind: 'ready' });
