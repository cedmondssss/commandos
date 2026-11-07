import { z } from 'zod';
import { CommandSourceSchema, IdSchema, TaskIdSchema } from './common';
import { CheckResultSchema } from './conditions';
import { ModelCallSchema } from './model';
import { ApprovalRequestSchema, PolicyDecisionSchema } from './policy';
import { ExecutionModeSchema, IntentSchema, RouteDecisionSchema } from './router';
import { TaskStateSchema, TaskViewSchema } from './task';

export const RunStateSchema = z.enum([
  'created',
  'routing',
  'planning',
  'running',
  'succeeded',
  'failed',
  'partial',
  'cancelled',
  'stopped',
  'undone',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'succeeded',
  'failed',
  'partial',
  'cancelled',
  'stopped',
  'undone',
]);

const base = { runId: IdSchema, at: z.number() };

export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_created'),
    ...base,
    command: z.string(),
    source: CommandSourceSchema,
    dryRun: z.boolean(),
  }),
  z.object({ type: z.literal('run_state'), ...base, state: RunStateSchema, summary: z.string().optional() }),
  z.object({ type: z.literal('route'), ...base, decision: RouteDecisionSchema, latencyMs: z.number() }),
  z.object({ type: z.literal('task_added'), ...base, task: TaskViewSchema }),
  z.object({
    type: z.literal('task_state'),
    ...base,
    taskId: TaskIdSchema,
    state: TaskStateSchema,
    attempt: z.number().int().min(0),
    error: z.string().optional(),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('task_output'),
    ...base,
    taskId: TaskIdSchema,
    output: z.unknown(),
    artifacts: z.array(z.string()),
  }),
  z.object({
    type: z.literal('verification'),
    ...base,
    taskId: TaskIdSchema,
    ok: z.boolean(),
    checks: z.array(CheckResultSchema),
  }),
  z.object({ type: z.literal('policy'), ...base, taskId: TaskIdSchema, decision: PolicyDecisionSchema }),
  z.object({ type: z.literal('approval_requested'), ...base, approval: ApprovalRequestSchema }),
  z.object({
    type: z.literal('approval_resolved'),
    ...base,
    approvalId: IdSchema,
    decision: z.enum(['approved', 'denied']),
    by: z.enum(['user', 'timeout', 'policy', 'cancel']),
  }),
  z.object({ type: z.literal('model_call'), ...base, call: ModelCallSchema }),
  z.object({
    type: z.literal('metric'),
    ...base,
    name: z.string(),
    value: z.number(),
    unit: z.enum(['ms', 'count', 'ratio']),
  }),
  z.object({
    type: z.literal('log'),
    ...base,
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    data: z.unknown().optional(),
  }),
  z.object({ type: z.literal('narration'), ...base, text: z.string() }),
  z.object({
    type: z.literal('undo'),
    ...base,
    ok: z.boolean(),
    steps: z.number().int(),
    failures: z.array(z.string()),
  }),
  z.object({ type: z.literal('trace'), ...base, traceId: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent['type'];

export const RunSummarySchema = z.object({
  runId: IdSchema,
  command: z.string(),
  source: CommandSourceSchema,
  state: RunStateSchema,
  dryRun: z.boolean(),
  createdAt: z.number(),
  finishedAt: z.number().optional(),
  mode: ExecutionModeSchema.optional(),
  intent: IntentSchema.optional(),
  taskCount: z.number().int(),
  succeededCount: z.number().int(),
  failedCount: z.number().int(),
  modelCalls: z.number().int(),
  undoable: z.boolean(),
  traceId: z.string().optional(),
  summary: z.string().optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunSnapshotSchema = z.object({
  summary: RunSummarySchema,
  events: z.array(RunEventSchema),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
