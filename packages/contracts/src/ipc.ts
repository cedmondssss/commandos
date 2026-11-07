import { z } from 'zod';
import { CommandSourceSchema, IdSchema, OkSchema, TaskIdSchema } from './common';
import { CredentialKeySchema, CredentialStatusSchema, ProviderIdSchema } from './credentials';
import { RunEventSchema, RunSnapshotSchema, RunSummarySchema } from './events';
import { PermissionStatusSchema } from './helper';
import { UndoReportSchema } from './journal';
import { RunMetricsSchema } from './metrics';
import { ApprovalDecisionSchema } from './policy';
import { SettingsPatchSchema, SettingsSchema } from './settings';
import { ToolDescriptorSchema } from './tool';
import { VoiceEventSchema } from './voice';
import { SafetyReportSchema } from './safety';

export const ProviderVerificationSchema = z.object({
  provider: z.union([ProviderIdSchema, z.literal('helper')]),
  status: z.enum(['verified', 'blocked', 'failed', 'unverified']),
  checkedAt: z.string(),
  detail: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  durationMs: z.number().optional(),
});
export type ProviderVerification = z.infer<typeof ProviderVerificationSchema>;

export const VerificationReportSchema = z.object({
  generatedAt: z.string(),
  results: z.array(ProviderVerificationSchema),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const HelperStatusSchema = z.object({
  running: z.boolean(),
  path: z.string(),
  version: z.string().optional(),
  error: z.string().optional(),
});
export type HelperStatus = z.infer<typeof HelperStatusSchema>;

export const DiagnosticsSchema = z.object({
  dataDir: z.string(),
  helper: HelperStatusSchema,
  permissions: PermissionStatusSchema.nullable(),
  telemetry: z.object({
    arize: z.boolean(), localTraceFile: z.string().nullable(), projectName: z.string().optional(),
    exportStats: z.object({ spans: z.number().int(), batches: z.number().int(), failures: z.number().int(), lastSuccessAt: z.string().optional() }).nullable().optional(),
  }),
  verification: VerificationReportSchema.nullable(),
});
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

/** Methods served by the runtime (utilityProcess). Main validates and forwards renderer calls. */
export const RuntimeApi = {
  'safety.run': { req: z.object({}).strict(), res: SafetyReportSchema },
  'safety.report': { req: z.object({}).strict(), res: SafetyReportSchema.nullable() },
  'safety.status': { req: z.object({}).strict(), res: z.object({ running: z.boolean() }) },
  'safety.cancel': { req: z.object({}).strict(), res: OkSchema },
  'command.submit': {
    req: z.object({ text: z.string().trim().min(1).max(4000), source: CommandSourceSchema, dryRun: z.boolean() }),
    res: z.object({ runId: IdSchema }),
  },
  'run.cancel': { req: z.object({ runId: IdSchema }), res: OkSchema },
  'run.undo': { req: z.object({ runId: IdSchema }), res: UndoReportSchema },
  'run.resume': { req: z.object({ runId: IdSchema }), res: z.object({ runId: IdSchema }) },
  'run.get': { req: z.object({ runId: IdSchema }), res: RunSnapshotSchema },
  /** Only a recorded browser screenshot belonging to this run can be displayed. */
  'run.image': { req: z.object({ runId: IdSchema, taskId: TaskIdSchema }), res: z.object({ dataUrl: z.string().regex(/^data:image\/(?:png|jpeg);base64,/) }) },
  'browser.preview': {
    req: z.object({ runId: IdSchema, sessionId: IdSchema }),
    res: z.object({ state: z.enum(['live', 'closed', 'unavailable']), dataUrl: z.string().startsWith('data:image/jpeg;base64,').nullable() }),
  },
  'run.metrics': { req: z.object({ runId: IdSchema }), res: RunMetricsSchema },
  'runs.list': { req: z.object({}), res: z.object({ runs: z.array(RunSummarySchema) }) },
  'approval.respond': { req: z.object({ approvalId: IdSchema, decision: ApprovalDecisionSchema }), res: OkSchema },
  'emergency.stop': { req: z.object({}), res: OkSchema },
  'voice.start': { req: z.object({}), res: OkSchema },
  'voice.stop': { req: z.object({ commit: z.boolean() }), res: OkSchema },
  'settings.get': { req: z.object({}), res: SettingsSchema },
  'settings.update': { req: SettingsPatchSchema, res: SettingsSchema },
  'credentials.status': { req: z.object({}), res: z.object({ credentials: z.array(CredentialStatusSchema) }) },
  'credentials.set': {
    req: z.object({ key: CredentialKeySchema, value: z.string().trim().min(1).max(4096) }),
    res: OkSchema,
  },
  'credentials.delete': { req: z.object({ key: CredentialKeySchema }), res: OkSchema },
  'permissions.status': { req: z.object({}), res: z.object({ status: PermissionStatusSchema.nullable(), helper: HelperStatusSchema }) },
  'permissions.request': {
    req: z.object({ kind: z.enum(['accessibility', 'screenRecording']) }),
    res: z.object({ status: PermissionStatusSchema.nullable() }),
  },
  'diagnostics.get': { req: z.object({}), res: DiagnosticsSchema },
  'tools.list': { req: z.object({}), res: z.object({ tools: z.array(ToolDescriptorSchema) }) },
} as const satisfies Record<string, { req: z.ZodType; res: z.ZodType }>;
export type RuntimeMethod = keyof typeof RuntimeApi;
export type RuntimeReq<M extends RuntimeMethod> = z.input<(typeof RuntimeApi)[M]['req']>;
export type RuntimeRes<M extends RuntimeMethod> = z.output<(typeof RuntimeApi)[M]['res']>;

export const MicrophoneStatusSchema = z.enum(['granted', 'denied', 'restricted', 'not-determined', 'unknown']);

/** Methods served by the Electron main process itself. */
export const MainApi = {
  'window.show': { req: z.object({ which: z.enum(['main', 'bar']) }), res: OkSchema },
  'window.hideBar': { req: z.object({}), res: OkSchema },
  /** the overlay sizes itself to its content */
  'window.fitBar': { req: z.object({ height: z.number().int().min(40).max(1200) }), res: OkSchema },
  /** the overlay takes keyboard focus only while the user types in it */
  'window.focusBar': { req: z.object({}), res: OkSchema },
  'window.releaseBar': { req: z.object({}), res: OkSchema },
  'system.openSettings': {
    req: z.object({ pane: z.enum(['accessibility', 'screenRecording', 'microphone', 'automation']) }),
    res: OkSchema,
  },
  'microphone.status': { req: z.object({}), res: z.object({ status: MicrophoneStatusSchema }) },
  'microphone.request': { req: z.object({}), res: z.object({ granted: z.boolean() }) },
} as const satisfies Record<string, { req: z.ZodType; res: z.ZodType }>;
export type MainMethod = keyof typeof MainApi;

export type InvokeMethod = RuntimeMethod | MainMethod;

export function isRuntimeMethod(m: string): m is RuntimeMethod {
  return Object.prototype.hasOwnProperty.call(RuntimeApi, m);
}
export function isMainMethod(m: string): m is MainMethod {
  return Object.prototype.hasOwnProperty.call(MainApi, m);
}

export const InvokeEnvelopeSchema = z.object({
  method: z.string().min(1).max(64),
  params: z.unknown(),
});

/** Audio chunk: 16 kHz mono signed 16-bit little-endian PCM, ≤ 64 KiB. */
export const AudioChunkSchema = z
  .instanceof(Uint8Array)
  .refine((b) => b.byteLength > 0 && b.byteLength <= 65_536 && b.byteLength % 2 === 0, 'invalid PCM chunk');

export const AppStatusSchema = z.object({
  runtime: z.enum(['starting', 'ready', 'restarting', 'crashed']),
  helper: HelperStatusSchema.optional(),
  activeRunIds: z.array(z.string()),
  pendingApprovals: z.number().int(),
});
export type AppStatus = z.infer<typeof AppStatusSchema>;

export const UiCommandSchema = z.object({ action: z.enum(['toggle-voice', 'stop-voice', 'focus-input', 'show-run']), runId: z.string().optional() });
export type UiCommand = z.infer<typeof UiCommandSchema>;

export const PushChannelSchema = z.enum(['run:event', 'voice:event', 'app:status', 'ui:command']);
export type PushChannel = z.infer<typeof PushChannelSchema>;

export const PushSchemas = {
  'run:event': RunEventSchema,
  'voice:event': VoiceEventSchema,
  'app:status': AppStatusSchema,
  'ui:command': UiCommandSchema,
} as const;

/** Messages from main → runtime utilityProcess. */
export const RuntimeInboundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), id: z.string(), method: z.string(), params: z.unknown() }),
  z.object({ kind: z.literal('audio'), data: AudioChunkSchema }),
  z.object({ kind: z.literal('shutdown') }),
]);
export type RuntimeInbound = z.infer<typeof RuntimeInboundSchema>;

/** Messages from runtime → main. */
export const RuntimeOutboundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('response'), id: z.string(), result: z.unknown() }),
  z.object({ kind: z.literal('error'), id: z.string(), error: z.object({ code: z.string(), message: z.string() }) }),
  z.object({ kind: z.literal('push'), channel: PushChannelSchema, payload: z.unknown() }),
  z.object({ kind: z.literal('ready') }),
]);
export type RuntimeOutbound = z.infer<typeof RuntimeOutboundSchema>;
