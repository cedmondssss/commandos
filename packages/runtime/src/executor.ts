import {
  type CheckResult,
  type PlanInput,
  PlanSchema,
  type PolicyDecision,
  type RunEvent,
  type Settings,
  TaskSpecSchema,
  type TaskSpec,
  type TaskSpecInput,
  type TaskState,
  type TaskView,
  TERMINAL_TASK_STATES,
} from '@commandos/contracts';
import {
  type ModelGateway,
  OpenInferenceSpanKind,
  SemanticConventions,
  spanJson,
  withSpan,
} from '@commandos/providers';
import {
  type AnyTool,
  HelperCallError,
  type HelperClient,
  type ProviderAccess,
  type ToolContext,
  ToolError,
  type ToolRegistry,
} from '@commandos/tools';
import { type Context, context } from '@opentelemetry/api';
import { z } from 'zod';
import type { ApprovalBroker } from './approvals';
import { abortable } from './abort';
import { BindingError, checkBindingRefs, conditionOutputPath, missingOutputPath, resolveArgs, splitBindingSource, withBindingDeps } from './bindings';
import { evaluateConditions } from './conditions';
import type { UndoJournal } from './journal';
import { LockManager } from './locks';
import { evaluatePolicy } from './policy';

/** Run events emitted by the executor; the runtime stamps runId and time. */
export type ExecutorEvent = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'runId' | 'at'> : never) : never;

export interface ExecutorDeps {
  registry: ToolRegistry;
  settings: () => Settings;
  helper: HelperClient;
  models: () => ModelGateway | null;
  providers: ProviderAccess;
  approvals: ApprovalBroker;
  emit: (e: ExecutorEvent) => void;
  audit: (kind: string, data: unknown, taskId?: string) => void;
  /** proposes a recovery attempt for a failed task, or null to give up */
  recover?: RecoverFn;
  /** checkpoint hooks: full task specs and verified outputs, for crash recovery and resume */
  checkpoint?: {
    taskAdded(spec: TaskSpec): void;
    taskSucceeded(spec: TaskSpec, output: unknown): void;
  };
}

export interface RecoveryRequest {
  task: TaskRecord;
  args: unknown;
  error: { code?: string; message: string };
  history: Array<{ label: string; error: string }>;
  dependencyOutputs: Record<string, unknown>;
}

export interface RecoveryProposal {
  args: unknown;
  label: string;
  via: 'alternative' | 'repair';
  tier?: 'fast' | 'main' | 'deep';
}

export type RecoverFn = (req: RecoveryRequest, signal: AbortSignal) => Promise<RecoveryProposal | null>;

export interface ExecutorRun {
  runId: string;
  artifactsDir: string;
  journal: UndoJournal;
  dryRun: boolean;
  signal: AbortSignal;
  deadlineAt: number;
}

export interface TaskRecord {
  spec: TaskSpec;
  tool: AnyTool;
  state: TaskState;
  attempt: number;
  args?: unknown;
  output?: unknown;
  error?: string;
  errorCode?: string;
  policy?: PolicyDecision;
  checks?: CheckResult[];
  startedAt?: number;
  endedAt?: number;
}

