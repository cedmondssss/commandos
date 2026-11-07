import { z } from 'zod';

export const VoiceStateSchema = z.enum(['idle', 'connecting', 'listening', 'committing', 'error', 'unavailable']);
export type VoiceState = z.infer<typeof VoiceStateSchema>;

export const VoiceEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), state: VoiceStateSchema, detail: z.string().optional(), at: z.number() }),
  z.object({ type: z.literal('partial'), text: z.string(), at: z.number() }),
  z.object({
    type: z.literal('committed'),
    text: z.string(),
    at: z.number(),
    metrics: z.object({
      /** ms from the first audio chunk of the utterance to the committed transcript */
      utteranceToCommitMs: z.number().optional(),
      /** ms from the last audio chunk with speech energy to the committed transcript */
      speechEndToCommitMs: z.number().optional(),
      /** ms from the first audio chunk to the first partial transcript */
      firstPartialMs: z.number().optional(),
    }),
  }),
  z.object({ type: z.literal('level'), rms: z.number(), at: z.number() }),
  z.object({ type: z.literal('speaking'), text: z.string(), at: z.number() }),
  z.object({ type: z.literal('error'), message: z.string(), at: z.number() }),
]);
export type VoiceEvent = z.infer<typeof VoiceEventSchema>;
