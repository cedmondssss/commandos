import type { ModelTier, RouteDecision, Settings, TaskSpecInput } from '@commandos/contracts';
import { type ModelGateway, OpenInferenceSpanKind, SemanticConventions, spanJson, withSpan } from '@commandos/providers';
import type { ToolRegistry } from '@commandos/tools';
import type { Response, ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { ExecutorEvent, RunExecutor, TaskRecord } from '../executor';
import { getPath, splitBindingSource } from '../bindings';
import { contextBlock, PLANNER_INSTRUCTIONS } from './context';
import { plannerTools, stripNulls } from './functions';
import { StreamingArrayElements } from './stream-json';

export interface PlannerDeps {
  runId: string;
  signal: AbortSignal;
  executor: RunExecutor;
  registry: ToolRegistry;
  models: ModelGateway;
  settings: Settings;
  emit: (e: ExecutorEvent) => void;
  /** extra context lines (e.g. recalled procedures) */
  context?: string[];
  /**
   * Speculative planning: tool calls are held until this resolves. true releases them (the
   * router confirmed STANDARD), false means the run takes another path and the stream is aborted.
   */
  gate?: Promise<boolean>;
  /**
   * Model tier for the first turn (default: main, or deep for DEEP routes). A run planned on the
   * fast tier escalates to main as soon as a step fails or is rejected.
   */
  tier?: ModelTier;
}

const TaskSchema = z.object({
  task_id: z.string().min(1),
  title: z.string().optional(),
  depends_on: z.array(z.string()).default([]),
  bind: z.array(z.object({ arg: z.string(), from: z.string() })).default([]),
  call: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional(), args_json: z.string().optional() }),
});

const FinishSchema = z.object({ outcome: z.enum(['done', 'blocked', 'needs_user']), summary: z.string(), answer_from: z.string().optional() });

const ScheduleSchema = z.object({ tasks: z.array(z.unknown()).default([]), finish: FinishSchema.optional() });

type Entry = { taskId: string } | { task_id: string | null; error: string };

interface CallRecord {
  callId: string;
  name: string;
  /** scheduled tasks and rejected entries, in the order the model wrote them */
  entries: Entry[];
  /** number of task elements already taken from the argument stream */
  taken: number;
  /** the complete arguments were processed */
  done: boolean;
  error?: string;
}

const MAX_TURNS = 12;
const GITHUB_DELETE_FINALIZATION_TURNS = 2;
/** a single tool call longer than this is treated as runaway generation */
const MAX_CALL_CHARS = 30_000;
const MAX_OUTPUT_CHARS = 3500;