export interface ExecutorResult {
  tasks: TaskRecord[];
  succeeded: number;
  failed: number;
  skipped: number;
  denied: number;
  cancelled: number;
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

export class VerificationError extends Error {
  constructor(readonly failed: CheckResult[]) {
    super(`verification failed: ${failed.map((c) => c.label + (c.detail ? ` (${c.detail})` : '')).join('; ')}`);
    this.name = 'VerificationError';
  }
}

function errorText(e: unknown): string {
  if (e instanceof z.ZodError) return z.prettifyError(e);
  return e instanceof Error ? e.message : String(e);
}

function isTransient(e: unknown): boolean {
  if (e instanceof ToolError) return e.retryable;
  if (e instanceof HelperCallError) return ['timeout', 'helper_exited'].includes(e.code);
  const code = (e as { status?: number }).status;
  return code === 429 || (typeof code === 'number' && code >= 500);
}

export function toView(rec: Pick<TaskRecord, 'spec' | 'tool'>): TaskView {
  const effectClass = typeof rec.tool.effectClass === 'function' ? 'reversible_local' : rec.tool.effectClass;
  const risk = typeof rec.tool.risk === 'function' ? 'medium' : rec.tool.risk;
  return {
    id: rec.spec.id,
    tool: rec.spec.tool,
    title: rec.spec.title ?? rec.tool.title,
    args: rec.spec.args,
    dependsOn: rec.spec.dependsOn,
    bind: rec.spec.bind,
    postconditions: rec.spec.postconditions,
    tier: rec.tool.tier,
    effectClass,
    risk,
  };
}

/** Kahn topological order; throws on cycles or unknown dependencies. */
export function topoSort(tasks: TaskSpec[]): TaskSpec[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length) throw new TaskValidationError('duplicate task ids in plan');
  const indegree = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!byId.has(d)) throw new TaskValidationError(`task ${t.id} depends on unknown task ${d}`);
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
    }
  }
  const queue = tasks.filter((t) => indegree.get(t.id) === 0);
  const out: TaskSpec[] = [];
  while (queue.length) {
    const t = queue.shift() as TaskSpec;
    out.push(t);
    for (const other of tasks) {
      if (other.dependsOn.includes(t.id)) {
        const n = (indegree.get(other.id) ?? 0) - 1;
        indegree.set(other.id, n);
        if (n === 0) queue.push(other);
      }
    }
  }
  if (out.length !== tasks.length) throw new TaskValidationError('plan has a dependency cycle');
  return out;
}

/**
 * Executes a growing DAG of tasks. Tasks may be added while others run (incremental planning);
 * a task becomes runnable when all dependencies succeeded, its bound arguments resolve and
 * validate, and its resource locks are free. Every task passes policy (and approval when
 * required), runs with a timeout, has its output validated against the tool contract and is
 * verified against real system state before it counts as succeeded.
 */
