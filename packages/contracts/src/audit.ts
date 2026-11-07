import { z } from 'zod';

/** Append-only, hash-chained audit record (hash = sha256(prevHash + canonical JSON of the record body)). */
export const AuditRecordSchema = z.object({
  seq: z.number().int().min(0),
  at: z.number(),
  kind: z.string(),
  actor: z.enum(['user', 'agent', 'policy', 'system']),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  data: z.unknown(),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
