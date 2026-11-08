import type { AxElement, RiskLevel } from '@commandos/contracts';
import { z } from 'zod';
import { defineTool, type ToolContext, ToolError } from './types';

const CHROMIUM = new Set(['com.google.Chrome', 'com.microsoft.edgemac', 'com.brave.Browser', 'company.thebrowser.Browser']);

const BundleId = z.string().min(3).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9.-]+$/, 'bundle identifier like com.apple.TextEdit');

export const TargetSchema = z
  .object({
    ref: z.string().max(200).optional().describe('element ref from ui.find / ui.snapshot'),
    role: z.string().max(60).optional().describe('AX role, e.g. AXButton, AXTextField, AXTextArea'),
    text: z.string().max(200).optional().describe('substring of the title, label, value, description or placeholder'),
    identifier: z.string().max(200).optional(),
  })
  .refine((t) => Boolean(t.ref || t.role || t.text || t.identifier), 'give a ref or at least one of role/text/identifier');
type Target = z.infer<typeof TargetSchema>;

/** Labels that indicate the click sends, buys, deletes or otherwise acts beyond this Mac. */
export const RISKY_LABEL = /\b(create repository|send|submit|pay|buy|purchase|order|checkout|delete|remove|erase|trash|publish|post|transfer|confirm|sign|share|upload|empty|format|uninstall|reset|wipe|unsubscribe|book|reserve)\b/i;

const ElementOut = z.object({
  ref: z.string(),
  role: z.string(),
  label: z.string().nullable(),
  value: z.string().nullable(),
  enabled: z.boolean().nullable(),
  frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
});

export function labelOf(e: AxElement): string | null {
  return e.title || e.label || e.description || e.placeholder || e.identifier || null;
}

function compactElement(e: AxElement) {
  return { ref: e.ref, role: e.role, label: labelOf(e), value: e.value, enabled: e.enabled, frame: e.frame };
}

const INTERACTIVE = new Set([
  'AXButton', 'AXTextField', 'AXTextArea', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuButton', 'AXComboBox',
  'AXLink', 'AXSlider', 'AXTab', 'AXMenuItem', 'AXSearchField', 'AXSecureTextField', 'AXIncrementor', 'AXDisclosureTriangle', 'AXCell', 'AXRow',
]);

async function resolveTarget(ctx: ToolContext, bundleId: string, target: Target): Promise<AxElement> {
  const query = {
    ...(target.role ? { role: target.role } : {}),
    ...(target.text ? { text: target.text } : {}),
    ...(target.identifier ? { identifier: target.identifier } : {}),
  };
  if (target.ref && !Object.keys(query).length) {
    // bare ref: confirm it still resolves
    await ctx.helper.call('ax.getValue', { ref: target.ref }, { signal: ctx.signal });
    const found = await ctx.helper.call('ax.find', { bundleId, query: {}, maxResults: 200, maxDepth: 25 }, { signal: ctx.signal, timeoutMs: 20_000 });
    const el = found.elements.find((e) => e.ref === target.ref);
    if (!el) throw new ToolError('stale_ref', `element ${target.ref} is no longer in ${bundleId}`, true);
    return el;
  }
  const r = await ctx.helper.call('ax.find', { bundleId, query: { ...query, enabledOnly: true }, maxResults: 10, maxDepth: 25 }, { signal: ctx.signal, timeoutMs: 20_000 });
  const candidates = target.ref ? r.elements.filter((e) => e.ref === target.ref) : r.elements;
  if (!candidates.length) throw new ToolError('not_found', `no UI element in ${bundleId} matches ${JSON.stringify(query)}`, true);
  const needle = target.text?.toLowerCase();
  const exact = needle ? candidates.find((e) => labelOf(e)?.toLowerCase() === needle) : undefined;
  return exact ?? (candidates[0] as AxElement);
}