export class RunExecutor {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly order: string[] = [];
  /** egress kinds the user approved in this run */
  private readonly consents = new Set<string>();
  private readonly outputs = new Map<string, unknown>();
  private readonly running = new Set<string>();
  private readonly locks = new LockManager();
  private readonly parentContext: Context;
  private sealed = false;
  private finished = false;
  private doneWaiters: Array<(r: ExecutorResult) => void> = [];
  private settledListeners = new Set<(rec: TaskRecord) => void>();

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly run: ExecutorRun,
  ) {
    this.parentContext = context.active();
    if (run.signal.aborted) this.onAbort();
    else run.signal.addEventListener('abort', () => this.onAbort(), { once: true });
  }

  /** Validates and adds a whole plan (any order; sorted topologically). */
  addPlan(plan: PlanInput): TaskRecord[] {
    const parsed = PlanSchema.safeParse(plan);
    if (!parsed.success) throw new TaskValidationError(`invalid plan: ${z.prettifyError(parsed.error)}`);
    const sorted = topoSort(parsed.data.tasks.map(withBindingDeps));
    // validate everything before adding anything
    const pending = new Map(sorted.map((t) => [t.id, t]));
    for (const t of sorted) this.validate(t, pending);
    return sorted.map((t) => this.addTask(t));
  }

  private validate(spec: TaskSpec, extraKnown?: Map<string, TaskSpec>): AnyTool {
    if (this.tasks.has(spec.id)) throw new TaskValidationError(`duplicate task id ${spec.id}`);
    const tool = this.deps.registry.get(spec.tool);
    if (!tool) throw new TaskValidationError(`unknown tool "${spec.tool}"`);
    for (const dep of spec.dependsOn) {
      if (!this.tasks.has(dep) && !extraKnown?.has(dep)) throw new TaskValidationError(`task ${spec.id} depends on unknown task ${dep}`);
    }
    const bindErrors = checkBindingRefs(spec);
    // a binding must name a field the source tool actually outputs (caught here, not at run time)
    for (const b of spec.bind) {
      const { taskId, path } = splitBindingSource(b.from);
      const source = this.tasks.get(taskId)?.tool ?? this.deps.registry.get(extraKnown?.get(taskId)?.tool ?? '');
      const fields = source ? missingOutputPath(source.output, path) : null;
      if (fields) bindErrors.push(`${b.from} does not exist: ${source?.id} outputs ${fields.join(', ')}`);
    }
    for (const c of spec.postconditions) {
      if (!['output_equals', 'output_count', 'output_truthy'].includes(c.kind) || !('path' in c)) continue;
      const fields = missingOutputPath(tool.output, conditionOutputPath(tool.output, c.path));
      if (fields) bindErrors.push(`postcondition ${c.path} does not exist: ${tool.id} outputs ${fields.join(', ')}`);
    }
    if (bindErrors.length) throw new TaskValidationError(`task ${spec.id}: ${bindErrors.join('; ')}`);
    if (spec.bind.length === 0) {
      const r = tool.args.safeParse(spec.args);
      if (!r.success) throw new TaskValidationError(`invalid args for ${spec.tool} (${spec.id}): ${z.prettifyError(r.error)}`);
    }
    return tool;
  }

  /** Adds one task. Dependencies must already be known, so the graph stays acyclic. */
  addTask(input: TaskSpecInput): TaskRecord {
    if (this.sealed) throw new TaskValidationError('no more tasks can be added to this run');
    const parsed = TaskSpecSchema.safeParse(input);
    if (!parsed.success) throw new TaskValidationError(`invalid task: ${z.prettifyError(parsed.error)}`);
    const spec = withBindingDeps(parsed.data);
    const tool = this.validate(spec);
    const rec: TaskRecord = { spec, tool, state: 'pending', attempt: 0 };
    this.tasks.set(spec.id, rec);
    this.order.push(spec.id);
    this.deps.checkpoint?.taskAdded(spec);
    this.deps.emit({ type: 'task_added', task: toView(rec) });
    this.deps.emit({ type: 'task_state', taskId: spec.id, state: 'pending', attempt: 0 });
    queueMicrotask(() => this.schedule());
    return rec;
  }

  /**
   * Re-creates a task that already succeeded in an earlier run from its checkpoint: the output is
   * restored (so bindings work) and the tool does not run again.
   */
  restore(input: TaskSpecInput, output: unknown, from: string): TaskRecord {
    const spec = withBindingDeps(TaskSpecSchema.parse(input));
    const tool = this.validate(spec);
    const parsed = tool.output.safeParse(output);
    if (!parsed.success) throw new TaskValidationError(`checkpoint output for ${spec.id} no longer matches ${tool.id}'s contract`);
    const rec: TaskRecord = { spec, tool, state: 'pending', attempt: 0, output: parsed.data };
    this.tasks.set(spec.id, rec);
    this.order.push(spec.id);
    this.outputs.set(spec.id, parsed.data);
    this.deps.checkpoint?.taskAdded(spec);
    this.deps.checkpoint?.taskSucceeded(spec, parsed.data);
    this.deps.emit({ type: 'task_added', task: toView(rec) });
    this.setState(rec, 'succeeded', { detail: `restored from checkpoint of ${from}` });
    return rec;
  }

  /** No more tasks will be added; the run completes when every task is terminal. */
  seal(): void {
    this.sealed = true;
    queueMicrotask(() => this.schedule());
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  records(): TaskRecord[] {
    return this.order.map((id) => this.tasks.get(id) as TaskRecord);
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  outputOf(id: string): unknown {
    return this.outputs.get(id);
  }

  onSettled(listener: (rec: TaskRecord) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /** Resolves when the given tasks are all terminal. */
  waitFor(ids: string[]): Promise<TaskRecord[]> {
    const check = () => ids.map((id) => this.tasks.get(id)).every((r) => r && TERMINAL_TASK_STATES.has(r.state));
    if (check()) return Promise.resolve(ids.map((id) => this.tasks.get(id) as TaskRecord));
    return new Promise((resolve) => {
      const off = this.onSettled(() => {
        if (check()) {
          off();
          resolve(ids.map((id) => this.tasks.get(id) as TaskRecord));
        }
      });
    });
  }

  done(): Promise<ExecutorResult> {
    if (this.finished) return Promise.resolve(this.result());
    return new Promise((resolve) => this.doneWaiters.push(resolve));
  }

  private result(): ExecutorResult {
    const recs = this.records();
    const count = (s: TaskState) => recs.filter((r) => r.state === s).length;
    return {
      tasks: recs,
      succeeded: count('succeeded'),
      failed: count('failed'),
      skipped: count('skipped'),
      denied: count('denied'),
      cancelled: count('cancelled'),
    };
  }

  private setState(rec: TaskRecord, state: TaskState, extra: { error?: string; detail?: string } = {}): void {
    rec.state = state;
    if (extra.error !== undefined) rec.error = extra.error;
    if (state === 'running' && rec.startedAt === undefined) rec.startedAt = Date.now();
    this.deps.emit({
      type: 'task_state',
      taskId: rec.spec.id,
      state,
      attempt: rec.attempt,
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    });
    if (TERMINAL_TASK_STATES.has(state)) {
      rec.endedAt = Date.now();
      this.deps.audit('task_finished', { tool: rec.spec.tool, state, error: rec.error, attempt: rec.attempt }, rec.spec.id);
      for (const l of this.settledListeners) l(rec);
    }
  }

  private onAbort(): void {
    // A streaming planner may still deliver a final chunk after cancellation.
    this.sealed = true;
    this.deps.approvals.denyRun(this.run.runId);
    for (const rec of this.records()) {
      if (rec.state === 'pending' || rec.state === 'ready') this.setState(rec, 'cancelled', { detail: 'run cancelled' });
    }
    this.checkDone();
  }

  private schedule(): void {
    if (this.finished) return;
    const settings = this.deps.settings();
    for (const id of this.order) {
      const rec = this.tasks.get(id) as TaskRecord;
      if (rec.state !== 'pending') continue;
      if (this.run.signal.aborted) {
        this.setState(rec, 'cancelled', { detail: 'run cancelled' });
        continue;
      }
      const deps = rec.spec.dependsOn.map((d) => this.tasks.get(d) as TaskRecord);
      const blocked = deps.find((d) => d.state === 'failed' || d.state === 'skipped' || d.state === 'denied' || d.state === 'cancelled');
      if (blocked) {
        this.setState(rec, 'skipped', { detail: `dependency ${blocked.spec.id} ${blocked.state}` });
        continue;
      }
      if (!deps.every((d) => d.state === 'succeeded')) continue;
      if (this.running.size >= settings.maxConcurrency) break;
      let args: unknown;
      try {
        const resolved = resolveArgs(rec.spec.args, rec.spec.bind, this.outputs);
        args = rec.tool.args.parse(resolved);
      } catch (e) {
        const msg = e instanceof BindingError ? e.message : `invalid arguments after binding: ${errorText(e)}`;
        this.setState(rec, 'failed', { error: msg });
        continue;
      }
      const keys = rec.tool.resources?.(args) ?? [];
      if (!this.locks.tryAcquire(id, keys)) continue;
      rec.args = args;
      this.running.add(id);
      this.setState(rec, 'ready');
      void context
        .with(this.parentContext, () => this.execute(rec, args))
        .catch((e) => {
          if (!TERMINAL_TASK_STATES.has(rec.state)) this.setState(rec, this.run.signal.aborted ? 'cancelled' : 'failed', { error: errorText(e) });
        })
        .finally(() => {
          this.running.delete(id);
          this.locks.release(id);
          this.schedule();
        });
    }
    this.checkDone();
  }

  private checkDone(): void {
    if (this.finished || !this.sealed || this.running.size > 0) return;
    if (!this.records().every((r) => TERMINAL_TASK_STATES.has(r.state))) return;
    this.finished = true;
    const result = this.result();
    for (const w of this.doneWaiters.splice(0)) w(result);
  }

  private makeContext(rec: TaskRecord, signal: AbortSignal): ToolContext {
    const taskId = rec.spec.id;
    return {
      runId: this.run.runId,
      taskId,
      signal,
      dryRun: this.run.dryRun,
      settings: this.deps.settings(),
      helper: this.deps.helper,
      models: this.deps.models(),
      providers: this.deps.providers,
      journal: { record: (op) => this.run.journal.record(taskId, op) },
      artifactsDir: this.run.artifactsDir,
      log: (level, message, data) => this.deps.emit({ type: 'log', level, message: `[${taskId}] ${message}`, ...(data !== undefined ? { data } : {}) }),
      progress: (text) => this.deps.emit({ type: 'narration', text: `[${taskId}] ${text}` }),
    };
  }

  private async decide(rec: TaskRecord, args: unknown): Promise<boolean> {
    this.run.signal.throwIfAborted();
    const settings = this.deps.settings();
    const decision = await withSpan(
      `policy ${rec.tool.id}`,
      OpenInferenceSpanKind.GUARDRAIL,
      { 'commandos.task_id': rec.spec.id, 'tool.name': rec.tool.id },
      async (span) => {
        const d = evaluatePolicy({ tool: rec.tool, args, settings, claimedRisk: rec.spec.claimedRisk, extraReadRoots: [this.run.artifactsDir], consents: this.consents });
        span.setAttributes({ 'commandos.policy.action': d.action, 'commandos.policy.risk': d.risk, [SemanticConventions.OUTPUT_VALUE]: spanJson(d) });
        return d;
      },
    );
    rec.policy = decision;
    this.run.signal.throwIfAborted();
    this.deps.emit({ type: 'policy', taskId: rec.spec.id, decision });
    this.deps.audit('policy_decision', { tool: rec.tool.id, decision }, rec.spec.id);
    if (decision.action === 'deny') {
      this.setState(rec, 'denied', { error: `blocked by policy: ${decision.reasons.join('; ')}` });
      return false;
    }
    if (decision.action === 'require_approval') {
      if (this.run.dryRun) {
        this.setState(rec, 'skipped', { detail: `dry run: would ask for approval (${decision.reasons.join('; ')})` });
        return false;
      }
      this.setState(rec, 'awaiting_approval', { detail: decision.reasons.join('; ') });
      const preview = rec.tool.preview?.(args) ?? { summary: rec.spec.title ?? rec.tool.title, details: [] };
      const outcome = await this.deps.approvals.request(
        {
          runId: this.run.runId,
          taskId: rec.spec.id,
          toolId: rec.tool.id,
          title: rec.spec.title ?? rec.tool.title,
          effectClass: decision.effectClass,
          risk: decision.risk,
          irreversible: decision.irreversible,
          reasons: decision.reasons,
          preview: { summary: preview.summary, details: preview.details, payload: args },
          explanation: decision.explanation,
        },
        settings.approvalTimeoutMs,
        this.run.signal,
      );
      this.deps.audit('approval', { tool: rec.tool.id, outcome }, rec.spec.id);
      if (outcome.decision !== 'approved') {
        this.setState(rec, outcome.by === 'cancel' ? 'cancelled' : 'denied', { error: `not approved (${outcome.by})` });
        return false;
      }
      // approving data egress once (e.g. screenshots to the vision model) covers the rest of the run
      if (rec.tool.egress) this.consents.add(rec.tool.egress);
    }
    return true;
  }

  private async attemptOnce(rec: TaskRecord, args: unknown): Promise<{ ok: true; output: unknown; checks: CheckResult[] } | { ok: false; error: unknown }> {
    const { spec, tool } = rec;
    rec.attempt += 1;
    this.setState(rec, 'running');
    const remaining = this.run.deadlineAt - Date.now();
    const timeoutMs = Math.max(1, Math.min(spec.timeoutMs ?? tool.defaultTimeoutMs, remaining));
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(new ToolError('timeout', `${tool.id} timed out after ${timeoutMs} ms`, true)), timeoutMs);
    const signal = AbortSignal.any([this.run.signal, timeoutCtrl.signal]);
    try {
      const output = await withSpan(
        `tool ${tool.id}`,
        OpenInferenceSpanKind.TOOL,
        {
          'tool.name': tool.id,
          'commandos.task_id': spec.id,
          'commandos.attempt': rec.attempt,
          'commandos.tier': tool.tier,
          [SemanticConventions.INPUT_VALUE]: spanJson(args),
        },
        async (span) => {
          const ctx = this.makeContext(rec, signal);
          const raw = await abortable(() => tool.run(args, ctx), signal);
          signal.throwIfAborted();
          const parsed = tool.output.safeParse(raw);
          if (!parsed.success) throw new ToolError('bad_output', `${tool.id} returned output that violates its contract: ${z.prettifyError(parsed.error)}`);
          span.setAttribute(SemanticConventions.OUTPUT_VALUE, spanJson(tool.summarize?.(parsed.data) ?? parsed.data));
          return parsed.data as unknown;
        },
      );
      rec.output = output;
      this.deps.emit({ type: 'task_output', taskId: spec.id, output: tool.summarize?.(output) ?? output, artifacts: [] });
      this.setState(rec, 'verifying');
      const checks = await abortable(() => withSpan('verify ' + tool.id, OpenInferenceSpanKind.EVALUATOR, { 'commandos.task_id': spec.id }, async (span) => {
        const ctx = this.makeContext(rec, signal);
        const builtIn = (await tool.verify?.(args, output, ctx)) ?? [];
        signal.throwIfAborted();
        const post = await evaluateConditions(spec.postconditions, output, this.deps.helper, signal);
        const all = [...builtIn, ...post];
        span.setAttributes({
          'eval.verified': all.every((c) => c.ok),
          'eval.checks_total': all.length,
          'eval.checks_passed': all.filter((c) => c.ok).length,
          [SemanticConventions.OUTPUT_VALUE]: spanJson(all.filter((c) => !c.ok)),
        });
        if (all.some((c) => !c.ok)) throw new VerificationError(all.filter((c) => !c.ok));
        return all;
      }), signal).catch((e) => {
        if (e instanceof VerificationError) this.deps.emit({ type: 'verification', taskId: spec.id, ok: false, checks: e.failed });
        throw e;
      });
      signal.throwIfAborted();
      return { ok: true, output, checks };
    } catch (error) {
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }

  private succeed(rec: TaskRecord, output: unknown, checks: CheckResult[], detail?: string): void {
    rec.checks = checks;
    if (checks.length) this.deps.emit({ type: 'verification', taskId: rec.spec.id, ok: true, checks });
    this.outputs.set(rec.spec.id, output);
    this.deps.checkpoint?.taskSucceeded(rec.spec, output);
    this.setState(rec, 'succeeded', detail ? { detail } : {});
  }

  private dependencyOutputs(rec: TaskRecord): Record<string, unknown> {
    return Object.fromEntries(rec.spec.dependsOn.map((d) => {
      const dep = this.tasks.get(d);
      return [d, dep?.output !== undefined ? (dep.tool.summarize?.(dep.output) ?? dep.output) : null];
    }));
  }

  private async execute(rec: TaskRecord, args: unknown): Promise<void> {
    const { spec, tool } = rec;
    if (!(await this.decide(rec, args))) return;
    this.run.signal.throwIfAborted();

    if (this.run.dryRun && rec.policy?.effectClass !== 'read') {
      const preview = tool.preview?.(args) ?? { summary: tool.title, details: [] };
      this.deps.emit({ type: 'task_output', taskId: spec.id, output: { dryRun: true, preview }, artifacts: [] });
      this.setState(rec, 'skipped', { detail: `dry run: ${preview.summary}` });
      return;
    }

    if (spec.preconditions.length) {
      const pre = await abortable(() => evaluateConditions(spec.preconditions, undefined, this.deps.helper, this.run.signal), this.run.signal);
      const bad = pre.filter((c) => !c.ok);
      if (bad.length) {
        this.deps.emit({ type: 'verification', taskId: spec.id, ok: false, checks: pre });
        this.setState(rec, 'failed', { error: `precondition failed: ${bad.map((c) => c.label).join('; ')}` });
        return;
      }
    }

    const maxAttempts = spec.retry?.maxAttempts ?? (tool.idempotent ? 2 : 1);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.run.signal.throwIfAborted();
      const r = await this.attemptOnce(rec, args);
      if (r.ok) {
        this.succeed(rec, r.output, r.checks);
        return;
      }
      if (this.run.signal.aborted) {
        this.setState(rec, 'cancelled', { error: 'cancelled' });
        return;
      }
      lastError = r.error;
      const canRetry = attempt < maxAttempts && (r.error as { code?: string } | undefined)?.code !== 'send_unverified'
        && !(r.error instanceof VerificationError) && (isTransient(r.error) || spec.retry !== undefined);
      if (!canRetry) break;
      this.deps.emit({ type: 'log', level: 'warn', message: `[${spec.id}] attempt ${attempt} failed: ${errorText(r.error)}; retrying` });
      await abortable(() => new Promise((resolve) => setTimeout(resolve, spec.retry?.backoffMs ?? 400 * attempt)), this.run.signal);
    }

    // selective recovery of this node only: deterministic alternatives, then model repair
    if (this.deps.recover) {
      const history: Array<{ label: string; error: string }> = [];
      let currentArgs = args;
      for (let i = 0; i < 4 && !this.run.signal.aborted; i++) {
        const errorInfo = { code: (lastError as { code?: string } | undefined)?.code, message: errorText(lastError) };
        const proposal = await abortable(() => this.deps.recover!({ task: rec, args: currentArgs, error: errorInfo, history, dependencyOutputs: this.dependencyOutputs(rec) }, this.run.signal), this.run.signal).catch((e) => {
          this.deps.emit({ type: 'log', level: 'warn', message: `[${spec.id}] recovery planner failed: ${errorText(e)}` });
          return null;
        });
        if (!proposal) break;
        const parsed = tool.args.safeParse(proposal.args);
        if (!parsed.success) {
          history.push({ label: proposal.label, error: `invalid arguments: ${z.prettifyError(parsed.error)}` });
          continue;
        }
        this.deps.emit({ type: 'narration', text: `[${spec.id}] recovering (${proposal.via}${proposal.tier ? `, ${proposal.tier} model` : ''}): ${proposal.label}` });
        this.deps.audit('recovery_attempt', { tool: tool.id, via: proposal.via, tier: proposal.tier, label: proposal.label, error: errorInfo.message }, spec.id);
        if (!(await this.decide(rec, parsed.data))) return;
        const r = await withSpan(
          `recover ${tool.id}`,
          OpenInferenceSpanKind.CHAIN,
          { 'commandos.task_id': spec.id, 'commandos.recovery.via': proposal.via, 'commandos.recovery.label': proposal.label, ...(proposal.tier ? { 'commandos.recovery.tier': proposal.tier } : {}) },
          () => this.attemptOnce(rec, parsed.data),
        );
        if (r.ok) {
          rec.args = parsed.data;
          this.succeed(rec, r.output, r.checks, `recovered via ${proposal.via}: ${proposal.label}`);
          return;
        }
        if (this.run.signal.aborted) break;
        lastError = r.error;
        currentArgs = parsed.data;
        history.push({ label: proposal.label, error: errorText(r.error) });
      }
    }
    if (this.run.signal.aborted) {
      this.setState(rec, 'cancelled', { error: 'cancelled' });
      return;
    }
    const errorCode = (lastError as { code?: unknown } | undefined)?.code;
    if (typeof errorCode === 'string') rec.errorCode = errorCode;
    this.setState(rec, 'failed', { error: errorText(lastError) });
  }
}
