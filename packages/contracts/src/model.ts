import { z } from 'zod';

export const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/** fast = gpt-6-luna, main = gpt-6.1-sol, deep = gpt-6-astra (configurable). */
export const ModelTierSchema = z.enum(['fast', 'main', 'deep']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ModelCallSchema = z.object({
  purpose: z.string(),
  tier: ModelTierSchema,
  model: z.string(),
  effort: ReasoningEffortSchema,
  latencyMs: z.number(),
  ttftMs: z.number().optional(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  ok: z.boolean(),
  error: z.string().optional(),
  responseId: z.string().optional(),
  /** service tier that actually served the call (e.g. priority when Fast mode applied) */
  serviceTier: z.string().optional(),
});
export type ModelCall = z.infer<typeof ModelCallSchema>;
