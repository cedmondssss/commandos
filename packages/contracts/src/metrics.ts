import { z } from 'zod';
import { ExecutionModeSchema } from './router';

/** Per-run performance + correctness metrics derived from the run event stream. */
export const RunMetricsSchema = z.object({
  runId: z.string(),
  mode: ExecutionModeSchema.optional(),
  /** voice only: first audio of the utterance → committed transcript */
  speechToTranscriptMs: z.number().optional(),
  routerMs: z.number().optional(),
  /** time spent waiting on planning model calls before the first task was scheduled */
  planningMs: z.number().optional(),
  /** run created → first tool started executing */
  timeToFirstActionMs: z.number().optional(),
  totalMs: z.number().optional(),
  modelCalls: z.number().int(),
  modelLatencyMs: z.number(),
  toolCalls: z.number().int(),
  toolLatencyMs: z.record(z.string(), z.number()),
  tasksSucceeded: z.number().int(),
  tasksFailed: z.number().int(),
  tasksVerified: z.number().int(),
  retries: z.number().int(),
  recoveredTasks: z.number().int(),
  /** model calls made on a FAST run of a known deterministic procedure */
  unnecessaryModelCalls: z.number().int(),
  verifiedSuccess: z.boolean(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;
