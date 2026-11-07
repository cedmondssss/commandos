import { z } from 'zod';
import { IdSchema, TaskIdSchema } from './common';
import { EffectClassSchema, RiskLevelSchema } from './tool';

export const PolicyActionSchema = z.enum(['allow', 'require_approval', 'deny']);
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

/** Derived from trusted tool contracts and resolved arguments, never model-authored. */
export const ActionExplanationSchema = z.object({
  what: z.string(),
  targets: z.array(z.string()),
  dataFlow: z.string(),
  undo: z.string(),
  permission: z.string(),
});
export type ActionExplanation = z.infer<typeof ActionExplanationSchema>;

export const PolicyDecisionSchema = z.object({
  action: PolicyActionSchema,
  effectClass: EffectClassSchema,
  risk: RiskLevelSchema,
  irreversible: z.boolean(),
  reasons: z.array(z.string()),
  explanation: ActionExplanationSchema.optional(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const ApprovalPreviewSchema = z.object({
  summary: z.string(),
  details: z.array(z.string()),
  payload: z.unknown().optional(),
});

export const ApprovalRequestSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  taskId: TaskIdSchema,
  toolId: z.string(),
  title: z.string(),
  effectClass: EffectClassSchema,
  risk: RiskLevelSchema,
  irreversible: z.boolean(),
  reasons: z.array(z.string()),
  preview: ApprovalPreviewSchema,
  explanation: ActionExplanationSchema.optional(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.enum(['approve', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
