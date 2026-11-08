import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  type AppStatus,
  type ApprovalDecision,
  type CommandSource,
  type CredentialKey,
  type CredentialStatus,
  type Diagnostics,
  KEYCHAIN_SERVICE,
  IdSchema,
  type PermissionStatus,
  type RouteDecision,
  type RunEvent,
  RunEventSchema,
  type RunMetrics,
  type RunSnapshot,
  type RunState,
  type RunSummary,
  type Settings,
  type SettingsPatch,
  TaskSpecSchema,
  TERMINAL_RUN_STATES,
  type ToolDescriptor,
  type UndoReport,
  type VerificationReport,
  VerificationReportSchema,
  type VoiceEvent,
} from '@commandos/contracts';
import {
  BrowserHub,
  type CommitMetrics,
  CredentialResolver,
  FileCredentialBackend,
  MissingCredentialError,
  ProcedureMemory,
  ProcedureSourceSchema,
  type ProcedureSource,
  type RecalledProcedure,
  SandboxService,
  spanJson,
  getTelemetry,
  initTelemetry,
  ModelGateway,
  OpenInferenceSpanKind,
  RealtimeTranscriber,
  type SecretBackend,
  SemanticConventions,
  speak,
  type Telemetry,
  withSpan,
} from '@commandos/providers';
import { createDefaultRegistry, displayPath, HelperClient, killAllProcesses, type ProviderAccess, type ToolRegistry } from '@commandos/tools';
import { ApprovalBroker } from './approvals';
import { SafetyLab } from './safety';
import { abortable } from './abort';
import { AuditLog } from './audit';
import { type ExecutorEvent, type ExecutorResult, RunExecutor, topoSort } from './executor';
import { UndoJournal, undoEntries } from './journal';
import { computeMetrics } from './metrics';
import { type ControlAction, isStandardRoute, type RouteResult, routeCommand, routeLocally } from './router';
import { CheckpointStore, RunStore, SettingsStore } from './stores';
import { runDeepPlanner } from './planner/deep';
import { type PlannerDeps, resolveAnswer, runStandardPlanner } from './planner/standard';
import { createRecovery } from './recovery';
import { bindDeterministic, bindWithModel, buildProcedure, checkFingerprint, fingerprintFor, instantiate } from './procedures';
import { emailPlan, organizeScreenshotsPlan, pageQuestionPlan, photoAttachmentPlan, quickPlan, repoTestFixPlan, webFormPlan } from './templates';

export interface RuntimeOptions {
  dataDir: string;
  helperPath: string;
  env?: NodeJS.ProcessEnv;
  /** store credentials in the macOS Keychain via the helper (default true) */
  useKeychain?: boolean;
  /** register the tracer provider (Arize when configured, local JSONL always) (default true) */
  telemetry?: boolean;
  /** reveal result folders in Finder (default true; tests/CLI turn it off) */
  revealResults?: boolean;
  settingsOverride?: SettingsPatch;
  /** path of the provider verification report shown in Diagnostics */
  verificationReportPath?: string;
  /** Development-only fallback report produced by `pnpm safety`. */
  safetyReportFallbackPath?: string;
  log?: (message: string) => void;
}

interface RuntimeEvents {
  run: [RunEvent];
  voice: [VoiceEvent];
  status: [AppStatus];
}

interface ActiveRun {
  runId: string;
  command: string;
  source: CommandSource;
  dryRun: boolean;
  createdAt: number;
  state: RunState;
  events: RunEvent[];
  unflushed: RunEvent[];
  flushTimer: NodeJS.Timeout | null;
  controller: AbortController;
  executor: RunExecutor | null;
  decision: RouteDecision | null;
  voiceMetrics: CommitMetrics | null;
  route: RouteResult | null;
  /** procedure from memory this run replays (FAST) */
  replayOf: RecalledProcedure | null;
  /** predefined planning (resume from checkpoint) that bypasses routing */
  planOverride: ((executor: RunExecutor) => Promise<RouteDecision>) | null;
  traceId: string | null;
  summary: string | null;
  finishedAt: number | null;
  journal: UndoJournal;
  dir: string;
  done: Promise<void>;
}

function newRunId(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return `run_${stamp}_${randomBytes(3).toString('hex')}`;
}

function keychainBackend(helper: HelperClient): SecretBackend {
  return {
    get: async (account) => (await helper.call('keychain.get', { service: KEYCHAIN_SERVICE, account })).value,
    set: async (account, value) => {
      await helper.call('keychain.set', { service: KEYCHAIN_SERVICE, account, value });
    },
    delete: async (account) => (await helper.call('keychain.delete', { service: KEYCHAIN_SERVICE, account })).deleted,
    list: async () => (await helper.call('keychain.list', { service: KEYCHAIN_SERVICE })).accounts,
  };
}

export function finalState(result: ExecutorResult, aborted: boolean, reason?: string, answer: PlannerAnswer | null = null): RunState {
  if (aborted) return reason === 'emergency stop' ? 'stopped' : 'cancelled';
  if (answer && answer.outcome !== 'done') return result.succeeded > 0 ? 'partial' : 'failed';
  if (result.tasks.length === 0) return 'failed';
  if (answer?.outcome === 'done' && result.tasks.every((task) => task.state === 'succeeded' || answer.resolvedTaskIds?.includes(task.spec.id))) return 'succeeded';
  if (result.failed + result.denied + result.skipped + result.cancelled === 0) return 'succeeded';
  return result.succeeded > 0 ? 'partial' : 'failed';
}

/** What the model planner concluded (STANDARD runs): an answer, or why it stopped. */
interface PlannerAnswer {
  outcome: string;
  summary: string;
  /** Set by deterministic final-state verification, never by a model finish call. */
  resolvedTaskIds?: string[];
}

export function summarize(result: ExecutorResult, dryRun: boolean, answer: PlannerAnswer | null = null): string {
  const total = result.tasks.length;
  if (!dryRun && answer?.outcome === 'done' && answer.resolvedTaskIds?.length && finalState(result, false, undefined, answer) === 'succeeded') {
    return `${answer.summary} Completed after recovery; earlier failed attempts remain in the trace.`;
  }
  const parts: string[] = [];
  // the planner's own words lead only when every step succeeded and verified (e.g. the answer to
  // a question); a stop or a request for input is always shown
  if (answer?.summary && answer.outcome === 'done' && !dryRun && result.succeeded === total) parts.push(answer.summary);
  else if (answer?.summary && answer.outcome === 'needs_user') parts.push(`Needs your input: ${answer.summary}`);
  else if (answer?.summary && answer.outcome === 'blocked') parts.push(`Planner stopped: ${answer.summary}`);
  const organize = result.tasks.find((t) => t.spec.tool === 'fs.organize' && t.state === 'succeeded');
  if (organize?.output && typeof organize.output === 'object') {
    const o = organize.output as { moved?: unknown[]; alreadyInPlace?: string[]; destinationDir?: string };
    const moved = o.moved?.length ?? 0;
    const already = o.alreadyInPlace?.length ?? 0;
    if (moved) parts.push(`Moved ${moved} file(s) into ${displayPath(o.destinationDir ?? '')}.`);
    if (already) parts.push(`${already} file(s) ${moved ? 'were' : 'are'} already in ${displayPath(o.destinationDir ?? '')}.${moved ? '' : ' No files needed moving.'}`);
  }
  const report = result.tasks.find((t) => t.spec.tool === 'report.write' && t.state === 'succeeded');
  if (report?.output && typeof report.output === 'object') {
    parts.push(`Report: ${displayPath((report.output as { markdownPath: string }).markdownPath)}.`);
  }
  if (dryRun) parts.push(`Dry run: ${result.succeeded} read-only step(s) ran, ${result.skipped} change(s) previewed.`);
  else if (result.succeeded === total && (!answer || answer.outcome === 'done')) parts.push(`All ${total} steps succeeded and were verified.`);
  else {
    parts.push(`${result.succeeded}/${total} steps succeeded.`);
    for (const t of result.tasks.filter((x) => x.state === 'failed' || x.state === 'denied')) {
      parts.push(`${t.spec.title ?? t.spec.tool} ${t.state}: ${t.error ?? 'unknown error'}`);
    }
  }
  return parts.join(' ');
}

