import { z } from 'zod';
import { ReasoningEffortSchema } from './model';

export const ConsentModeSchema = z.enum(['allow', 'ask', 'deny']);
export type ConsentMode = z.infer<typeof ConsentModeSchema>;

/** Paths may use `~` for the user's home directory; they are expanded at use. */
export const SettingsSchema = z.object({
  allowedRoots: z.array(z.string().min(1)).min(1),
  deniedPaths: z.array(z.string().min(1)),
  screenshotRoots: z.array(z.string().min(1)),
  models: z.object({ fast: z.string().min(1), main: z.string().min(1), deep: z.string().min(1) }),
  efforts: z.object({ fast: ReasoningEffortSchema, main: ReasoningEffortSchema, deep: ReasoningEffortSchema }),
  /** OpenAI processing tier: 'fast' (Fast mode) trades a per-token premium for lower latency */
  serviceTier: z.enum(['default', 'fast']),
  /** the user's own address, for "email myself"; when unset it is read from Gmail in Chrome */
  userEmail: z.email().max(320).nullable(),
  /** ask before sending email to the user's own address (other recipients always ask) */
  confirmSelfEmail: z.boolean(),
  maxConcurrency: z.number().int().min(1).max(32),
  runDeadlineMs: z.number().int().min(10_000).max(3_600_000),
  approvalTimeoutMs: z.number().int().min(5_000).max(3_600_000),
  /** Reversible local tasks touching more items than this require approval. */
  autoApproveReversibleMax: z.number().int().min(0).max(1000),
  /** Sending extracted text (OCR, document text) to the configured model provider. */
  contentToModel: ConsentModeSchema,
  /** Sending raw images/screenshots to the model provider (vision). */
  imagesToModel: ConsentModeSchema,
  voice: z.object({
    commitStrategy: z.enum(['vad', 'manual']),
    languageCode: z.string().nullable(),
    vadSilenceSecs: z.number().min(0.3).max(5),
    speakResults: z.boolean(),
    ttsVoiceId: z.string().min(1),
    autoSubmit: z.boolean(),
  }),
  telemetry: z.object({ enabled: z.boolean(), projectName: z.string().min(1) }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export function defaultSettings(): Settings {
  return {
    allowedRoots: ['~/Desktop', '~/Documents', '~/Downloads', '~/Pictures', '~/CommandOS-Demo'],
    deniedPaths: [
      '~/.ssh',
      '~/.gnupg',
      '~/.aws',
      '~/.config/gcloud',
      '~/Library/Keychains',
      '~/Library/Cookies',
      '~/Library/Mail',
      '~/Library/Messages',
      '~/Library/Safari',
      '~/Library/Application Support/Google/Chrome',
      '~/Library/Application Support/Firefox',
    ],
    screenshotRoots: ['~/Desktop', '~/Pictures/Screenshots'],
    models: { fast: 'gpt-6-luna', main: 'gpt-6.1-sol', deep: 'gpt-6-astra' },
    // measured: gpt-6-luna at "low" had a similar median and a much smaller tail than "none";
    // a gpt-6-astra deep plan took 46 s at "high", 25 s at "medium" and 16 s at "low"
    efforts: { fast: 'low', main: 'low', deep: 'medium' },
    // Fast mode measured on this account (6 interleaved runs each): router 4.2 → 3.0 s p50,
    // Sol first token 1.73 → 1.15 s and 91 → 133 output tokens/s; it doubles the token price
    serviceTier: 'fast',
    userEmail: null,
    confirmSelfEmail: false,
    maxConcurrency: 6,
    runDeadlineMs: 15 * 60_000,
    approvalTimeoutMs: 5 * 60_000,
    autoApproveReversibleMax: 25,
    contentToModel: 'allow',
    imagesToModel: 'ask',
    voice: {
      commitStrategy: 'vad',
      languageCode: null,
      vadSilenceSecs: 1.0,
      speakResults: false,
      ttsVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
      autoSubmit: true,
    },
    telemetry: { enabled: true, projectName: 'commandos' },
  };
}
