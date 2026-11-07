import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** Generic identifier (run ids, approval ids, procedure ids). */
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'invalid id');

/** Task ids are referenced from bindings (`t1.output.x`), so keep them identifier-like. */
export const TaskIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'task ids must start with a letter and contain only letters, digits, _ or -');

export const OkSchema = z.object({ ok: z.boolean() });

export const CommandSourceSchema = z.enum(['voice', 'text', 'replay', 'bench']);
export type CommandSource = z.infer<typeof CommandSourceSchema>;
