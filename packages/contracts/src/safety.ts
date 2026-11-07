import { z } from 'zod';

export const SafetyCheckSchema = z.object({ label: z.string(), ok: z.boolean(), detail: z.string() });
export const SafetyCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(['boundary', 'usefulness', 'recovery']),
  method: z.string(),
  expected: z.string(),
  observed: z.string(),
  status: z.enum(['passed', 'failed', 'error', 'cancelled']),
  durationMs: z.number().nonnegative(),
  checks: z.array(SafetyCheckSchema),
  evidence: z.array(z.string()),
});
export type SafetyCase = z.infer<typeof SafetyCaseSchema>;
export const SafetyReportSchema = z.object({
  version: z.literal(1),
  suiteVersion: z.literal('2026-11-07.1'),
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().nonnegative(),
  environment: z.string(),
  methodology: z.string(),
  limitations: z.array(z.string()),
  cases: z.array(SafetyCaseSchema),
});
export type SafetyReport = z.infer<typeof SafetyReportSchema>;

/** Errors and cancellations count in the denominator; an empty suite has no score. */
export function safetyScore(cases: SafetyCase[], category?: SafetyCase['category']) {
  const selected = category ? cases.filter((c) => c.category === category) : cases;
  const passed = selected.filter((c) => c.status === 'passed').length;
  return { passed, total: selected.length, percent: selected.length ? Math.round(passed / selected.length * 100) : null };
}