function compact(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  if (text.length <= MAX_OUTPUT_CHARS) return value;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}… [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

export function taskResult(rec: TaskRecord): Record<string, unknown> {
  return {
    task_id: rec.spec.id,
    state: rec.state,
    ...(rec.error ? { error: rec.error } : {}),
    ...(rec.errorCode ? { error_code: rec.errorCode } : {}),
    ...(rec.output !== undefined ? { output: compact(rec.tool.summarize?.(rec.output) ?? rec.output) } : {}),
    ...(rec.checks?.length ? { verified: rec.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`).slice(0, 20) } : {}),
  };
}

/** The output a finish call points at as the answer (`t2.output.answer`), as display text. */
export function resolveAnswer(from: string, executor: RunExecutor): string | null {
  if (!/^[A-Za-z][\w-]*\.output(?:[.[]|$)/.test(from)) return null;
  const { taskId, path } = splitBindingSource(from);
  if (executor.get(taskId)?.state !== 'succeeded') return null;
  let value: unknown;
  try {
    value = getPath(executor.outputOf(taskId), path);
  } catch {
    return null;
  }
  // only text counts as an answer; lists and raw extraction results are data, not answers
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  const text = String(value).trim();
  return text ? text.slice(0, 2000) : null;
}

function entryResult(entry: Entry, executor: RunExecutor): Record<string, unknown> {
  if (!('taskId' in entry)) return { task_id: entry.task_id, state: 'rejected', error: entry.error };
  const rec = executor.get(entry.taskId);
  return rec ? taskResult(rec) : { task_id: entry.taskId, state: 'rejected', error: 'task was not scheduled' };
}

function githubSettingsLocation(page: { url?: string | null }): { owner: string; repo: string; fullName: string } | null {
  try {
    const url = new URL(page.url ?? '');
    const match = /^\/([^/]+)\/([^/]+)\/settings\/?$/.exec(url.pathname);
    if (url.hostname !== 'github.com' || !match) return null;
    const owner = decodeURIComponent(match[1]!);
    const repo = decodeURIComponent(match[2]!);
    const fullName = `${owner}/${repo}`;
    return { owner, repo, fullName };
  } catch { return null; }
}

function githubSettingsTarget(page: { url?: string | null; text?: string }) {
  const target = githubSettingsLocation(page);
  return target && page.text?.includes(`To confirm, type "${target.fullName}"`) ? target : null;
}

/** Give a long GitHub deletion flow a small finalization reserve only after the exact
 * confirmation name is filled and the final control is observed. General plan limits stay 12. */
function pendingGithubDeletion(command: string, records: TaskRecord[]): boolean {
  if (!/\bdelete\b/i.test(command) || !/\brepositor(?:y|ies)\b/i.test(command)) return false;
  const pageRecord = [...records].reverse().find((record) => record.spec.tool === 'browser.readPage' && record.state === 'succeeded');
  if (!pageRecord) return false;
  const target = githubSettingsTarget(pageRecord.output as { url?: string; text?: string });
  if (!target) return false;
  const typed = [...records].reverse().find((record) => record.spec.tool === 'ui.setValue' && record.state === 'succeeded' && (record.output as { readBack?: string } | undefined)?.readBack === target.fullName);
  if (!typed) return false;
  const buttonRecord = [...records].reverse().find((record) => record.spec.tool === 'ui.find' && record.state === 'succeeded');
  const elements = (buttonRecord?.output as { elements?: Array<{ label?: string | null; enabled?: boolean | null }> } | undefined)?.elements ?? [];
  return elements.some((element) => element.label?.trim().toLowerCase() === 'delete this repository' && element.enabled === true);
}

function finalGithubDeletePress(records: TaskRecord[]): TaskRecord | null {
  const press = [...records].reverse().find((record) => record.spec.tool === 'ui.press' && record.state === 'succeeded' && (record.spec.args as { expectLabel?: string }).expectLabel?.trim().toLowerCase() === 'delete this repository');
  if (!press) return null;
  const pressIndex = records.indexOf(press);
  const prior = records.slice(0, pressIndex);
  const page = [...prior].reverse().find((record) => record.spec.tool === 'browser.readPage' && record.state === 'succeeded');
  const target = githubSettingsLocation((page?.output ?? {}) as { url?: string });
  if (!target) return null;
  const typedExactName = prior.some((record) => record.spec.tool === 'ui.setValue' && record.state === 'succeeded' && (record.output as { readBack?: string } | undefined)?.readBack === target.fullName);
  const enabled = prior.some((record) => record.spec.tool === 'ui.find' && record.state === 'succeeded' &&
    ((record.output as { elements?: Array<{ label?: string; enabled?: boolean }> })?.elements ?? []).some((el) => el.label === 'Delete this repository' && el.enabled === true));
  return typedExactName && enabled ? press : null;
}

/** Resolve only failed pre-click attempts which were replaced on the same verified repository. */
export function resolvedGithubAttempts(records: TaskRecord[], fullName: string): string[] {
  const resolved = new Map<string, string>();
  const locationBefore = (index: number) => githubSettingsLocation((records.slice(0, index).reverse().find((r) => r.spec.tool === 'browser.readPage' && r.state === 'succeeded')?.output ?? {}) as { url?: string })?.fullName;
  for (const [index, record] of records.entries()) {
    if (record.state !== 'failed' || record.spec.tool !== 'ui.press' || !['not_visible', 'not_found', 'stale_ref', 'disabled_element', 'focus_changed', 'label_mismatch'].includes(record.errorCode ?? '')) continue;
    if (locationBefore(index) !== fullName) continue;
    const args = (record.args ?? record.spec.args) as { bundleId?: string; expectLabel?: string };
    if (args.bundleId !== 'com.google.Chrome') continue;
    const replacement = records.find((later, laterIndex) => {
      const next = (later.args ?? later.spec.args) as { bundleId?: string; expectLabel?: string };
      return laterIndex > index && later.state === 'succeeded' && later.spec.tool === 'ui.press' && locationBefore(laterIndex) === fullName && next.bundleId === args.bundleId && next.expectLabel === args.expectLabel;
    });
    if (replacement) resolved.set(record.spec.id, replacement.spec.id);
  }
  for (const record of records) {
    if (record.state !== 'skipped' || record.tool.effectClass !== 'read') continue;
    const replacementParents = record.spec.dependsOn.map((id) => resolved.get(id)).filter((id): id is string => Boolean(id));
    if (replacementParents.length && records.some((r) => r.state === 'succeeded' && r.spec.tool === record.spec.tool && replacementParents.some((id) => r.spec.dependsOn.includes(id)))) resolved.set(record.spec.id, 'verified replacement observation');
  }
  return [...resolved.keys()];
}

export function githubDeleteConfirmed(page: { url?: string | null; title?: string; text?: string }, target: { owner: string; repo: string }): boolean {
  const text = page.text ?? '';
  if (text.toLowerCase().includes(`${target.owner}/${target.repo}`.toLowerCase()) && /\b(?:repository|repo)\s+(?:was|has been)\s+deleted\b|\bdeleted successfully\b|\bsuccessfully deleted\b/i.test(text)) return true;
  try {
    const url = new URL(page.url ?? '');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const sameRepo = url.hostname === 'github.com' && parts[0]?.toLowerCase() === target.owner.toLowerCase() && parts[1]?.toLowerCase() === target.repo.toLowerCase();
    return sameRepo && /\b(?:404|page not found|repository not found|this repository does not exist)\b/i.test(`${page.title ?? ''}\n${text}`);
  } catch { return false; }
}

/**
 * STANDARD mode: gpt-6.1-sol plans incrementally through the batch `schedule` function. Each task
 * is validated and handed to the executor the moment its JSON object finishes streaming, so
 * execution overlaps generation. Results are fed back each turn until the model finishes (or the
 * turn budget runs out).
 */
export async function runStandardPlanner(command: string, decision: RouteDecision | null, deps: PlannerDeps): Promise<{ outcome: string; summary: string; turns: number; resolvedTaskIds?: string[] }> {
  const { executor, registry, models, emit } = deps;
  const { tools, toolIds, jsonArgs } = plannerTools(registry);
  const input: ResponseInputItem[] = [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `${contextBlock(deps.settings, [...(decision ? [`Router: ${decision.mode}/${decision.intent} — ${decision.reason}`] : []), ...(deps.context ?? [])])}\n\nCommand: ${command}`,
        },
      ],
    },
  ];
  let finish: z.infer<typeof FinishSchema> | null = null;
  let turns = 0;
  let turnLimit = MAX_TURNS;
  let githubDeletionVerified = false;
  let verifiedGithubName: string | null = null;
  let retriedAfterFailure = false;
  let tier: ModelTier = deps.tier ?? (decision?.mode === 'deep' ? 'deep' : 'main');
  // speculative mode: hold tasks until the router confirms this is a STANDARD command
  let gateOpen: boolean | null = deps.gate ? null : true;
  const held: Array<() => void> = [];
  deps.gate?.then((ok) => {
    gateOpen = ok;
    if (ok) for (const run of held.splice(0)) run();
    else held.length = 0;
  });
  const release = (fn: () => void) => {
    if (gateOpen === true) fn();
    else if (gateOpen === null) held.push(fn);
  };

  /** set per turn: stops the turn's stream as soon as a task is rejected (fail fast) */
  let onRejected: (reason: string) => void = () => {};
  const scheduleTask = (call: CallRecord, raw: unknown) => {
    const rawId = raw && typeof raw === 'object' && typeof (raw as { task_id?: unknown }).task_id === 'string' ? (raw as { task_id: string }).task_id : null;
    const reject = (error: string) => {
      call.entries.push({ task_id: rawId, error });
      emit({ type: 'log', level: 'warn', message: `planner proposed an invalid task${rawId ? ` (${rawId})` : ''}: ${error}` });
      onRejected(`task ${rawId ?? '(no id)'} was rejected: ${error}`);
    };
    const t = TaskSchema.safeParse(stripNulls(raw));
    if (!t.success) return reject(`invalid task: ${z.prettifyError(t.error)}`);
    const toolId = toolIds.get(t.data.call.tool);
    if (!toolId) return reject(`unknown tool ${t.data.call.tool}`);
    let args: unknown = t.data.call.args ?? {};
    if (jsonArgs.has(t.data.call.tool)) {
      try {
        args = stripNulls(JSON.parse(t.data.call.args_json ?? '{}'));
      } catch {
        return reject('args_json is not valid JSON');
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return reject('args_json must encode a JSON object');
    }
    const spec: TaskSpecInput = {
      id: t.data.task_id,
      tool: toolId,
      args: args as Record<string, unknown>,
      dependsOn: t.data.depends_on,
      bind: t.data.bind,
      ...(t.data.title ? { title: t.data.title.slice(0, 200) } : {}),
    };
    try {
      executor.addTask(spec);
      call.entries.push({ taskId: spec.id });
    } catch (e) {
      reject(e instanceof Error ? e.message : String(e));
    }
  };

  for (let turn = 0; turn < turnLimit && !finish; turn++) {
    if (deps.signal.aborted) break;
    turns = turn + 1;
    const calls: CallRecord[] = [];
    const byItem = new Map<string, { call: CallRecord; elements: StreamingArrayElements | null; chars: number }>();
    let narration = '';
    // fail fast: a rejected task (or runaway output) ends the stream at once instead of letting
    // the model keep generating around it; the next turn starts from the actual state
    const turnCtrl = new AbortController();
    let streaming = true;
    let stoppedEarly: string | null = null;
    onRejected = (reason) => {
      if (!streaming || stoppedEarly) return;
      stoppedEarly = reason;
      turnCtrl.abort(new Error(`stopped early: ${reason}`));
    };

    const callFor = (name: string, callId: string): CallRecord => {
      const existing = calls.find((c) => c.callId === callId);
      if (existing) return existing;
      const call: CallRecord = { callId, name, entries: [], taken: 0, done: false };
      calls.push(call);
      return call;
    };

    /** The full arguments of a call: tasks not already taken from the stream, then finish. */
    const complete = (call: CallRecord, argsText: string) => {
      if (call.done) return;
      call.done = true;
      let parsed: unknown;
      try {
        parsed = stripNulls(JSON.parse(argsText));
      } catch {
        call.error = 'arguments were not valid JSON';
        return;
      }
      if (call.name === 'finish') {
        const f = FinishSchema.safeParse(parsed);
        if (f.success) finish = f.data;
        else call.error = 'invalid finish arguments';
        return;
      }
      if (call.name !== 'schedule') {
        call.error = `unknown function ${call.name}`;
        return;
      }
      const sched = ScheduleSchema.safeParse(parsed);
      if (!sched.success) {
        call.error = `invalid schedule arguments: ${z.prettifyError(sched.error)}`;
        return;
      }
      for (const raw of sched.data.tasks.slice(call.taken)) {
        call.taken++;
        release(() => scheduleTask(call, raw));
      }
      if (sched.data.finish) {
        const f = sched.data.finish;
        release(() => {
          finish = f;
        });
      }
    };

    const onEvent = (ev: ResponseStreamEvent) => {
      if (ev.type === 'response.output_item.added' && ev.item.type === 'function_call') {
        const call = callFor(ev.item.name, ev.item.call_id);
        byItem.set(ev.item.id ?? ev.item.call_id, { call, elements: ev.item.name === 'schedule' ? new StreamingArrayElements('tasks') : null, chars: 0 });
      } else if (ev.type === 'response.function_call_arguments.delta') {
        const entry = byItem.get(ev.item_id);
        if (!entry) return;
        entry.chars += ev.delta.length;
        if (entry.chars > MAX_CALL_CHARS) return onRejected(`the ${entry.call.name} call grew past ${MAX_CALL_CHARS} characters`);
        if (!entry.elements) return;
        for (const text of entry.elements.feed(ev.delta)) {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            entry.elements = null; // the complete arguments will carry this task and the rest
            return;
          }
          entry.call.taken++;
          release(() => scheduleTask(entry.call, raw));
        }
      } else if (ev.type === 'response.function_call_arguments.done') {
        const entry = byItem.get(ev.item_id);
        if (entry) complete(entry.call, ev.arguments);
      } else if (ev.type === 'response.output_text.delta') {
        narration += ev.delta;
        const cut = narration.search(/[.!?]\s|\n/);
        if (cut >= 0) {
          const sentence = narration.slice(0, cut + 1).trim();
          narration = narration.slice(cut + 1);
          if (sentence) emit({ type: 'narration', text: sentence });
        }
      }
    };

    let response: Response | null = null;
    try {
      response = await withSpan(
        `plan turn ${turn + 1}`,
        OpenInferenceSpanKind.CHAIN,
        { 'commandos.planner': 'standard', 'commandos.turn': turn + 1, 'commandos.planner.tier': tier },
        async (span) => {
          try {
            const r = await models.stream({
              tier,
              purpose: `plan_turn_${turn + 1}`,
              runId: deps.runId,
              signal: AbortSignal.any([deps.signal, turnCtrl.signal]),
              instructions: PLANNER_INSTRUCTIONS,
              input,
              tools,
              cacheKey: 'commandos.planner.v2',
              // a turn normally needs a few hundred tokens; the cap bounds runaway generation
              maxOutputTokens: 6_000,
              // two streams race to the first token; the loser is cancelled before it can act
              hedge: true,
              onEvent,
            });
            return r.response;
          } finally {
            span.setAttribute(
              SemanticConventions.OUTPUT_VALUE,
              spanJson({
                ...(stoppedEarly ? { stoppedEarly } : {}),
                calls: calls.map((c) => ({ name: c.name, tasks: c.entries.map((e) => ('taskId' in e ? e.taskId : `rejected: ${e.error}`)), error: c.error })),
              }),
            );
          }
        },
      );
    } catch (e) {
      if (!stoppedEarly || deps.signal.aborted) throw e;
    } finally {
      streaming = false;
    }
    if (narration.trim()) emit({ type: 'narration', text: narration.trim() });
    if (deps.gate && !(await deps.gate)) throw new Error('speculative planning cancelled: the command took another path');

    if (!response) {
      // stopped early: let what was scheduled finish, then re-plan from the real state
      const scheduled = calls.flatMap((c) => c.entries.flatMap((e) => ('taskId' in e ? [e.taskId] : [])));
      if (scheduled.length) await executor.waitFor(scheduled);
      const results = calls.flatMap((c) => c.entries.map((e) => entryResult(e, executor)));
      input.push({
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `CommandOS stopped your last call early: ${stoppedEarly}. Results of the tasks it contained: ${JSON.stringify(results)}. Task ids already used: ${executor
              .records()
              .map((r) => r.spec.id)
              .join(', ') || 'none'}. Schedule what is still needed (new task ids) and finish.`,
          },
        ],
      });
      finish = null;
      emit({ type: 'narration', text: `Planner: stopped a planning turn early (${stoppedEarly})` });
      if (tier === 'fast') {
        tier = 'main';
        emit({ type: 'narration', text: 'Planner: the main model takes over planning' });
      }
      continue;
    }

    // any function calls not seen through streaming events (defensive)
    for (const item of response.output) {
      if (item.type === 'function_call') complete(callFor(item.name, item.call_id), item.arguments);
    }
    input.push(...(response.output as ResponseInputItem[]));
    if (calls.length === 0) {
      const text = response.output_text?.trim();
      finish = { outcome: 'done', summary: text || 'Planner returned no actions.' };
      break;
    }
    const taskIds = calls.flatMap((c) => c.entries.flatMap((e) => ('taskId' in e ? [e.taskId] : [])));
    if (taskIds.length) await executor.waitFor(taskIds);
    const dependsOn = (taskId: string, ancestor: string, seen = new Set<string>()): boolean => {
      if (seen.has(taskId)) return false;
      seen.add(taskId);
      return (executor.get(taskId)?.spec.dependsOn ?? []).some((id) => id === ancestor || dependsOn(id, ancestor, seen));
    };
    const uncertainSend = executor.records().find((r) => r.state === 'failed' && r.errorCode === 'send_unverified');
    if (uncertainSend) {
      // Only the user can resolve whether an unacknowledged external action happened.
      // Another planning turn adds latency and could schedule a duplicate send.
      finish = { outcome: 'needs_user', summary: uncertainSend.error ?? 'Gmail did not confirm sending. Check Sent before retrying.' };
      break;
    }
    const deletePress = finalGithubDeletePress(executor.records());
    if (deletePress) {
      const verify = [...executor.records()].reverse().find((record) => record.spec.tool === 'browser.readPage' && record.state === 'succeeded' &&
        (dependsOn(record.spec.id, deletePress.spec.id) || (record.startedAt !== undefined && deletePress.endedAt !== undefined && record.startedAt >= deletePress.endedAt)));
      if (verify) {
        const page = verify.output as { url?: string | null; title?: string; text?: string };
        const before = executor.records().slice(0, executor.records().indexOf(deletePress)).reverse().find((record) => record.spec.tool === 'browser.readPage' && record.state === 'succeeded');
        const target = githubSettingsLocation((before?.output ?? {}) as { url?: string });
        if (target && githubDeleteConfirmed(page, target)) {
          githubDeletionVerified = true;
          verifiedGithubName = target.fullName;
          finish = { outcome: 'done', summary: `GitHub confirmed ${target.fullName} was deleted.` };
          break;
        }
        if (!target || !githubSettingsTarget(page)) {
          finish = { outcome: 'needs_user', summary: `GitHub did not confirm that ${target?.fullName ?? 'the repository'} was deleted. The final button press was dispatched, but the repository may still exist. Check GitHub before trying again. ${page.text?.trim().slice(0, 300) ?? ''}` };
          break;
        }
      }
    }
    // A failed observation after a dispatched external action is not permission to try again.
    const dispatched = executor.records().filter((record) => record.spec.tool === 'ui.press' && record.state === 'succeeded' && record.policy?.effectClass === 'external');
    const unconfirmed = taskIds.map((id) => executor.get(id)).find((record) => record?.state === 'failed' && record.spec.tool === 'browser.readPage' && record.errorCode === 'page_not_ready' && dispatched.some((action) => dependsOn(record.spec.id, action.spec.id)));
    if (unconfirmed) {
      finish = { outcome: 'needs_user', summary: `The UI action was dispatched, but its external result was not confirmed. Check the current page before retrying. ${unconfirmed.error ?? ''}` };
      break;
    }
    // finish.answer_from must name text that answers the question; anything else costs a turn
    let finishError: string | null = null;
    const pending = finish as z.infer<typeof FinishSchema> | null;
    if (pending?.answer_from && !resolveAnswer(pending.answer_from, executor)) {
      finishError = `finish not accepted: answer_from ${pending.answer_from} did not resolve to text (use e.g. vision_ask output.answer or ai_write output.text, or write the answer in summary)`;
      finish = null;
    }
    for (const call of calls) {
      const output =
        call.name === 'schedule'
          ? { tasks: call.entries.map((e) => entryResult(e, executor)), ...(call.error ? { error: call.error } : {}), ...(finishError ? { finish: finishError } : {}) }
          : { ok: !call.error && !finishError, ...(call.error ? { error: call.error } : {}), ...(finishError ? { finish: finishError } : {}) };
      input.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output) });
    }
    // finish came with tasks that then failed or were rejected: give the model one chance to react
    const failedThisTurn =
      finishError !== null ||
      calls.some((c) => c.error || c.entries.some((e) => !('taskId' in e) || ['failed', 'denied', 'skipped'].includes(executor.get(e.taskId)?.state ?? '')));
    if (failedThisTurn && tier === 'fast') {
      tier = 'main';
      emit({ type: 'narration', text: 'Planner: a step failed; the main model takes over planning' });
    }
    if (finish && failedThisTurn && !retriedAfterFailure) {
      retriedAfterFailure = true;
      finish = null;
      emit({ type: 'narration', text: 'Planner: some steps failed after finish was proposed; re-planning around them' });
    }
    if (turns === MAX_TURNS && pendingGithubDeletion(command, executor.records())) {
      turnLimit = MAX_TURNS + GITHUB_DELETE_FINALIZATION_TURNS;
      finish = null;
      input.push({ role: 'user', content: [{ type: 'input_text', text: 'The exact GitHub repository confirmation is already filled and the final Delete this repository control was just observed. Do not create another repository, reopen the settings, or type the name again. Use one final approved press, then re-read the GitHub page. Report deletion only if the resulting page explicitly confirms deletion or shows that this same repository is unavailable.' }] });
      emit({ type: 'narration', text: 'Planner: the exact GitHub repository confirmation is filled; reserving turns to finish and verify deletion.' });
    }
  }
  if (!githubDeletionVerified && pendingGithubDeletion(command, executor.records())) {
    const pageRecord = [...executor.records()].reverse().find((record) => record.spec.tool === 'browser.readPage' && record.state === 'succeeded');
    const target = githubSettingsTarget((pageRecord?.output ?? {}) as { url?: string; text?: string });
    finish = { outcome: 'needs_user', summary: `GitHub still shows the deletion confirmation for ${target?.fullName ?? 'the repository'}. The final deletion has not been verified; check the page before retrying.` };
  }
  executor.seal();
  const records = executor.records();
  const latestPage = [...records].reverse().find((record) => record.spec.tool === 'browser.readPage' && record.state === 'succeeded')?.output as { title?: string; url?: string; text?: string } | undefined;
  const blockedInput = [...records].reverse().find((record) => record.state === 'failed' && ['disabled_element', 'input_unverified', 'focus_changed'].includes(record.errorCode ?? ''));
  const external = records.some((record) => record.policy?.effectClass === 'external');
  const exhausted: z.infer<typeof FinishSchema> = blockedInput || external
    ? { outcome: 'needs_user', summary: `Stopped after ${turns} planning turns. ${blockedInput?.error ?? 'The requested external change was not verified.'}${latestPage ? ` Last observed page: ${latestPage.title ?? ''} (${latestPage.url ?? ''}). ${latestPage.text?.trim().slice(0, 400) ?? ''}` : ''} Check the current state before continuing.` }
    : { outcome: 'blocked', summary: `stopped after ${turns} planning turns without finishing` };
  const final: z.infer<typeof FinishSchema> = finish ?? exhausted;
  // a question answered by a task output: show that output instead of a turn spent repeating it
  const answer = final.answer_from ? resolveAnswer(final.answer_from, executor) : null;
  const summary = answer ?? final.summary;
  emit({ type: 'narration', text: `Planner: ${summary}` });
  return { outcome: final.outcome, summary, turns, ...(verifiedGithubName ? { resolvedTaskIds: resolvedGithubAttempts(records, verifiedGithubName) } : {}) };
}
