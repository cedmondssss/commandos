import { z } from 'zod';

export const ExecutionModeSchema = z.enum(['fast', 'standard', 'deep']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const IntentSchema = z.enum([
  'organize_screenshots',
  'repo_test_fix',
  'web_research_form',
  'send_email',
  'replay_procedure',
  'app_control',
  'file_operations',
  'control',
  'general',
]);
export type Intent = z.infer<typeof IntentSchema>;

export const RouteDecisionSchema = z.object({
  mode: ExecutionModeSchema,
  intent: IntentSchema,
  confidence: z.number().min(0).max(1),
  /** How the decision was made: local grammar, recalled procedure, or the fast router model. */
  via: z.enum(['grammar', 'procedure', 'router']),
  reason: z.string(),
  slots: z.record(z.string(), z.unknown()),
  procedureId: z.string().optional(),
  needsFullPreview: z.boolean(),
});
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
