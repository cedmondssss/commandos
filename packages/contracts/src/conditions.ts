import { z } from 'zod';
import { JsonValueSchema } from './common';

export const CompareOpSchema = z.enum(['eq', 'gte', 'lte', 'gt', 'lt']);
export type CompareOp = z.infer<typeof CompareOpSchema>;

export function compare(op: CompareOp, actual: number, expected: number): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'gte':
      return actual >= expected;
    case 'lte':
      return actual <= expected;
    case 'gt':
      return actual > expected;
    case 'lt':
      return actual < expected;
  }
}

/**
 * Typed pre/postconditions. `output_*` conditions read the task's own validated output
 * using a dotted path (e.g. `moved.length` is expressed as output_count on `moved`).
 */
export const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file_exists'), path: z.string().min(1) }),
  z.object({ kind: z.literal('file_absent'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('dir_file_count'),
    dir: z.string().min(1),
    op: CompareOpSchema,
    value: z.number().int().min(0),
    extensions: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal('app_running'), bundleId: z.string().min(1) }),
  z.object({ kind: z.literal('ax_value_equals'), ref: z.string().min(1), value: z.string() }),
  z.object({ kind: z.literal('output_equals'), path: z.string(), value: JsonValueSchema }),
  z.object({ kind: z.literal('output_count'), path: z.string(), op: CompareOpSchema, value: z.number().int().min(0) }),
  z.object({ kind: z.literal('output_truthy'), path: z.string() }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const CheckResultSchema = z.object({
  label: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'file_exists':
      return `file exists: ${c.path}`;
    case 'file_absent':
      return `file absent: ${c.path}`;
    case 'dir_file_count':
      return `files in ${c.dir} ${c.op} ${c.value}${c.extensions ? ` (${c.extensions.join(',')})` : ''}`;
    case 'app_running':
      return `app running: ${c.bundleId}`;
    case 'ax_value_equals':
      return `UI value of ${c.ref} equals "${c.value}"`;
    case 'output_equals':
      return `output.${c.path} equals ${JSON.stringify(c.value)}`;
    case 'output_count':
      return `count(output.${c.path}) ${c.op} ${c.value}`;
    case 'output_truthy':
      return `output.${c.path} is set`;
  }
}
