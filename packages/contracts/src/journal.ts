import { z } from 'zod';
import { IdSchema, TaskIdSchema } from './common';

/**
 * Inverse operations recorded by reversible local tools. Undo replays them in reverse order
 * and checks each precondition (e.g. the moved file is still where we put it) before acting.
 * External effects never produce undo ops: they cannot be undone.
 */
export const UndoOpSchema = z.discriminatedUnion('kind', [
  /** A file/dir was moved from `from` to `to`; undo moves it back. */
  z.object({ kind: z.literal('move_back'), from: z.string(), to: z.string() }),
  /** A file/dir was created at `path`; undo removes it if unchanged (sha256 for files, empty for dirs). */
  z.object({ kind: z.literal('delete_created'), path: z.string(), isDir: z.boolean(), sha256: z.string().optional() }),
  /** `path` was overwritten; its previous content lives at `backupPath`. */
  z.object({ kind: z.literal('restore_backup'), path: z.string(), backupPath: z.string() }),
  /** `originalPath` was moved to the Trash at `trashedPath`. */
  z.object({ kind: z.literal('untrash'), trashedPath: z.string(), originalPath: z.string() }),
  /** An Apple Events template created something; undo runs its fixed inverse template. */
  z.object({
    kind: z.literal('applescript'),
    template: z.string(),
    params: z.record(z.string(), z.string()),
    description: z.string(),
  }),
  /** A UI field value was changed through Accessibility; undo restores the previous value. */
  z.object({ kind: z.literal('ax_restore_value'), ref: z.string(), value: z.string() }),
]);
export type UndoOp = z.infer<typeof UndoOpSchema>;

export const JournalEntrySchema = z.object({
  seq: z.number().int().min(0),
  runId: IdSchema,
  taskId: TaskIdSchema,
  at: z.number(),
  op: UndoOpSchema,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export const UndoReportSchema = z.object({
  ok: z.boolean(),
  steps: z.number().int(),
  failures: z.array(z.string()),
});
export type UndoReport = z.infer<typeof UndoReportSchema>;
