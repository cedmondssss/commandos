import { z } from 'zod';

/**
 * JSON-lines RPC between the TypeScript runtime and the Swift helper (native/CommandOSHelper).
 * Request:  {"id":"…","method":"…","params":{…}}
 * Response: {"id":"…","ok":true,"result":{…}} | {"id":"…","ok":false,"error":{"code":"…","message":"…"}}
 * Event:    {"event":"ready", …}
 */
export const HelperRequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
});
export type HelperRequest = z.infer<typeof HelperRequestSchema>;

export const HelperErrorSchema = z.object({ code: z.string(), message: z.string() });

export const HelperResponseSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: HelperErrorSchema }),
]);
export type HelperResponse = z.infer<typeof HelperResponseSchema>;

export const HelperEventSchema = z.object({ event: z.string() }).loose();

export const PermissionStatusSchema = z.object({
  accessibility: z.boolean(),
  screenRecording: z.boolean(),
});
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const RunningAppSchema = z.object({
  name: z.string(),
  bundleId: z.string(),
  pid: z.number().int(),
  active: z.boolean(),
  hidden: z.boolean(),
});

export const AppInfoSchema = z.object({
  bundleId: z.string(),
  name: z.string(),
  version: z.string(),
  shortVersion: z.string(),
  path: z.string(),
  running: z.boolean(),
  pids: z.array(z.number().int()),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export const SpotlightItemSchema = z.object({
  path: z.string(),
  name: z.string(),
  created: z.string().nullable(),
  modified: z.string().nullable(),
  size: z.number().nullable(),
  pixelWidth: z.number().nullable(),
  pixelHeight: z.number().nullable(),
  isScreenCapture: z.boolean(),
});
export type SpotlightItem = z.infer<typeof SpotlightItemSchema>;

export const OcrLineSchema = z.object({
  text: z.string(),
  confidence: z.number(),
  /** normalized [x, y, width, height], origin bottom-left (Vision coordinates) */
  box: z.array(z.number()).length(4),
});

export const OcrResultSchema = z.object({
  text: z.string(),
  lines: z.array(OcrLineSchema),
  width: z.number().int(),
  height: z.number().int(),
});
export type OcrResult = z.infer<typeof OcrResultSchema>;

export const FrameSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

export const AxElementSchema = z.object({
  ref: z.string(),
  role: z.string(),
  subrole: z.string().nullable(),
  title: z.string().nullable(),
  label: z.string().nullable(),
  value: z.string().nullable(),
  identifier: z.string().nullable(),
  description: z.string().nullable(),
  placeholder: z.string().nullable(),
  enabled: z.boolean().nullable(),
  focused: z.boolean().nullable(),
  frame: FrameSchema.nullable(),
  actions: z.array(z.string()),
  depth: z.number().int(),
  childCount: z.number().int(),
});
export type AxElement = z.infer<typeof AxElementSchema>;

export const AxQuerySchema = z.object({
  role: z.string().optional(),
  text: z.string().optional(),
  identifier: z.string().optional(),
  enabledOnly: z.boolean().optional(),
});
export type AxQuery = z.infer<typeof AxQuerySchema>;

const AppTarget = z.object({ bundleId: z.string().min(1) });

export const HelperMethods = {
  ping: {
    params: z.object({}),
    result: z.object({ pong: z.literal(true), version: z.string(), pid: z.number().int() }),
  },
  'permissions.status': { params: z.object({}), result: PermissionStatusSchema },
  'permissions.request': {
    params: z.object({ kind: z.enum(['accessibility', 'screenRecording']) }),
    result: PermissionStatusSchema,
  },
  'apps.list': { params: z.object({}), result: z.object({ apps: z.array(RunningAppSchema) }) },
  'apps.frontmost': { params: z.object({}), result: z.object({ app: RunningAppSchema.nullable() }) },
  'apps.info': { params: AppTarget, result: AppInfoSchema },
  'apps.launch': {
    params: AppTarget.extend({ activate: z.boolean() }),
    result: z.object({ pid: z.number().int(), bundleId: z.string() }),
  },
  'apps.activate': { params: AppTarget, result: z.object({ activated: z.boolean() }) },
  'apps.quit': {
    params: AppTarget.extend({ force: z.boolean() }),
    result: z.object({ requested: z.boolean(), count: z.number().int() }),
  },
  'workspace.open': {
    params: z.object({ path: z.string().optional(), url: z.string().optional(), bundleId: z.string().optional() }),
    result: z.object({ opened: z.boolean() }),
  },
  'workspace.reveal': { params: z.object({ paths: z.array(z.string()).min(1) }), result: z.object({ ok: z.boolean() }) },
  'spotlight.query': {
    params: z.object({
      query: z.string().min(1),
      scopes: z.array(z.string()),
      limit: z.number().int().min(1).max(5000),
      timeoutMs: z.number().int().min(100).max(60_000),
    }),
    result: z.object({ items: z.array(SpotlightItemSchema) }),
  },
  'vision.ocr': {
    params: z.object({
      path: z.string().min(1),
      level: z.enum(['fast', 'accurate']),
      languages: z.array(z.string()).optional(),
    }),
    result: OcrResultSchema,
  },
  'image.info': {
    params: z.object({ path: z.string().min(1) }),
    result: z.object({ width: z.number().int(), height: z.number().int(), type: z.string().nullable() }),
  },
  'screen.capture': {
    params: z.object({
      target: z.enum(['display', 'window']),
      bundleId: z.string().optional(),
      windowId: z.number().int().optional(),
      /** with bundleId: the window whose title contains this (else the frontmost titled window) */
      titleContains: z.string().max(200).optional(),
      outPath: z.string().min(1),
    }),
    result: z.object({
      path: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      windowTitle: z.string().nullable(),
      /** captured area in global screen points (origin top-left) */
      frame: FrameSchema,
    }),
  },
  'ax.tree': {
    params: AppTarget.extend({ maxDepth: z.number().int().min(1).max(40), maxNodes: z.number().int().min(1).max(5000), scope: z.enum(['application', 'window']).optional() }),
    result: z.object({ elements: z.array(AxElementSchema), truncated: z.boolean() }),
  },
  'ax.find': {
    params: AppTarget.extend({
      query: AxQuerySchema,
      maxResults: z.number().int().min(1).max(200),
      maxDepth: z.number().int().min(1).max(40),
    }),
    result: z.object({ elements: z.array(AxElementSchema) }),
  },
  'ax.press': { params: z.object({ ref: z.string().min(1) }), result: z.object({ ok: z.boolean() }) },
  'ax.setValue': {
    params: z.object({ ref: z.string().min(1), value: z.string() }),
    result: z.object({ ok: z.boolean(), value: z.string().nullable() }),
  },
  'ax.getValue': { params: z.object({ ref: z.string().min(1) }), result: z.object({ value: z.string().nullable() }) },
  'ax.focus': { params: z.object({ ref: z.string().min(1) }), result: z.object({ ok: z.boolean() }) },
  'ax.focused': { params: z.object({}), result: z.object({ element: AxElementSchema.nullable(), bundleId: z.string().nullable() }) },
  'ax.fill': {
    params: AppTarget.extend({ role: z.string().min(1).max(60), text: z.string().optional(), identifier: z.string().optional(), value: z.string().max(1000) }),
    result: z.object({ value: z.string().nullable() }),
  },
  'ax.click': {
    params: AppTarget.extend({ role: z.string().min(1).max(60), text: z.string().optional(), identifier: z.string().optional(), expectLabel: z.string().min(1).max(200) }),
    result: z.object({ clicked: z.boolean() }),
  },
  /** asks a Chromium browser to expose page contents to Accessibility (screen-reader switch) */
  'ax.enableWeb': { params: AppTarget.extend({ on: z.boolean() }), result: z.object({ ok: z.boolean(), code: z.number().int(), via: z.string().optional() }) },
  /** text of the page in the app's front window, in document order */
  'ax.webText': {
    params: AppTarget.extend({ maxChars: z.number().int().min(100).max(200_000) }),
    result: z.object({
      title: z.string(), url: z.string().nullable(), text: z.string(), found: z.boolean(), truncated: z.boolean(), nodes: z.number().int(),
      images: z.number().int().optional(), busy: z.boolean().optional(), progressIndicators: z.number().int().optional(),
    }),
  },
  'keyboard.type': {
    params: z.object({ text: z.string().max(10_000), perCharacter: z.boolean().optional(), expectedRef: z.string().min(1).optional() }),
    result: z.object({ ok: z.boolean() }),
  },
  'keyboard.press': {
    params: z.object({ key: z.string().min(1).max(20), modifiers: z.array(z.enum(['command', 'option', 'control', 'shift'])).max(4), expectedRef: z.string().min(1).optional() }),
    result: z.object({ ok: z.boolean() }),
  },
  'mouse.click': {
    params: z.object({ x: z.number(), y: z.number(), button: z.enum(['left', 'right']), clicks: z.number().int().min(1).max(3) }),
    result: z.object({ ok: z.boolean() }),
  },
  'osa.run': {
    params: z.object({ source: z.string().min(1).max(20_000) }),
    result: z.object({ result: z.string().nullable(), items: z.array(z.string()) }),
  },
  'fs.trash': { params: z.object({ path: z.string().min(1) }), result: z.object({ trashedPath: z.string() }) },
  'keychain.get': {
    params: z.object({ service: z.string().min(1), account: z.string().min(1) }),
    result: z.object({ value: z.string().nullable() }),
  },
  'keychain.set': {
    params: z.object({ service: z.string().min(1), account: z.string().min(1), value: z.string().min(1) }),
    result: z.object({ ok: z.boolean() }),
  },
  'keychain.delete': {
    params: z.object({ service: z.string().min(1), account: z.string().min(1) }),
    result: z.object({ deleted: z.boolean() }),
  },
  'keychain.list': {
    params: z.object({ service: z.string().min(1) }),
    result: z.object({ accounts: z.array(z.string()) }),
  },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type HelperMethodName = keyof typeof HelperMethods;
export type HelperParams<M extends HelperMethodName> = z.input<(typeof HelperMethods)[M]['params']>;
export type HelperResult<M extends HelperMethodName> = z.output<(typeof HelperMethods)[M]['result']>;

export const KEYCHAIN_SERVICE = 'com.commandos.credentials';