/**
 * CommandOS runtime: routes commands, builds plans, executes them through the policy-gated
 * executor, keeps the audit log and undo journals, streams voice, and exposes everything the
 * desktop app and CLI need. Holds all credentials; nothing secret leaves this process except
 * to the provider it belongs to.
 */
export class CommandRuntime extends EventEmitter<RuntimeEvents> {
  readonly settingsStore: SettingsStore;
  readonly runStore: RunStore;
  readonly checkpoints: CheckpointStore;
  readonly audit: AuditLog;
  readonly helper: HelperClient;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly safetyLab: SafetyLab;
  credentials!: CredentialResolver;
  telemetry: Telemetry | null = null;
  private gateway: ModelGateway | null = null;
  private gatewayKey: string | null = null;
  private runs = new Map<string, ActiveRun>();
  private transcriber: RealtimeTranscriber | null = null;
  /** Invalidates microphone starts/late transcripts when Stop races with connection setup. */
  private voiceGeneration = 0;
  private readonly voiceSessions = new Set<RealtimeTranscriber>();
  private lastLevelAt = 0;
  private readonly providers: ProviderAccess;
  private readonly providerFactories = new Map<string, () => Promise<unknown>>();
  private readonly providerCache = new Map<string, Promise<unknown>>();
  private readonly log: (m: string) => void;

  private constructor(readonly opts: RuntimeOptions) {
    super();
    this.log = opts.log ?? (() => {});
    this.settingsStore = new SettingsStore(join(opts.dataDir, 'settings.json'));
    this.runStore = new RunStore(join(opts.dataDir, 'runs'));
    this.checkpoints = new CheckpointStore(join(opts.dataDir, 'runs'));
    this.audit = new AuditLog(join(opts.dataDir, 'audit', 'audit.jsonl'));
    this.helper = new HelperClient(opts.helperPath, { log: this.log });
    this.safetyLab = new SafetyLab(join(opts.dataDir, 'safety'), opts.safetyReportFallbackPath);
    this.registry = createDefaultRegistry();
    this.approvals = new ApprovalBroker({
      requested: (req) => {
        this.emitRun(req.runId, { type: 'approval_requested', approval: req });
        this.emitStatus();
      },
      resolved: (req, outcome) => {
        this.emitRun(req.runId, { type: 'approval_resolved', approvalId: req.id, decision: outcome.decision, by: outcome.by });
        this.emitStatus();
      },
    });
    this.providers = {
      get: async <T>(name: string): Promise<T> => {
        const factory = this.providerFactories.get(name);
        if (!factory) throw new Error(`provider "${name}" is not available in this build`);
        let p = this.providerCache.get(name);
        if (!p) {
          p = factory().catch((e) => {
            this.providerCache.delete(name);
            throw e;
          });
          this.providerCache.set(name, p);
        }
        return (await p) as T;
      },
    };
  }

  static async create(opts: RuntimeOptions): Promise<CommandRuntime> {
    const rt = new CommandRuntime(opts);
    await rt.init();
    return rt;
  }

