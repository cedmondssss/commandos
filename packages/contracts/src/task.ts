import { z } from 'zod';
import { TaskIdSchema } from './common';
import { ConditionSchema } from './conditions';
import { EffectClassSchema, RiskLevelSchema, ToolTierSchema } from './tool';

/**
 * Binds a task argument to the output of an upstream task, resolved at dispatch time.
 * `arg` is a dotted path into args (numeric segments index arrays, e.g. `paths.0`; the bracket
 * form `where[0].value` is normalized to `where.0.value`); `from` is `<taskId>.output[.path]`
 * with optional `[n]` indexes and `[*].field` projections.
 */
export const BindingSchema = z.object({
  arg: z
    .string()
    .min(1)
    .max(200)
    .transform((s) => s.replace(/\[(\d+)\]/g, '.$1'))
    .pipe(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.([A-Za-z_][A-Za-z0-9_]*|\d+))*$/, 'arg must be a dotted path like items or paths.0')),
  from: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*\.output(?:[.[].*)?$/, 'from must look like <taskId>.output[.path]'),
});
export type Binding = z.infer<typeof BindingSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5),
  backoffMs: z.number().int().min(0).max(60_000),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const TaskSpecSchema = z.object({
  id: TaskIdSchema,
  tool: z.string().min(1).max(100),
  title: z.string().max(200).optional(),
  args: z.record(z.string(), z.unknown()),
  dependsOn: z.array(TaskIdSchema).max(50).default([]),
  bind: z.array(BindingSchema).max(20).default([]),
  preconditions: z.array(ConditionSchema).max(20).default([]),
  postconditions: z.array(ConditionSchema).max(20).default([]),
  timeoutMs: z.number().int().min(100).max(1_800_000).optional(),
  retry: RetryPolicySchema.optional(),
  /** Risk the planner believes the task carries. Advisory only — policy recomputes. */
  claimedRisk: RiskLevelSchema.optional(),
});
export type TaskSpec = z.output<typeof TaskSpecSchema>;
export type TaskSpecInput = z.input<typeof TaskSpecSchema>;

export const PlanSchema = z.object({
  goal: z.string().min(1).max(2000),
  tasks: z.array(TaskSpecSchema).min(1).max(200),
  deadlineMs: z.number().int().min(1_000).max(3_600_000).optional(),
  assumptions: z.array(z.string().max(500)).max(20).default([]),
});
export type Plan = z.output<typeof PlanSchema>;
export type PlanInput = z.input<typeof PlanSchema>;

export const TaskStateSchema = z.enum([
  'pending',
  'ready',
  'awaiting_approval',
  'running',
  'verifying',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'denied',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'denied',
]);

/** Task as presented to the UI: spec plus static tool metadata. */
export const TaskViewSchema = z.object({
  id: TaskIdSchema,
  tool: z.string(),
  title: z.string(),
  args: z.record(z.string(), z.unknown()),
  dependsOn: z.array(TaskIdSchema),
  bind: z.array(BindingSchema),
  postconditions: z.array(ConditionSchema),
  tier: ToolTierSchema,
  effectClass: EffectClassSchema,
  risk: RiskLevelSchema,
});
export type TaskView = z.infer<typeof TaskViewSchema>;