export const uiSnapshot = defineTool({
  id: 'ui.snapshot',
  title: 'Read app UI',
  description: "List the interactive UI elements (buttons, fields, menus…) of a running app via Accessibility, with refs usable by ui.press / ui.setValue.",
  tier: 3,
  args: z.object({ bundleId: BundleId, maxDepth: z.number().int().min(1).max(30).default(15), limit: z.number().int().min(1).max(400).default(150) }),
  output: z.object({ elements: z.array(ElementOut), truncated: z.boolean() }),
  effectClass: 'read',
  effects: ['ui_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 30_000,
  async run(a, ctx) {
    const r = await ctx.helper.call('ax.tree', { bundleId: a.bundleId, maxDepth: a.maxDepth, maxNodes: 2500 }, { signal: ctx.signal, timeoutMs: 25_000 });
    const elements = r.elements.filter((e) => INTERACTIVE.has(e.role) || (e.role === 'AXStaticText' && e.value)).map(compactElement);
    return { elements: elements.slice(0, a.limit), truncated: r.truncated || elements.length > a.limit };
  },
  summarize: (o) => ({ count: o.elements.length, elements: o.elements.slice(0, 60).map((e) => `${e.ref} ${e.role} ${e.label ?? ''}${e.value ? ` = ${e.value.slice(0, 40)}` : ''}`) }),
});

export const uiFind = defineTool({
  id: 'ui.find',
  title: 'Find UI element',
  description: 'Find UI elements in a running app by role and/or visible text via Accessibility. Returns refs, labels, values and frames.',
  tier: 3,
  args: z.object({ bundleId: BundleId, target: TargetSchema, maxResults: z.number().int().min(1).max(50).default(10) }),
  output: z.object({ elements: z.array(ElementOut) }),
  effectClass: 'read',
  effects: ['ui_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 25_000,
  async run(a, ctx) {
    const query = {
      ...(a.target.role ? { role: a.target.role } : {}),
      ...(a.target.text ? { text: a.target.text } : {}),
      ...(a.target.identifier ? { identifier: a.target.identifier } : {}),
    };
    const r = await ctx.helper.call('ax.find', { bundleId: a.bundleId, query, maxResults: a.maxResults, maxDepth: 25 }, { signal: ctx.signal, timeoutMs: 20_000 });
    return { elements: r.elements.map(compactElement) };
  },
});

export const uiPress = defineTool({
  id: 'ui.press',
  title: 'Press UI element',
  description:
    'Press an enabled button, menu item, checkbox or link via Accessibility. Disabled controls are refused. expectLabel must match the visible label. Sends, purchases, deletions and submissions need approval. Success means the AX press was dispatched, not that the external effect completed: verify the resulting app/page state separately.',
  tier: 3,
  args: z.object({ bundleId: BundleId, target: TargetSchema, expectLabel: z.string().min(1).max(200) }),
  output: z.object({ pressed: ElementOut, effectConfirmed: z.literal(false) }),
  effectClass: (a) => (RISKY_LABEL.test(a.expectLabel) ? 'external' : 'irreversible_local'),
  effects: ['ui_input'],
  risk: (a): RiskLevel => (RISKY_LABEL.test(a.expectLabel) ? 'high' : 'low'),
  idempotent: false,
  defaultTimeoutMs: 30_000,
  resources: (a) => [`app:${a.bundleId}`, 'ui:frontmost'],
  preview: (a) => ({ summary: `Press “${a.expectLabel}” in ${a.bundleId}`, details: [] }),
  alternatives(a, error) {
    // a stale element ref: look the element up again by its label
    if (error.code === 'stale_ref' && a.target.ref) return [{ args: { ...a, target: { text: a.expectLabel } }, label: 'find the element again by its label' }];
    return [];
  },
  async run(a, ctx) {
    const el = await resolveTarget(ctx, a.bundleId, a.target);
    if (el.enabled === false) throw new ToolError('disabled_element', 'The target control is disabled. No press was sent; re-read the form and verify its requirements before continuing.');
    const label = labelOf(el) ?? '';
    if (!label.toLowerCase().includes(a.expectLabel.toLowerCase())) {
      throw new ToolError('label_mismatch', `found “${label}” but expected “${a.expectLabel}”; not pressing`);
    }
    if (RISKY_LABEL.test(label) && !RISKY_LABEL.test(a.expectLabel)) {
      throw new ToolError('label_mismatch', `element “${label}” looks consequential but was requested as “${a.expectLabel}”`);
    }
    if (CHROMIUM.has(a.bundleId)) {
      await ctx.helper.call('apps.activate', { bundleId: a.bundleId }, { signal: ctx.signal });
      const query = {
        role: el.role,
        text: a.expectLabel,
        ...(a.target.identifier ?? el.identifier ? { identifier: a.target.identifier ?? el.identifier! } : {}),
      };
      await ctx.helper.call('ax.click', { bundleId: a.bundleId, ...query, expectLabel: a.expectLabel }, { signal: ctx.signal, timeoutMs: 20_000 });
    } else {
      await ctx.helper.call('ax.press', { ref: el.ref }, { signal: ctx.signal });
    }
    return { pressed: compactElement(el), effectConfirmed: false as const };
  },
});

export const uiSetValue = defineTool({
  id: 'ui.setValue',
  undo: 'journaled',
  title: 'Set field value',
  description: 'Replace a field value and verify read-back. Single-line Chromium fields are re-found by a unique label or identifier, clicked, filled by paste with clipboard restoration, and read back before continuing. Other fields use Accessibility. Never submits. The previous value is journaled for undo. After filling a confirmation field, inspect the final button and require enabled=true before pressing; never fall back to unfocused ui.type.',
  tier: 3,
  args: z.object({ bundleId: BundleId, target: TargetSchema, value: z.string().max(20_000) }),
  output: z.object({ element: ElementOut, previous: z.string().nullable(), readBack: z.string().nullable(), via: z.enum(['keyboard', 'accessibility']) }),
  effectClass: 'reversible_local',
  effects: ['ui_input'],
  risk: 'low',
  idempotent: true,
  defaultTimeoutMs: 30_000,
  resources: (a) => [`app:${a.bundleId}`, 'ui:frontmost'],
  preview: (a) => ({ summary: `Type into ${a.target.text ?? a.target.role ?? a.target.ref} in ${a.bundleId}`, details: [a.value.slice(0, 300)] }),
  async run(a, ctx) {
    const el = await resolveTarget(ctx, a.bundleId, a.target);
    if (el.enabled === false) throw new ToolError('disabled_element', 'The target field is disabled; nothing was typed.');
    const previous = el.value;
    const requestedRole = a.target.role && ['AXTextField', 'AXTextArea'].includes(a.target.role) ? a.target.role : el.role;
    if (CHROMIUM.has(a.bundleId) && ['AXTextField', 'AXTextArea'].includes(requestedRole) && !/[\r\n]/.test(a.value) && a.value.length <= 1000) {
      if (previous === null) throw new ToolError('input_unverified', 'The current field value could not be read; nothing was typed.');
      await ctx.helper.call('apps.activate', { bundleId: a.bundleId }, { signal: ctx.signal });
      const query = {
        role: requestedRole,
        ...((a.target.text ?? labelOf(el)) ? { text: a.target.text ?? labelOf(el)! } : {}),
        ...(a.target.identifier ?? el.identifier ? { identifier: a.target.identifier ?? el.identifier! } : {}),
      };
      if (!query.text && !query.identifier) throw new ToolError('ambiguous_target', 'A Chromium field needs a label or identifier so it can be safely re-found after the accessibility tree changes.');
      await ctx.journal.record({ kind: 'ax_restore_value', ref: el.ref, value: previous });
      const filled = await ctx.helper.call('ax.fill', { bundleId: a.bundleId, ...query, value: a.value }, { signal: ctx.signal, timeoutMs: 20_000 });
      const readBack = filled.value;
      return { element: compactElement(el), previous, readBack, via: 'keyboard' as const };
    }
    const r = await ctx.helper.call('ax.setValue', { ref: el.ref, value: a.value }, { signal: ctx.signal });
    await ctx.journal.record({ kind: 'ax_restore_value', ref: el.ref, value: previous ?? '' });
    const back = await ctx.helper.call('ax.getValue', { ref: el.ref }, { signal: ctx.signal });
    return { element: compactElement(el), previous, readBack: back.value ?? r.value, via: 'accessibility' as const };
  },
  async verify(a, o) {
    return [{ label: `field reads back the typed value`, ok: o.readBack === a.value, detail: `read back ${JSON.stringify(o.readBack?.slice(0, 80))}` }];
  },
});

export const uiType = defineTool({
  id: 'ui.type',
  title: 'Type text',
  description: 'Type text into whatever element currently has keyboard focus (synthesized key events). Prefer ui.setValue; text containing a newline may submit forms and needs approval.',
  tier: 3,
  args: z.object({ text: z.string().min(1).max(5000) }),
  output: z.object({ typed: z.number().int() }),
  effectClass: 'irreversible_local',
  effects: ['ui_input'],
  risk: (a): RiskLevel => (/[\r\n]/.test(a.text) ? 'medium' : 'low'),
  idempotent: false,
  defaultTimeoutMs: 60_000,
  resources: () => ['ui:frontmost'],
  preview: (a) => ({ summary: `Type ${a.text.length} characters into the focused field`, details: [a.text.slice(0, 300)] }),
  async run(a, ctx) {
    await ctx.helper.call('keyboard.type', { text: a.text }, { signal: ctx.signal, timeoutMs: 55_000 });
    return { typed: a.text.length };
  },
});

const DANGEROUS_KEYS = (key: string, mods: string[]) =>
  (mods.includes('command') && ['q', 'w', 'delete', 'backspace'].includes(key.toLowerCase())) || ['return', 'enter'].includes(key.toLowerCase());

export const uiKey = defineTool({
  id: 'ui.key',
  title: 'Press keys',
  description: 'Press a key with optional modifiers in the frontmost app, e.g. {key:"n", modifiers:["command"]} for a new document. Return/Enter and ⌘Q/⌘W need approval.',
  tier: 3,
  args: z.object({ key: z.string().min(1).max(20), modifiers: z.array(z.enum(['command', 'option', 'control', 'shift'])).max(4).default([]) }),
  output: z.object({ ok: z.boolean() }),
  effectClass: 'irreversible_local',
  effects: ['ui_input'],
  risk: (a): RiskLevel => (DANGEROUS_KEYS(a.key, a.modifiers) ? 'medium' : 'low'),
  idempotent: false,
  defaultTimeoutMs: 10_000,
  resources: () => ['ui:frontmost'],
  preview: (a) => ({ summary: `Press ${[...a.modifiers, a.key].join('+')}`, details: [] }),
  async run(a, ctx) {
    return ctx.helper.call('keyboard.press', { key: a.key, modifiers: a.modifiers }, { signal: ctx.signal });
  },
});

export const uiClick = defineTool({
  id: 'ui.click',
  title: 'Click at screen position',
  description: 'Click at global screen coordinates (points). Last resort after Accessibility; use vision.locateText to find coordinates. Always needs approval.',
  tier: 4,
  args: z.object({
    x: z.number().min(0).max(20_000),
    y: z.number().min(0).max(20_000),
    button: z.enum(['left', 'right']).default('left'),
    clicks: z.number().int().min(1).max(3).default(1),
    reason: z.string().min(1).max(300).describe('what is being clicked and why'),
  }),
  output: z.object({ ok: z.boolean() }),
  effectClass: 'irreversible_local',
  effects: ['ui_input'],
  risk: 'medium',
  idempotent: false,
  defaultTimeoutMs: 10_000,
  resources: () => ['ui:frontmost'],
  preview: (a) => ({ summary: `Click at (${Math.round(a.x)}, ${Math.round(a.y)}): ${a.reason}`, details: [] }),
  async run(a, ctx) {
    return ctx.helper.call('mouse.click', { x: a.x, y: a.y, button: a.button, clicks: a.clicks }, { signal: ctx.signal });
  },
});

export const uiTools = [uiSnapshot, uiFind, uiPress, uiSetValue, uiType, uiKey, uiClick];