  private async init(): Promise<void> {
    await mkdir(this.opts.dataDir, { recursive: true });
    await this.settingsStore.load();
    if (this.opts.settingsOverride) this.settingsStore.override(this.opts.settingsOverride);
    await this.audit.init();
    try {
      await this.helper.start();
    } catch (e) {
      this.log(`helper unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const privateStore = new FileCredentialBackend(join(this.opts.dataDir, 'credentials.json'));
    const hasPrivateStore = await privateStore.exists();
    if (hasPrivateStore) await privateStore.list(); // validate owner, permissions and format before use
    const backend = hasPrivateStore ? privateStore : this.opts.useKeychain !== false && this.helper.running ? keychainBackend(this.helper) : null;
    this.credentials = new CredentialResolver(backend, this.opts.env ?? process.env);
    if (this.opts.telemetry !== false && this.settings.telemetry.enabled) {
      const spaceId = await this.credentials.get('ARIZE_SPACE_ID');
      const apiKey = await this.credentials.get('ARIZE_API_KEY');
      const day = new Date().toISOString().slice(0, 10);
      this.telemetry =
        getTelemetry() ??
        initTelemetry({
          projectName: this.settings.telemetry.projectName,
          arize: spaceId && apiKey ? { spaceId, apiKey } : null,
          localTraceFile: join(this.opts.dataDir, 'traces', `spans-${day}.jsonl`),
        });
    }
    this.registerDefaultProviders();
    const interrupted = await this.markInterruptedRuns();
    await this.audit.append('runtime_started', 'system', { helper: this.helper.status(), arize: this.telemetry?.arizeEnabled ?? false, interruptedRuns: interrupted });
    this.emitStatus();
  }

  /** Runs that never wrote a summary were interrupted (crash, force quit): mark them stopped. */
  private async markInterruptedRuns(): Promise<number> {
    const { readdir } = await import('node:fs/promises');
    const dirs = await readdir(this.runStore.runsDir).catch(() => [] as string[]);
    let n = 0;
    for (const runId of dirs) {
      if (!runId.startsWith('run_') || (await this.runStore.readSummary(runId))) continue;
      const events = await this.runStore.readEvents(runId);
      const created = events.find((e) => e.type === 'run_created');
      if (!created || created.type !== 'run_created') continue;
      const states = new Map<string, string>();
      for (const e of events) if (e.type === 'task_state') states.set(e.taskId, e.state);
      const route = [...events].reverse().find((e) => e.type === 'route');
      await this.runStore.writeSummary({
        runId,
        command: created.command,
        source: created.source,
        state: 'stopped',
        dryRun: created.dryRun,
        createdAt: created.at,
        finishedAt: events.at(-1)?.at ?? created.at,
        ...(route && route.type === 'route' ? { mode: route.decision.mode, intent: route.decision.intent } : {}),
        taskCount: states.size,
        succeededCount: [...states.values()].filter((x) => x === 'succeeded').length,
        failedCount: [...states.values()].filter((x) => x === 'failed').length,
        modelCalls: events.filter((e) => e.type === 'model_call').length,
        undoable: (await UndoJournal.read(join(this.runStore.dirFor(runId), 'journal.jsonl'))).length > 0,
        summary: 'Interrupted: CommandOS stopped before this run finished. Completed steps were checkpointed; you can undo or resume it.',
      });
      await this.runStore.appendEvents(runId, [{ type: 'run_state', runId, at: Date.now(), state: 'stopped', summary: 'Interrupted before completion' }]);
      n++;
    }
    return n;
  }

  /**
   * Resumes a failed, partial, stopped or cancelled run as a new run: verified steps are restored
   * from their checkpoints (not re-executed); everything else runs again under full policy.
   */
  async resume(runId: string): Promise<string> {
    const live = this.runs.get(runId);
    if (live && !TERMINAL_RUN_STATES.has(live.state)) throw new Error('that run is still in progress');
    const snap = await this.getRun(runId);
    if (snap.summary.state === 'succeeded' || snap.summary.state === 'undone') throw new Error(`a ${snap.summary.state} run has nothing to resume`);
    const { specs, outputs } = await this.checkpoints.load(runId);
    if (!specs.length) throw new Error('this run has no checkpoint to resume from');
    const finalStates = new Map<string, string>();
    for (const e of snap.events) if (e.type === 'task_state') finalStates.set(e.taskId, e.state);
    const ordered = topoSort(specs.map((x) => TaskSpecSchema.parse(x)));
    return this.submit(`Resume: ${snap.summary.command}`, 'replay', false, null, async (executor) => {
      let restored = 0;
      for (const spec of ordered) {
        if (finalStates.get(spec.id) === 'succeeded' && outputs.has(spec.id)) {
          executor.restore(spec, outputs.get(spec.id), runId);
          restored++;
        } else executor.addTask(spec);
      }
      executor.seal();
      return {
        mode: 'fast',
        intent: snap.summary.intent ?? 'general',
        confidence: 1,
        via: 'procedure',
        reason: `resuming ${runId}: ${restored} verified step(s) restored from checkpoints, ${ordered.length - restored} to run`,
        slots: { resumedFrom: runId },
        needsFullPreview: false,
      };
    });
  }

  /** Cloud providers, created lazily from credentials; browser sessions close per run, Daytona sandboxes persist. */
  private registerDefaultProviders(): void {
    this.registerProvider('daytona', async () => {
      const apiKey = await this.credentials.get('DAYTONA_API_KEY');
      if (!apiKey) throw new MissingCredentialError(['DAYTONA_API_KEY']);
      const apiUrl = await this.credentials.get('DAYTONA_API_URL');
      const target = await this.credentials.get('DAYTONA_TARGET');
      return new SandboxService({ apiKey, ...(apiUrl ? { apiUrl } : {}), ...(target ? { target } : {}) });
    });
    this.registerProvider('browser', async () => new BrowserHub(() => this.credentials.get('ANCHORBROWSER_API_KEY')));
    this.registerProvider('memory', async () => {
      const { SPECTRON_URL, SPECTRON_CONTEXT_ID, SPECTRON_API_KEY } = await this.credentials.require('SPECTRON_URL', 'SPECTRON_CONTEXT_ID', 'SPECTRON_API_KEY');
      return new ProcedureMemory({ endpoint: SPECTRON_URL as string, context: SPECTRON_CONTEXT_ID as string, apiKey: SPECTRON_API_KEY as string });
    });
    this.onEmergencyStop(async () => {
      await this.cleanupProviders();
    });
  }

  /** Retains Daytona sandboxes for inspection and closes browser sessions (for one run, or all). */
  async cleanupProviders(runId?: string): Promise<{ sandboxes: number; browsers: number }> {
    const out = { sandboxes: 0, browsers: 0 };
    const failed = (provider: string, e: unknown) => {
      const message = `cleanup: ${provider} failed: ${e instanceof Error ? e.message : String(e)}`;
      if (runId) this.emitRun(runId, { type: 'log', level: 'warn', message, data: { activity: 'cleanup_failed', provider: provider === 'browser' ? 'browser' : 'daytona' } });
      else this.log(message);
      return 0;
    };
    const daytona = this.providerCache.get('daytona');
    if (daytona) out.sandboxes = await daytona.then((d) => (d as SandboxService).activeIds(runId)).then((ids) => ids.length);
    const browser = this.providerCache.get('browser');
    if (browser) out.browsers = await browser.then((b) => (b as BrowserHub).closeAll(runId)).catch((e) => failed('browser', e));
    return out;
  }

  get settings(): Settings {
    return this.settingsStore.get();
  }

  /** Registers a lazily-constructed provider client available to tools via ctx.providers. */
  registerProvider(name: string, factory: () => Promise<unknown>): void {
    this.providerFactories.set(name, factory);
    this.providerCache.delete(name);
  }

  get providerAccess(): ProviderAccess {
    return this.providers;
  }

  async getModels(): Promise<ModelGateway | null> {
    const key = await this.credentials.get('OPENAI_API_KEY');
    if (!key) {
      this.gateway = null;
      this.gatewayKey = null;
      return null;
    }
    if (this.gateway && this.gatewayKey === key) return this.gateway;
    this.gateway = new ModelGateway({
      apiKey: key,
      models: this.settings.models,
      efforts: this.settings.efforts,
      serviceTier: this.settings.serviceTier,
      onCall: (call, ctx) => {
        if (ctx.runId) this.emitRun(ctx.runId, { type: 'model_call', call });
      },
    });
    this.gatewayKey = key;
    return this.gateway;
  }

  // ---------------------------------------------------------------- events

  private emitStatus(): void {
    const status: AppStatus = {
      runtime: 'ready',
      helper: this.helper.status(),
      activeRunIds: [...this.runs.values()].filter((r) => !TERMINAL_RUN_STATES.has(r.state)).map((r) => r.runId),
      pendingApprovals: this.approvals.size,
    };
    this.emit('status', status);
  }

  private emitVoice(e: VoiceEvent): void {
    this.emit('voice', e);
  }

  emitRun(runId: string, partial: ExecutorEvent): void {
    const run = this.runs.get(runId);
    const event = { ...partial, runId, at: Date.now() } as RunEvent;
    if (process.env.NODE_ENV !== 'production') {
      const check = RunEventSchema.safeParse(event);
      if (!check.success) this.log(`invalid run event ${event.type}: ${check.error.message}`);
    }
    if (run) {
      run.events.push(event);
      run.unflushed.push(event);
      if (!run.flushTimer) {
        run.flushTimer = setTimeout(() => {
          run.flushTimer = null;
          void this.flushRun(run);
        }, 150);
      }
    }
    this.emit('run', event);
  }

  private async flushRun(run: ActiveRun): Promise<void> {
    const batch = run.unflushed.splice(0);
    await this.runStore.appendEvents(run.runId, batch).catch((e) => this.log(`could not persist events: ${e}`));
  }

  private setRunState(run: ActiveRun, state: RunState, summary?: string): void {
    run.state = state;
    if (summary !== undefined) run.summary = summary;
    if (TERMINAL_RUN_STATES.has(state)) this.emitRun(run.runId, { type: 'metric', name: 'undo_operations', value: state === 'undone' ? 0 : run.journal.entryCount, unit: 'count' });
    this.emitRun(run.runId, { type: 'run_state', state, ...(summary ? { summary } : {}) });
    this.emitStatus();
  }

  // ---------------------------------------------------------------- runs

  async submit(
    text: string,
    source: CommandSource,
    dryRun = false,
    voiceMetrics: CommitMetrics | null = null,
    planOverride: ((executor: RunExecutor) => Promise<RouteDecision>) | null = null,
  ): Promise<string> {
    const runId = newRunId();
    const dir = this.runStore.dirFor(runId);
    await mkdir(join(dir, 'artifacts'), { recursive: true });
    const run: ActiveRun = {
      runId,
      command: text,
      source,
      dryRun,
      createdAt: Date.now(),
      state: 'created',
      events: [],
      unflushed: [],
      flushTimer: null,
      controller: new AbortController(),
      executor: null,
      decision: null,
      voiceMetrics,
      route: null,
      replayOf: null,
      planOverride: null,
      traceId: null,
      summary: null,
      finishedAt: null,
      journal: new UndoJournal(join(dir, 'journal.jsonl'), runId),
      dir,
      done: Promise.resolve(),
    };
    run.planOverride = planOverride;
    this.runs.set(runId, run);
    this.emitRun(runId, { type: 'run_created', command: text, source, dryRun });
    if (voiceMetrics?.utteranceToCommitMs !== undefined) {
      this.emitRun(runId, { type: 'metric', name: 'speech_to_transcript', value: voiceMetrics.utteranceToCommitMs, unit: 'ms' });
    }
    void this.audit.append('command_received', 'user', { command: text, source, dryRun }, { runId });
    run.done = this.executeRun(run).catch((e) => {
      this.log(`run ${runId} crashed: ${e instanceof Error ? e.stack : String(e)}`);
      if (!TERMINAL_RUN_STATES.has(run.state)) this.setRunState(run, 'failed', `internal error: ${e instanceof Error ? e.message : String(e)}`);
    });
    return runId;
  }

  /** Waits for a run to finish (used by the CLI, tests and benchmarks). */
  async waitForRun(runId: string): Promise<RunSummary> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    await run.done;
    return this.summaryOf(run);
  }

  private summaryOf(run: ActiveRun): RunSummary {
    const tasks = run.executor?.records() ?? [];
    return {
      runId: run.runId,
      command: run.command,
      source: run.source,
      state: run.state,
      dryRun: run.dryRun,
      createdAt: run.createdAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.decision ? { mode: run.decision.mode, intent: run.decision.intent } : {}),
      taskCount: tasks.length,
      succeededCount: tasks.filter((t) => t.state === 'succeeded').length,
      failedCount: tasks.filter((t) => t.state === 'failed').length,
      modelCalls: run.events.filter((e) => e.type === 'model_call').length,
      undoable: !run.dryRun && TERMINAL_RUN_STATES.has(run.state) && run.state !== 'undone' && run.journal.entryCount > 0,
      ...(run.traceId ? { traceId: run.traceId } : {}),
      ...(run.summary ? { summary: run.summary } : {}),
    };
  }

  private async executeRun(run: ActiveRun): Promise<void> {
    const { runId } = run;
    const deadline = setTimeout(() => run.controller.abort(new Error('deadline exceeded')), this.settings.runDeadlineMs);
    try {
      await withSpan(
        'command',
        OpenInferenceSpanKind.AGENT,
        {
          [SemanticConventions.INPUT_VALUE]: run.command,
          'commandos.run_id': runId,
          'commandos.source': run.source,
          'commandos.dry_run': run.dryRun,
          [SemanticConventions.SESSION_ID]: runId,
        },
        async (span) => {
          run.traceId = span.spanContext().traceId;
          this.emitRun(runId, { type: 'trace', traceId: run.traceId });
          this.setRunState(run, 'routing');
          const models = await abortable(() => this.getModels(), run.controller.signal);
          const routeStarted = performance.now();
          const executor = new RunExecutor(
            {
              registry: this.registry,
              settings: () => this.settings,
              helper: this.helper,
              models: () => models,
              providers: this.providers,
              approvals: this.approvals,
              emit: (e) => this.emitRun(runId, e),
              audit: (kind, data, taskId) => void this.audit.append(kind, 'agent', data, { runId, ...(taskId ? { taskId } : {}) }),
              recover: createRecovery(models, runId),
              checkpoint: {
                taskAdded: (spec) => this.checkpoints.taskAdded(runId, spec),
                taskSucceeded: (spec, output) => this.checkpoints.taskSucceeded(runId, spec.id, output),
              },
            },
            {
              runId,
              artifactsDir: join(run.dir, 'artifacts'),
              journal: run.journal,
              dryRun: run.dryRun,
              signal: run.controller.signal,
              deadlineAt: Date.now() + this.settings.runDeadlineMs,
            },
          );
          run.executor = executor;

          let route: RouteResult;
          let speculative: Promise<PlannerAnswer> | null = null;
          if (run.planOverride) {
            route = { decision: { mode: 'fast', intent: 'general', confidence: 1, via: 'procedure', reason: 'resuming from checkpoint', slots: {}, needsFullPreview: false } };
          } else {
            const local = routeLocally(run.command);
            try {
              if (local || !models) {
                route = await abortable(() => routeCommand(run.command, models, { runId, signal: run.controller.signal }), run.controller.signal);
              } else {
                // Speculative planning: the STANDARD planner starts while the router decides, with
                // its tool calls held until the route is known. Saves a full model round-trip.
                let openGate: (ok: boolean) => void = () => {};
                const gate = new Promise<boolean>((r) => {
                  openGate = r;
                });
                const specCtrl = new AbortController();
                // Optional memory retrieval must not delay starting the router.
                const started = this.plannerDeps(run, executor, models, AbortSignal.any([run.controller.signal, specCtrl.signal])).then((deps) =>
                  runStandardPlanner(run.command, null, { ...deps, gate }),
                );
                started.catch(() => {});
                try {
                  route = await abortable(() => routeCommand(run.command, models, { runId, signal: run.controller.signal }), run.controller.signal);
                } catch (e) {
                  openGate(false);
                  specCtrl.abort(new Error('routing failed'));
                  throw e;
                }
                const standard = isStandardRoute(route);
                openGate(standard);
                if (standard) speculative = started;
                else specCtrl.abort(new Error(`route is ${route.decision.mode}/${route.decision.intent}`));
              }
            } catch (e) {
              if (!run.controller.signal.aborted) this.setRunState(run, 'failed', `could not understand the command: ${e instanceof Error ? e.message : String(e)}`);
              throw e;
            }
          }
          run.controller.signal.throwIfAborted();
          run.decision = route.decision;
          run.route = route;
          this.emitRun(runId, { type: 'route', decision: route.decision, latencyMs: performance.now() - routeStarted });
          span.setAttributes({ 'commandos.mode': route.decision.mode, 'commandos.intent': route.decision.intent });

          if (route.control) {
            executor.seal();
            const summary = await this.handleControl(route.control, runId);
            run.controller.signal.throwIfAborted();
            this.setRunState(run, 'succeeded', summary);
            return;
          }

          this.setRunState(run, speculative ? 'running' : 'planning');
          let answer: PlannerAnswer | null = null;
          try {
            if (run.planOverride) {
              const decision = await abortable(() => run.planOverride!(executor), run.controller.signal);
              run.decision = decision;
              this.emitRun(runId, { type: 'route', decision, latencyMs: 0 });
            } else if (speculative) answer = await abortable(() => speculative!, run.controller.signal);
            else answer = await abortable(() => this.plan(run, route, executor, models), run.controller.signal);
          } catch (e) {
            executor.seal();
            if (run.controller.signal.aborted) throw e;
            this.emitRun(runId, { type: 'log', level: 'error', message: `planning failed: ${e instanceof Error ? e.message : String(e)}` });
            if (executor.records().length === 0) {
              this.setRunState(run, 'failed', `Planning failed: ${e instanceof Error ? e.message : String(e)}`);
              return;
            }
          }
          run.controller.signal.throwIfAborted();
          if (run.state !== 'running') this.setRunState(run, 'running');
          const result = await executor.done();
          if (!run.controller.signal.aborted) await this.rememberEmailAddress(run.runId, result);
          const aborted = run.controller.signal.aborted;
          const reason = aborted ? String((run.controller.signal.reason as Error | undefined)?.message ?? '') : undefined;
          const state = finalState(result, aborted, reason, answer);
          const summary = aborted ? `Run ${state}${reason ? `: ${reason}` : ''}.` : summarize(result, run.dryRun, answer);
          span.setAttributes({
            'commandos.outcome': state,
            'commandos.tasks.succeeded': result.succeeded,
            'commandos.tasks.failed': result.failed,
            [SemanticConventions.OUTPUT_VALUE]: summary,
          });
          this.setRunState(run, state, summary);
          if (state === 'succeeded' && run.source === 'voice' && this.settings.voice.speakResults) void this.speakSummary(summary);
          await this.rememberRun(run).catch((e) => this.emitRun(runId, { type: 'log', level: 'warn', message: `memory: ${e instanceof Error ? e.message : String(e)}`, data: { provider: 'surrealdb', activity: 'failed' } }));
        },
      );
    } catch (error) {
      if (!run.controller.signal.aborted) throw error;
      const reason = String((run.controller.signal.reason as Error | undefined)?.message ?? 'cancelled');
      const state = reason === 'emergency stop' ? 'stopped' : 'cancelled';
      this.setRunState(run, state, `Run ${state}: ${reason}.`);
      // The executor seals on abort; allow its cancelled task events to settle before persistence.
      if (run.executor) await run.executor.done();
    } finally {
      clearTimeout(deadline);
      const cleaned = await this.cleanupProviders(runId);
      if (cleaned.sandboxes || cleaned.browsers) {
        this.emitRun(runId, { type: 'log', level: 'info', message: `cleanup: retained ${cleaned.sandboxes} sandbox(es) for inspection, closed ${cleaned.browsers} browser session(s)`, data: { activity: 'cleanup', ...cleaned } });
      }
      run.finishedAt = Date.now();
      const metrics = computeMetrics(runId, run.events, { speechToTranscriptMs: run.voiceMetrics?.utteranceToCommitMs });
      for (const [name, value] of [
        ['time_to_first_action', metrics.timeToFirstActionMs],
        ['router_latency', metrics.routerMs],
        ['total_duration', metrics.totalMs],
      ] as const) {
        if (value !== undefined) this.emitRun(runId, { type: 'metric', name, value, unit: 'ms' });
      }
      this.emitRun(runId, { type: 'metric', name: 'model_calls', value: metrics.modelCalls, unit: 'count' });
      if (run.flushTimer) clearTimeout(run.flushTimer);
      run.flushTimer = null;
      await this.flushRun(run);
      await run.journal.flush();
      await this.runStore.writeSummary(this.summaryOf(run)).catch(() => {});
      void this.audit.append('run_finished', 'system', { state: run.state, summary: run.summary, metrics }, { runId });
      this.emitStatus();
    }
  }

  /**
   * Builds the plan for a routed command: deterministic templates for known workflows (FAST),
   * incremental streaming planning with gpt-6.1-sol (STANDARD) or a complete validated DAG from
   * gpt-6-astra (DEEP).
   */
  protected async plan(run: ActiveRun, route: RouteResult, executor: RunExecutor, models: ModelGateway | null): Promise<PlannerAnswer | null> {
    const { decision } = route;
    if (decision.intent === 'replay_procedure' && (await this.planReplay(run, executor, models))) return null;
    if (decision.intent === 'web_research_form' && route.web) {
      const anchor = await this.credentials.get('ANCHORBROWSER_API_KEY');
      let baseUrl = process.env.COMMANDOS_FIXTURE_URL ?? 'https://commandos-fixtures.vercel.app';
      if (route.web.url) {
        try {
          baseUrl = new URL(/^https?:\/\//.test(route.web.url) ? route.web.url : `https://${route.web.url}`).origin;
        } catch {
          // keep the default fixture site
        }
      }
      executor.addPlan(
        webFormPlan({
          ...route.web,
          baseUrl,
          provider: anchor ? 'anchor' : 'local',
          headless: process.env.COMMANDOS_HEADLESS === '1',
        }),
      );
      executor.seal();
      return null;
    }
    if (decision.intent === 'repo_test_fix' && route.repo) {
      executor.addPlan(repoTestFixPlan(route.repo));
      executor.seal();
      return null;
    }
    if (route.photoAttachment || route.existingAttachment) {
      executor.addPlan(photoAttachmentPlan(route.existingAttachment?.path));
      executor.seal();
      this.setRunState(run, 'running');
      await executor.waitFor(['attach']);
      return executor.get('attach')?.state === 'succeeded'
        ? { outcome: 'done', summary: 'Attached the Photo Booth photo to your Qwen chat. The message was left unsent.' }
        : null;
    }
    if (route.pageQuestion) {
      executor.addPlan(pageQuestionPlan(route.pageQuestion));
      executor.seal();
      this.setRunState(run, 'running');
      await executor.waitFor(['answer']);
      const summary = resolveAnswer('answer.output.text', executor);
      return summary ? { outcome: 'done', summary } : null;
    }
    if (route.quick) {
      executor.addPlan(quickPlan(route.quick));
      executor.seal();
      return null;
    }
    if (decision.intent === 'send_email' && route.email) {
      executor.addPlan(emailPlan(route.email));
      executor.seal();
      return null;
    }
    if (decision.intent === 'organize_screenshots' && route.organize) {
      const plan = organizeScreenshotsPlan(route.organize, this.settings, { reveal: this.opts.revealResults !== false });
      executor.addPlan(plan);
      executor.seal();
      return null;
    }
    if (!models) {
      executor.seal();
      throw new Error('this command needs the planning model, but OPENAI_API_KEY is not configured');
    }
    const deps = await this.plannerDeps(run, executor, models, run.controller.signal);
    if (route.githubRepositoryName) {
      // Resolve identity from actual local Git metadata before the first model
      // turn. A prompt instruction alone did not prevent ownerless GitHub URLs.
      this.setRunState(run, 'running');
      executor.addTask({ id: 'resolve_repository', tool: 'repo.locate', title: `Resolve ${route.githubRepositoryName} from local Git metadata`, args: { name: route.githubRepositoryName, roots: this.settings.allowedRoots } });
      await executor.waitFor(['resolve_repository']);
      const record = executor.get('resolve_repository');
      if (record?.state === 'succeeded') {
        const located = executor.outputOf('resolve_repository') as { matches: Array<{ repoPath: string; repositoryUrl: string }>; truncated: boolean };
        if (!located.truncated && located.matches.length === 1) {
          deps.context = [...(deps.context ?? []), `Verified local Git metadata for the named repository (read by resolve_repository): ${JSON.stringify(located.matches[0])}. Use this exact repositoryUrl and construct its issue URL by appending /issues/NUMBER. This repoPath is the matching local checkout. The user's requested browser, issue and sandbox constraints still apply. Do not use an ownerless or guessed GitHub URL.`];
        } else {
          deps.context = [...(deps.context ?? []), `Local repository lookup did not establish one unambiguous owner: ${JSON.stringify(located)}. Resolve owner/repo from the signed-in GitHub dashboard or ask for the exact URL; do not invent one.`];
        }
      }
    }
    if (decision.mode === 'deep') {
      await runDeepPlanner(run.command, decision, deps);
      return null;
    }
    this.setRunState(run, 'running');
    // commands that skipped the router are plainly safe and usually simple: the fast model plans
    // them (measured ~40% faster per turn) and hands over to the main model if a step fails
    return runStandardPlanner(run.command, decision, { ...deps, ...(decision.via === 'grammar' ? { tier: 'fast' as const } : {}) });
  }

  private async plannerDeps(run: ActiveRun, executor: RunExecutor, models: ModelGateway, signal: AbortSignal): Promise<PlannerDeps> {
    return {
      runId: run.runId,
      signal,
      executor,
      registry: this.registry,
      models,
      settings: this.settings,
      emit: (e) => this.emitRun(run.runId, e),
      context: await this.planningContext(run.command),
    };
  }

  /** Extra planner context: verified procedures recalled from SurrealDB Agent Memory. */
  protected async planningContext(command: string): Promise<string[]> {
    const memory = await this.optionalProvider<ProcedureMemory>('memory');
    if (!memory) return [];
    let timer: NodeJS.Timeout | undefined;
    const recalled = await Promise.race([
      memory.recallProcedures(command, 2).catch(() => [] as RecalledProcedure[]),
      // Hints are optional; explicit "do the same" replay still waits for durable memory.
      new Promise<RecalledProcedure[]>((r) => { timer = setTimeout(() => r([]), 350); }),
    ]).finally(() => clearTimeout(timer));
    return recalled.map(
      (r) =>
        `Previously verified procedure (${r.procedure.status}, score ${r.score.toFixed(2)}): “${r.procedure.command}” → ${r.procedure.summary} Tools: ${[...new Set((r.procedure.tasks ?? []).map((t) => String(t.tool)))].join(', ') || r.procedure.template}`,
    );
  }

  /** A provider client if its credentials are configured, else null (never throws). */
  async optionalProvider<T>(name: string): Promise<T | null> {
    try {
      return await this.providers.get<T>(name);
    } catch {
      return null;
    }
  }

  private async procedureSourceFor(runId: string): Promise<ProcedureSource | null> {
    try {
      const original = ProcedureSourceSchema.parse(JSON.parse(await readFile(join(this.runStore.dirFor(runId), 'procedure.json'), 'utf8')));
      const latest = ProcedureSourceSchema.safeParse(JSON.parse(await readFile(join(this.opts.dataDir, 'memory', `${original.procedureId}.json`), 'utf8').catch(() => 'null')));
      return latest.success && latest.data.procedureId === original.procedureId ? latest.data : original;
    } catch { return null; }
  }

  private async saveProcedureSource(run: ActiveRun, procedureId: string, saved: { sessionId: string; memoryId: string | null }): Promise<void> {
    const source = ProcedureSourceSchema.parse({ procedureId, ...saved });
    await mkdir(join(this.opts.dataDir, 'memory'), { recursive: true });
    // The per-procedure pointer also tracks invalidation and repeated replays, so an older
    // successful run cannot bypass a newer stale version by referencing its original turn.
    await writeFile(join(this.opts.dataDir, 'memory', `${procedureId}.json`), JSON.stringify(source));
    await writeFile(join(run.dir, 'procedure.json'), JSON.stringify(source));
  }

  /**
   * Replays a verified procedure from memory: recall → fingerprint check → bind parameters
   * (deterministically when the command names them, else one fast-model call) → validated plan.
   * Returns false to fall back to normal planning.
   */
  private async planReplay(run: ActiveRun, executor: RunExecutor, models: ModelGateway | null): Promise<boolean> {
    const memory = await this.optionalProvider<ProcedureMemory>('memory');
    if (!memory) {
      this.emitRun(run.runId, { type: 'log', level: 'warn', message: 'replay requested but SurrealDB Agent Memory is not configured; planning from scratch' });
      return false;
    }
    // A referential command has little semantic overlap with the operation being repeated.
    // Recall the preceding completed operation, then bind the new command's inputs to it.
    const previous = (await this.listRuns()).find((r) => r.runId !== run.runId && r.createdAt < run.createdAt &&
      !r.dryRun && (r.state === 'succeeded' || r.state === 'undone') && r.taskCount > 0 && r.succeededCount === r.taskCount && r.intent !== 'control');
    const query = previous?.command ?? run.command;
    const source = previous ? await this.procedureSourceFor(previous.runId) : null;
    const recalled = await withSpan('memory recall', OpenInferenceSpanKind.RETRIEVER, { [SemanticConventions.INPUT_VALUE]: query }, async (span) => {
      if (source) {
        const known = await memory.readProcedure(source);
        span.setAttributes({ 'retrieval.documents.count': known ? 1 : 0, 'commandos.memory.source': source.sessionId });
        return known ? [known] : [];
      }
      const hits = await memory.recallProcedures(query, 5);
      span.setAttributes({ 'retrieval.documents.count': hits.length, [SemanticConventions.OUTPUT_VALUE]: spanJson(hits.map((h) => ({ id: h.procedure.id, score: h.score, command: h.procedure.command }))) });
      return hits;
    });
    const best = recalled.find((r) => r.procedure.status === 'active' && (source ? r.procedure.id === source.procedureId : !previous || r.procedure.runId === previous.runId));
    if (!best) {
      this.emitRun(run.runId, { type: 'log', level: 'warn', message: 'no active stored procedure matches this command; planning from scratch' });
      return false;
    }
    const mismatches = await checkFingerprint(best.procedure.fingerprint, this.registry, this.helper);
    if (mismatches.length) {
      this.emitRun(run.runId, { type: 'log', level: 'warn', message: `procedure ${best.procedure.id} no longer matches this Mac (${mismatches.join('; ')}); planning with it as a hint` });
      return false;
    }
    let values = bindDeterministic(best.procedure, run.command);
    let via = 'deterministically (no model call)';
    if (!values) {
      if (!models) return false;
      values = await bindWithModel(best.procedure, run.command, models, { runId: run.runId, signal: run.controller.signal });
      via = `with ${models.modelFor('fast')}`;
    }
    const plan = instantiate(best.procedure, values, this.settings, { reveal: this.opts.revealResults !== false });
    run.replayOf = best;
    const decision: RouteDecision = {
      mode: 'fast',
      intent: 'replay_procedure',
      confidence: Math.min(1, best.score),
      via: 'procedure',
      reason: `reusing verified procedure from “${best.procedure.command}”`,
      slots: values,
      procedureId: best.procedure.id,
      needsFullPreview: false,
    };
    run.decision = decision;
    this.emitRun(run.runId, { type: 'route', decision, latencyMs: 0 });
    this.emitRun(run.runId, {
      type: 'narration',
      text: `Reusing procedure ${best.procedure.id} from SurrealDB memory (score ${best.score.toFixed(2)}); parameters bound ${via}: ${JSON.stringify(values)}`,
    });
    this.emitRun(run.runId, { type: 'log', level: 'info', message: `memory: recalled verified procedure ${best.procedure.id}`, data: { provider: 'surrealdb', activity: 'recalled', procedureId: best.procedure.id, memoryId: best.memoryId, score: best.score, source } });
    executor.addPlan(plan);
    executor.seal();
    return true;
  }

  /** Stores verified procedures and run outcomes in SurrealDB Agent Memory (if configured). */
  private async rememberRun(run: ActiveRun): Promise<void> {
    if (run.dryRun || !run.route || run.route.control || !run.executor) return;
    const memory = await this.optionalProvider<ProcedureMemory>('memory');
    if (!memory || !run.decision) return;
    const records = run.executor.records();
    const durationMs = Date.now() - run.createdAt;
    this.emitRun(run.runId, { type: 'log', level: 'info', message: 'memory: recording the verified run outcome', data: { provider: 'surrealdb', activity: 'saving' } });
    await withSpan('memory write', OpenInferenceSpanKind.CHAIN, { 'commandos.run_id': run.runId }, async () => {
      if (run.state === 'succeeded' && records.length) {
        if (run.replayOf) {
          const p = run.replayOf.procedure;
          const updated = {
            ...p,
            stats: { ...p.stats, successes: p.stats.successes + 1, avgMs: (p.stats.avgMs * p.stats.successes + durationMs) / (p.stats.successes + 1), lastVerifiedAt: new Date().toISOString() },
            updatedAt: new Date().toISOString(),
          };
          const saved = await memory.rememberProcedure(updated);
          await this.saveProcedureSource(run, p.id, saved);
          this.emitRun(run.runId, { type: 'log', level: 'info', message: `memory: procedure ${p.id} verified again (${updated.stats.successes} successes)`, data: { provider: 'surrealdb', activity: 'saved', procedureId: p.id, memoryId: saved.memoryId, source: saved } });
        } else {
          const fingerprint = await fingerprintFor(records, this.registry, this.helper.running ? this.helper : null);
          const procedure = buildProcedure({
            runId: run.runId,
            command: run.command,
            decision: run.decision as RouteDecision,
            ...(run.route?.organize ? { organize: run.route.organize } : {}),
            records,
            fingerprint,
            durationMs,
            summary: run.summary ?? '',
          });
          const saved = await memory.rememberProcedure(procedure);
          await this.saveProcedureSource(run, procedure.id, saved);
          this.emitRun(run.runId, { type: 'log', level: 'info', message: `memory: saved verified procedure ${procedure.id} to SurrealDB Agent Memory${saved.memoryId ? ` (${saved.memoryId})` : ''}`, data: { provider: 'surrealdb', activity: 'saved', procedureId: procedure.id, memoryId: saved.memoryId, source: saved } });
          void this.audit.append('procedure_saved', 'system', { procedureId: procedure.id, memoryId: saved.memoryId }, { runId: run.runId });
        }
      } else if (run.replayOf && (run.state === 'failed' || run.state === 'partial')) {
        const p = run.replayOf.procedure;
        const saved = await memory.rememberProcedure({ ...p, status: 'stale', stats: { ...p.stats, failures: p.stats.failures + 1 }, updatedAt: new Date().toISOString() });
        await this.saveProcedureSource(run, p.id, saved);
        this.emitRun(run.runId, { type: 'log', level: 'warn', message: `memory: procedure ${p.id} failed on replay and is now marked stale`, data: { provider: 'surrealdb', activity: 'stale', procedureId: p.id } });
      }
      await memory.rememberOutcome({
        intent: run.decision?.intent ?? 'general',
        command: run.command,
        success: run.state === 'succeeded',
        summary: run.summary ?? run.state,
        runId: run.runId,
        durationMs,
      });
      this.emitRun(run.runId, { type: 'log', level: 'info', message: 'memory: run outcome recorded in SurrealDB Agent Memory', data: { provider: 'surrealdb', activity: 'outcome_saved' } });
    });
  }

  private async handleControl(action: ControlAction, selfRunId: string): Promise<string> {
    const others = [...this.runs.values()].filter((r) => r.runId !== selfRunId).sort((a, b) => b.createdAt - a.createdAt);
    switch (action) {
      case 'emergency_stop':
        await this.emergencyStop();
        return 'Emergency stop: all runs stopped.';
      case 'cancel': {
        const active = others.find((r) => !TERMINAL_RUN_STATES.has(r.state));
        if (!active) return 'Nothing is running.';
        this.cancel(active.runId);
        return `Cancelled: ${active.command}`;
      }
      case 'undo': {
        const last = (await this.listRuns()).find((r) => r.runId !== selfRunId && r.undoable);
        if (!last) return 'Nothing to undo.';
        const report = await this.undo(last.runId);
        return report.ok ? `Undid "${last.command}" (${report.steps} step(s)).` : `Undo incomplete: ${report.failures.join('; ')}`;
      }
      case 'approve':
      case 'deny': {
        const pending = this.approvals.list().sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!pending) return 'No approval is waiting.';
        this.approvals.respond(pending.id, action === 'approve' ? 'approve' : 'deny');
        return `${action === 'approve' ? 'Approved' : 'Denied'}: ${pending.title}`;
      }
    }
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return false;
    run.controller.abort(new Error('cancelled by user'));
    this.approvals.denyRun(runId);
    void this.audit.append('run_cancelled', 'user', {}, { runId });
    return true;
  }

  /** Stops everything immediately: runs, approvals, voice, helper operations. */
  async emergencyStop(): Promise<void> {
    this.safetyLab.cancel();
    void this.audit.append('emergency_stop', 'user', {});
    for (const run of this.runs.values()) {
      if (!TERMINAL_RUN_STATES.has(run.state)) run.controller.abort(new Error('emergency stop'));
    }
    this.approvals.denyAll();
    this.voiceStop(false);
    // kill in-flight native operations and terminal process groups; the helper restarts lazily
    this.helper.stop(true);
    const killed = killAllProcesses();
    if (killed) void this.audit.append('processes_killed', 'system', { count: killed });
    for (const hook of this.stopHooks) await hook().catch(() => {});
    this.emitStatus();
  }

  private readonly stopHooks: Array<() => Promise<void>> = [];
  onEmergencyStop(hook: () => Promise<void>): void {
    this.stopHooks.push(hook);
  }

  respondApproval(approvalId: string, decision: ApprovalDecision): boolean {
    return this.approvals.respond(approvalId, decision);
  }

  async undo(runId: string): Promise<UndoReport> {
    const run = this.runs.get(runId);
    if (run && !TERMINAL_RUN_STATES.has(run.state)) throw new Error('cannot undo a run that is still in progress');
    const dir = this.runStore.dirFor(runId);
    const marker = join(dir, 'undone.json');
    if (await readFile(marker, 'utf8').catch(() => null)) throw new Error('this run was already undone');
    const entries = await UndoJournal.read(join(dir, 'journal.jsonl'));
    const report = await withSpan('undo', OpenInferenceSpanKind.CHAIN, { 'commandos.run_id': runId }, async () => undoEntries(entries, this.helper));
    await writeFile(marker, JSON.stringify({ at: new Date().toISOString(), report }), 'utf8');
    void this.audit.append('undo', 'user', report, { runId });
    if (run) {
      this.emitRun(runId, { type: 'undo', ok: report.ok, steps: report.steps, failures: report.failures });
      if (report.ok) this.setRunState(run, 'undone', `Undone: ${report.steps} step(s) reverted.`);
      await this.flushRun(run);
      await this.runStore.writeSummary(this.summaryOf(run));
    } else {
      const summary = await this.runStore.readSummary(runId);
      if (summary) await this.runStore.writeSummary({ ...summary, state: report.ok ? 'undone' : summary.state, undoable: false });
      await this.runStore.appendEvents(runId, [{ type: 'undo', runId, at: Date.now(), ok: report.ok, steps: report.steps, failures: report.failures }]);
    }
    return report;
  }

  async listRuns(): Promise<RunSummary[]> {
    const live = [...this.runs.values()].map((r) => this.summaryOf(r));
    const stored = await this.runStore.listSummaries(100);
    const seen = new Set(live.map((r) => r.runId));
    return [...live, ...stored.filter((s) => !seen.has(s.runId))].sort((a, b) => b.createdAt - a.createdAt);
  }

  async getRun(runId: string): Promise<RunSnapshot> {
    const run = this.runs.get(runId);
    if (run) return { summary: this.summaryOf(run), events: run.events };
    const summary = await this.runStore.readSummary(runId);
    if (!summary) throw new Error(`unknown run ${runId}`);
    return { summary, events: await this.runStore.readEvents(runId) };
  }

  async runImage(runId: string, taskId: string): Promise<{ dataUrl: string }> {
    IdSchema.parse(runId);
    const snapshot = await this.getRun(runId);
    const task = snapshot.events.find((e) => e.type === 'task_added' && e.task.id === taskId);
    if (task?.type !== 'task_added' || task.task.tool !== 'web.screenshot') throw new Error('Only recorded browser screenshots can be displayed');
    const event = snapshot.events.findLast((e) => e.type === 'task_output' && e.taskId === taskId);
    const path = event?.type === 'task_output' && typeof event.output === 'object' && event.output !== null ? (event.output as { path?: unknown }).path : null;
    if (typeof path !== 'string') throw new Error('Screenshot is not available yet');
    const root = await realpath(join(this.runStore.dirFor(runId), 'artifacts'));
    const file = await realpath(path);
    const rel = relative(root, file);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Screenshot is outside this run’s artifacts');
    const info = await stat(file);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Screenshot is too large to display');
    const bytes = await readFile(file);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
    // Some remote browser backends return JPEG even for a .png screenshot path.
    // Identify the encoded bytes rather than trusting the filename extension.
    if (bytes.length > 8 * 1024 * 1024 || !mime) throw new Error('Screenshot is not a supported PNG or JPEG');
    return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
  }

  async browserPreview(runId: string, sessionId: string): Promise<{ state: 'live' | 'closed' | 'unavailable'; dataUrl: string | null }> {
    IdSchema.parse(runId); IdSchema.parse(sessionId);
    const run = this.runs.get(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return { state: 'closed', dataUrl: null };
    const provider = this.providerCache.get('browser');
    if (!provider) return { state: 'closed', dataUrl: null };
    const browser = await provider as BrowserHub;
    // Validate ownership separately; screenshot/navigation failures are temporary.
    if (!browser.openIds().includes(sessionId)) return { state: 'closed', dataUrl: null };
    const session = browser.get(sessionId);
    if (session.runId !== runId || session.kind !== 'anchor') throw new Error('Browser preview does not belong to this cloud run');
    try {
      const bytes = await browser.preview(runId, sessionId);
      if (!bytes) return { state: 'closed', dataUrl: null };
      if (bytes.length > 4 * 1024 * 1024) return { state: 'unavailable', dataUrl: null };
      return { state: 'live', dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` };
    } catch { return { state: 'unavailable', dataUrl: null }; }
  }

  async runMetrics(runId: string): Promise<RunMetrics> {
    const snap = await this.getRun(runId);
    const speech = snap.events.find((e) => e.type === 'metric' && e.name === 'speech_to_transcript');
    return computeMetrics(runId, snap.events, speech && speech.type === 'metric' ? { speechToTranscriptMs: speech.value } : {});
  }

  // ---------------------------------------------------------------- settings & credentials

  /** The Gmail account a draft was opened with becomes "me", so later drafts need no lookup. */
  private async rememberEmailAddress(runId: string, result: ExecutorResult): Promise<void> {
    if (this.settings.userEmail) return;
    const compose = result.tasks.find((t) => t.spec.tool === 'gmail.compose' && t.state === 'succeeded');
    const account = (compose?.output as { account?: string | null } | undefined)?.account;
    if (!account) return;
    try {
      await this.settingsStore.update({ userEmail: account });
      void this.audit.append('settings_updated', 'system', { keys: ['userEmail'], reason: 'learned from the Gmail account in Chrome' });
      this.emitRun(runId, { type: 'log', level: 'info', message: `Saved ${account} as your address for “email myself” (Settings → You)` });
    } catch {
      // not worth failing a run over
    }
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const next = await this.settingsStore.update(patch);
    this.gateway?.configure(next.models, next.efforts, next.serviceTier);
    void this.audit.append('settings_updated', 'user', { keys: Object.keys(patch) });
    return next;
  }

  credentialStatus(): Promise<CredentialStatus[]> {
    return this.credentials.status();
  }

  async setCredential(key: CredentialKey, value: string): Promise<void> {
    await this.credentials.set(key, value);
    this.providerCache.clear();
    void this.audit.append('credential_set', 'user', { key });
  }

  async deleteCredential(key: CredentialKey): Promise<void> {
    await this.credentials.delete(key);
    this.providerCache.clear();
    void this.audit.append('credential_deleted', 'user', { key });
  }

  async permissions(): Promise<PermissionStatus | null> {
    try {
      return await this.helper.call('permissions.status', {});
    } catch {
      return null;
    }
  }

  async requestPermission(kind: 'accessibility' | 'screenRecording'): Promise<PermissionStatus | null> {
    try {
      return await this.helper.call('permissions.request', { kind });
    } catch {
      return null;
    }
  }

  toolDescriptors(): ToolDescriptor[] {
    return this.registry.descriptors();
  }

  async diagnostics(): Promise<Diagnostics> {
    let verification: VerificationReport | null = null;
    if (this.opts.verificationReportPath) {
      try {
        verification = VerificationReportSchema.parse(JSON.parse(await readFile(this.opts.verificationReportPath, 'utf8')));
      } catch {
        verification = null;
      }
    }
    return {
      dataDir: this.opts.dataDir,
      helper: this.helper.status(),
      permissions: await this.permissions(),
      telemetry: {
        arize: this.telemetry?.arizeEnabled ?? false, localTraceFile: this.telemetry?.localTraceFile ?? null,
        projectName: this.settings.telemetry.projectName,
        exportStats: this.telemetry?.arizeStats ? { spans: this.telemetry.arizeStats.spans, batches: this.telemetry.arizeStats.batches, failures: this.telemetry.arizeStats.failures, lastSuccessAt: this.telemetry.arizeStats.lastSuccessAt } : null,
      },
      verification,
    };
  }

  // ---------------------------------------------------------------- voice

  async voiceStart(): Promise<void> {
    if (this.transcriber) return;
    const generation = ++this.voiceGeneration;
    const key = await this.credentials.get('ELEVENLABS_API_KEY');
    if (generation !== this.voiceGeneration) return;
    if (!key) {
      this.emitVoice({ type: 'state', state: 'unavailable', detail: 'ELEVENLABS_API_KEY is not configured', at: Date.now() });
      throw new Error('ELEVENLABS_API_KEY is not configured');
    }
    const v = this.settings.voice;
    const t = new RealtimeTranscriber({
      apiKey: key,
      commitStrategy: v.commitStrategy,
      vadSilenceSecs: v.vadSilenceSecs,
      languageCode: v.languageCode,
      keyterms: ['CommandOS', 'screenshots', 'Daytona', 'Arize', 'SurrealDB', 'Anchor'],
    });
    t.on('state', (state, detail) => { if (generation === this.voiceGeneration) this.emitVoice({ type: 'state', state, ...(detail ? { detail } : {}), at: Date.now() }); });
    t.on('partial', (text) => { if (generation === this.voiceGeneration) this.emitVoice({ type: 'partial', text, at: Date.now() }); });
    t.on('committed', (text, metrics) => {
      if (generation !== this.voiceGeneration) return;
      this.emitVoice({ type: 'committed', text, metrics, at: Date.now() });
      if (this.settings.voice.autoSubmit) void this.submit(text, 'voice', false, metrics);
    });
    t.on('level', (rms) => {
      if (generation !== this.voiceGeneration) return;
      const now = Date.now();
      if (now - this.lastLevelAt > 80) {
        this.lastLevelAt = now;
        this.emitVoice({ type: 'level', rms, at: now });
      }
    });
    t.on('error', (e) => { if (generation === this.voiceGeneration) this.emitVoice({ type: 'error', message: e.message, at: Date.now() }); });
    this.transcriber = t;
    this.voiceSessions.add(t);
    try {
      await t.start();
      if (generation !== this.voiceGeneration) t.stop();
    } catch (e) {
      this.voiceSessions.delete(t);
      if (this.transcriber === t) this.transcriber = null;
      if (generation !== this.voiceGeneration) return;
      const message = e instanceof Error ? e.message : String(e);
      this.emitVoice({ type: 'error', message, at: Date.now() });
      this.emitVoice({ type: 'state', state: 'error', detail: message, at: Date.now() });
      throw e;
    }
  }

  voiceStop(commit: boolean): void {
    if (!commit) {
      ++this.voiceGeneration;
      for (const session of this.voiceSessions) session.stop();
      this.voiceSessions.clear();
      this.transcriber = null;
      this.emitVoice({ type: 'state', state: 'idle', at: Date.now() });
      return;
    }
    const t = this.transcriber;
    if (!t) return;
    this.transcriber = null;
    t.commit();
    setTimeout(() => { t.stop(); this.voiceSessions.delete(t); }, 2500);
  }

  pushAudio(chunk: Uint8Array): void {
    this.transcriber?.pushAudio(chunk);
  }

  private async speakSummary(text: string): Promise<void> {
    const key = await this.credentials.get('ELEVENLABS_API_KEY');
    if (!key) return;
    this.emitVoice({ type: 'speaking', text, at: Date.now() });
    try {
      await speak(key, this.settings.voice.ttsVoiceId, text);
    } catch (e) {
      this.emitVoice({ type: 'error', message: `speech failed: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async shutdown(): Promise<void> {
    const labStopped = this.safetyLab.stop();
    for (const run of this.runs.values()) if (!TERMINAL_RUN_STATES.has(run.state)) run.controller.abort(new Error('shutdown'));
    await Promise.allSettled([...this.runs.values()].map((r) => r.done).concat(labStopped));
    this.voiceStop(false);
    await this.cleanupProviders();
    this.helper.stop();
    await this.audit.flush();
    await this.telemetry?.flush().catch(() => {});
  }
}
