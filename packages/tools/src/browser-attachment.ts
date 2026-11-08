import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { AxElement } from '@commandos/contracts';
import { z } from 'zod';
import { PathArg } from './fs';
import { runOsaTemplate } from './osa';
import { resolveUserPath } from './paths';
import { pollUntil } from './poll';
import { defineTool, type ToolContext, ToolError } from './types';

const CHROME = 'com.google.Chrome';
const label = (e: AxElement) => [e.title, e.label, e.description, e.placeholder, e.value].filter(Boolean).join(' ').trim();
const labels = (e: AxElement) => [e.title, e.label, e.description, e.placeholder].filter((s): s is string => Boolean(s)).map((s) => s.replace(/\s+/g, ' ').trim());
const button = (e: AxElement) => ['AXButton', 'AXMenuButton', 'AXPopUpButton', 'AXMenuItem'].includes(e.role) && e.enabled !== false;
const descendant = (e: AxElement, ref: string) => e.ref === ref || e.ref.startsWith(`${ref}.`);
const ADD = /^(?:[+＋]|plus|paperclip|add|more(?: options)?|attach|attachments?|upload|(?:upload|attach|add|choose|select)(?: (?:a|an))? (?:(?:files?|images?|photos?|attachments?)(?:(?:,| and| or| &) )?)+)$/i;
/** Icon buttons may expose their name on an SVG child or an accessibility identifier. */
export function controlLabels(elements: AxElement[], control: AxElement): string[] {
  const names = [...labels(control), ...(control.value ? [control.value.replace(/\s+/g, ' ').trim()] : [])];
  for (const child of elements) {
    if (child.ref !== control.ref && descendant(child, control.ref) && ['AXImage', 'AXStaticText'].includes(child.role)) {
      names.push(...labels(child), ...(child.value ? [child.value.trim()] : []));
    }
  }
  if (control.identifier) {
    const id = control.identifier.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase().trim();
    if (/^(?:(?:chat|composer) )?(?:(?:file|image|photo) )?(?:upload|attach(?:ment)?|paperclip)(?: (?:file|image|photo|attachment|button|btn|trigger|menu)s?)*$/.test(id)) names.push('attach');
  }
  return names;
}

export function attachmentControl(elements: AxElement[]): AxElement | null {
  const candidates = elements.filter((e) => button(e) && controlLabels(elements, e).some((s) => ADD.test(s)));
  const rank = (e: AxElement) => controlLabels(elements, e).some((s) => /upload|attach|paperclip/i.test(s)) ? 0 : 1;
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates.length === 1 || (candidates.length > 1 && rank(candidates[0]!) < rank(candidates[1]!)) ? candidates[0]! : null;
}
const FILE = /^(?:upload|attach|add|choose|select)(?: (?:a |an )?(?:files?|images?|photos?|attachments?))?$|^(?:from|upload from) (?:computer|device)$|^(?:files?|images?|photos?|attachments?)$/i;
const FILE_TYPES = /\s+(?:files?|images?|photos?|videos?|audio)(?:,\s*(?:files?|images?|photos?|videos?|audio))+$/i;

/** Qwen exposes “Upload attachment” followed by its supported file types in one
 * accessible label. Only an open page menu or newly appeared page control qualifies. */
export function attachmentMenuControl(elements: AxElement[], before?: AxElement[], triggerRef?: string): AxElement | null {
  const webAreas = elements.filter((e) => e.role === 'AXWebArea');
  const menus = elements.filter((e) => e.role === 'AXMenu' && webAreas.some((web) => descendant(e, web.ref)));
  const previous = before ? new Set(before.map((e) => e.ref)) : null;
  const candidates = elements.filter((e) => e.ref !== triggerRef && button(e)
    && webAreas.some((web) => descendant(e, web.ref))
    && (menus.some((menu) => descendant(e, menu.ref)) || e.role === 'AXMenuItem' || (previous && !previous.has(e.ref)))
    && controlLabels(elements, e).some((s) => FILE.test(s.replace(FILE_TYPES, ''))));
  const rank = (e: AxElement) => {
    const names = controlLabels(elements, e).map((s) => s.replace(FILE_TYPES, '')).filter((s) => FILE.test(s));
    return names.some((s) => /\b(?:image|photo)s?\b/i.test(s)) ? 0 : names.some((s) => /\bfiles?\b/i.test(s)) ? 1 : 2;
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates.length && (candidates.length === 1 || rank(candidates[0]!) < rank(candidates[1]!)) ? candidates[0]! : null;
}
const OPEN = /^(?:open|choose|select|upload)$/i;
const FAILED = /\b(?:upload failed|failed to upload|failed to attach|couldn[’']t upload|unsupported file|file (?:is )?too large)\b/i;
const UPLOADING = /\b(?:uploading|attaching|processing (?:file|image)|scanning (?:file|image))\b/i;

/** Photo Booth inserts a narrow no-break space before AM/PM. Match only the same
 * timestamp in the same directory; never substitute a newer or different photo. */
export async function resolveAttachmentPath(input: string): Promise<string> {
  const path = resolveUserPath(input);
  try {
    await stat(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const timestamp = (name: string) => /^Photo on \d{1,2}-\d{1,2}-\d{2,4} at \d{1,2}\.\d{2}[ \u00a0\u202f]*(?:AM|PM)\.(?:jpe?g|png|heic)$/i.test(name)
    ? name.replace(/[ \u00a0\u202f]+(?=(?:AM|PM)\.)/i, '') : null;
  const key = timestamp(basename(path));
  if (key) {
    const entries = await readdir(dirname(path), { withFileTypes: true });
    const matches = entries.filter((entry) => entry.isFile() && timestamp(entry.name) === key);
    if (matches.length === 1) return join(dirname(path), matches[0]!.name);
    if (matches.length > 1) throw new ToolError('upload_unverified', 'Several Photo Booth images match that timestamp. Select the exact file; no attachment was attempted.');
  }
  throw new ToolError('upload_unverified', 'The specified image was not found. No attachment was attempted; no different photo was substituted.');
}

export function isQwenUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['chat.qwen.ai', 'chat.qwenlm.ai'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Only native macOS dialogs qualify. A web page's Open/Cancel buttons never qualify. */
export function nativeFilePicker(elements: AxElement[]): AxElement[] | null {
  const webAreas = elements.filter((e) => e.role === 'AXWebArea');
  const roots = elements.filter((e) =>
    (e.role === 'AXSheet' || e.role === 'AXDialog' || ['AXDialog', 'AXSystemDialog'].includes(e.subrole ?? '')
      || (e.role === 'AXWindow' && ['open-panel', 'GoToWindow'].includes(e.identifier ?? '')))
      && !webAreas.some((web) => descendant(e, web.ref)),
  );
  for (const root of roots) {
    const inside = elements.filter((e) => descendant(e, root.ref));
    if (inside.some((e) => button(e) && labels(e).some((s) => /^cancel$/i.test(s)))) return inside;
    // macOS presents Go to Folder as a separate native sheet with Close, not
    // Cancel. It replaces the open-panel AX tree while its path field is active.
    if (['AXSheet', 'AXWindow'].includes(root.role) && root.identifier === 'GoToWindow'
      && inside.some((e) => ['AXTextField', 'AXComboBox'].includes(e.role) && e.identifier === 'PathTextField' && e.enabled !== false)) return inside;
  }
  return null;
}

/** Locate the composer without guessing screen coordinates or choosing a search box. */
export function chatComposer(elements: AxElement[]): AxElement | null {
  const fields = elements.filter((e) => e.role === 'AXTextArea' && e.enabled !== false && !/\bsearch\b/i.test(label(e)));
  const named = fields.filter((e) => /\b(?:qwen|message|ask|chat|prompt)\b/i.test(labels(e).join(' ')));
  return named.length === 1 ? named[0] as AxElement : fields.length === 1 ? fields[0] as AxElement : null;
}

/** The smallest group containing the composer and its action buttons. Excludes chat history. */
export function composerRegion(elements: AxElement[], composer: AxElement): AxElement[] {
  let ref = composer.ref;
  let fallback: AxElement[] | null = null;
  for (let i = 0; i < 40; i++) {
    const cut = ref.lastIndexOf('.');
    if (cut < 0) break;
    ref = ref.slice(0, cut);
    // Never expand into the web document or browser chrome to borrow history/menu controls.
    if (elements.some((e) => e.ref === ref && ['AXWebArea', 'AXWindow'].includes(e.role))) break;
    const region = elements.filter((e) => descendant(e, ref));
    if (attachmentControl(region)) return region;
    if (!fallback && region.some((e) => button(e) && labels(e).some((s) => /^(?:send|send message)$/i.test(s)))) fallback = region;
  }
  return fallback ?? [composer];
}

/** Qwen's visible plus is omitted from Chrome's AX tree on some builds. Its composer
 * textarea still has a frame; the plus sits immediately to its left in the same row.
 * We only click this Qwen-specific offset when the page, frontmost app, and composer
 * have already been verified, then require the native picker/menu to appear. */
async function openAttachment(ctx: ToolContext, url: string, composer: AxElement, trigger: AxElement | null) {
  if (trigger) return press(ctx, url, trigger);
  const frame = composer.frame;
  if (!frame || frame.width < 100 || frame.height < 20 || frame.x < 28) {
    throw new ToolError('upload_unverified', 'Qwen has no identifiable attachment control next to its composer. No attachment was attempted.');
  }
  await assertTarget(ctx, url);
  await ctx.helper.call('mouse.click', { x: frame.x - 27, y: frame.y + frame.height / 2, button: 'left', clicks: 1 }, { signal: ctx.signal });
}

async function tree(ctx: ToolContext) {
  const read = () => ctx.helper.call('ax.tree', { bundleId: CHROME, scope: 'window', maxDepth: 40, maxNodes: 5000 }, { signal: ctx.signal, timeoutMs: 10_000 });
  let result: Awaited<ReturnType<typeof read>>;
  try {
    result = await read();
  } catch (error) {
    // Chrome can briefly return no AXFocusedWindow while it activates a tab or opens
    // its native file picker. Retry only that transient state; propagate all other
    // failures (especially permission errors) immediately.
    const transientWindow = (e: unknown) => e instanceof Error && /has no accessible front window/i.test(e.message);
    if (!transientWindow(error)) throw error;
    const recovered = await pollUntil(async () => {
      try { return await read(); }
      catch (retryError) {
        if (transientWindow(retryError)) return null;
        throw retryError;
      }
    }, 2_000, ctx.signal, 100, false);
    if (!recovered) throw new ToolError('upload_unverified', 'Chrome did not expose its Qwen window to Accessibility. The message was not submitted; check the composer before retrying.');
    result = recovered;
  }
  if (result.truncated) throw new ToolError('upload_unverified', 'The Chrome UI is too large to identify the attachment controls reliably. No message was submitted.');
  return result.elements;
}

async function assertTarget(ctx: ToolContext, url: string) {
  ctx.signal.throwIfAborted();
  const front = await ctx.helper.call('apps.frontmost', {}, { signal: ctx.signal });
  if (front.app?.bundleId !== CHROME) throw new ToolError('upload_unverified', 'Chrome lost keyboard focus; attachment stopped without submitting the message.');
  const current = await runOsaTemplate(ctx.helper, 'chrome.frontTab', {}, ctx.signal);
  if (current.items[0] !== url) throw new ToolError('upload_unverified', 'The selected Qwen conversation changed; attachment stopped without submitting the message.');
}

async function readPage(ctx: ToolContext, url: string) {
  await assertTarget(ctx, url);
  const p = await ctx.helper.call('ax.webText', { bundleId: CHROME, maxChars: 60_000 }, { signal: ctx.signal, timeoutMs: 10_000 });
  if (!p.found || p.url !== url) return null;
  return p;
}

async function press(ctx: ToolContext, url: string, element: AxElement) {
  await assertTarget(ctx, url);
  await ctx.helper.call('ax.press', { ref: element.ref }, { signal: ctx.signal });
}

async function chooseFile(ctx: ToolContext, url: string, path: string) {
  await assertTarget(ctx, url);
  if (!nativeFilePicker(await tree(ctx))) throw new ToolError('upload_unverified', 'The native file picker is not open; no path was typed.');
  await ctx.helper.call('keyboard.press', { key: 'g', modifiers: ['command', 'shift'] }, { signal: ctx.signal });
  const pathField = await pollUntil(async () => {
    await assertTarget(ctx, url);
    const focused = await ctx.helper.call('ax.focused', {}, { signal: ctx.signal });
    const panel = nativeFilePicker(await tree(ctx));
    return focused.bundleId === CHROME && focused.element && ['AXTextField', 'AXComboBox'].includes(focused.element.role) && panel?.some((e) => e.ref === focused.element?.ref) ? focused.element : null;
  }, 2_000, ctx.signal, 100, false);
  if (!pathField) throw new ToolError('upload_unverified', 'The file picker did not focus its path field; no path was typed.');
  // Native Unicode keystrokes can drop Photo Booth's U+202F. Set the verified
  // native path field directly so its exact filename survives, then read it back.
  await assertTarget(ctx, url);
  await ctx.helper.call('ax.setValue', { ref: pathField.ref, value: path }, { signal: ctx.signal });
  const typed = await ctx.helper.call('ax.focused', {}, { signal: ctx.signal });
  const panel = nativeFilePicker(await tree(ctx));
  if (typed.bundleId !== CHROME || typed.element?.value !== path || !panel?.some((e) => e.ref === typed.element?.ref)) {
    throw new ToolError('upload_unverified', 'Could not verify the file-picker path; nothing was submitted.');
  }
  // Return accepts only the verified native Go To Folder field. Never press Return in the chat.
  await assertTarget(ctx, url);
  await ctx.helper.call('keyboard.press', { key: 'return', modifiers: [] }, { signal: ctx.signal });
  const ready = await pollUntil(async () => {
    await assertTarget(ctx, url);
    const panel = nativeFilePicker(await tree(ctx));
    const open = panel?.find((e) => button(e) && labels(e).some((s) => OPEN.test(s)));
    // Go to Folder has already accepted the read-back full path. The file list
    // may hide its extension (e.g. “Photo on … AM” with .jpg omitted).
    const name = basename(path);
    const stem = basename(path, extname(path));
    const fileVisible = panel?.some((e) => [...labels(e), e.value, e.identifier].some((s) => s === name || s === stem));
    return open && fileVisible ? open : null;
  }, 3_000, ctx.signal, 100, false);
  if (!ready) throw new ToolError('upload_unverified', 'Could not verify the selected file in the native picker. The message was not submitted.');
  await press(ctx, url, ready);
}

export const browserAttachFile = defineTool({
  id: 'browser.attachFile',
  title: 'Attach a file to the open Qwen chat',
  description:
    "Attach an existing image file to the user's already open Qwen conversation in their signed-in Google Chrome. Selects the existing tab, opens the native upload picker and verifies a new attachment in the composer. NEVER submits, sends, types a message or presses a chat's Send button. Bind path from photobooth_takePhoto output.path. Currently supports Qwen in Chrome only; stops if the page or controls cannot be verified.",
  tier: 3,
  args: z.object({ path: PathArg.refine((p) => !/[\r\n\u0000]/.test(p), 'path must not contain control characters'), site: z.literal('Qwen').default('Qwen'), browser: z.literal('Google Chrome').default('Google Chrome') }),
  output: z.object({ path: z.string(), url: z.string(), title: z.string(), attached: z.literal(true), submitted: z.literal(false), confirmation: z.string() }),
  effectClass: 'external',
  effects: ['fs_read', 'app_control', 'ui_read', 'ui_input', 'external_send'],
  risk: 'high',
  idempotent: false,
  defaultTimeoutMs: 60_000,
  resources: () => [`app:${CHROME}`, 'ui:frontmost'],
  paths: (a) => ({ read: [a.path], write: [] }),
  preview: (a) => ({ summary: `Attach ${basename(a.path)} to the open Qwen chat`, details: ['The file is uploaded to Qwen.', 'The chat message will remain unsent.'] }),
  async run(a, ctx) {
    try {
      const path = await resolveAttachmentPath(a.path);
      if (!/\.(?:jpe?g|png|gif|webp|heic)$/i.test(path)) throw new ToolError('upload_unverified', 'This attachment tool currently supports image files only.');
      if (!(await stat(path)).isFile()) throw new ToolError('upload_unverified', 'The attachment path is not a file.');
      const selected = await runOsaTemplate(ctx.helper, 'chrome.selectQwenTab', {}, ctx.signal);
      const url = selected.items[0] ?? '';
      if (!isQwenUrl(url)) throw new ToolError('upload_unverified', 'Could not identify the existing Qwen tab. Open and select the intended chat in Chrome first.');
      await pollUntil(async () => (await ctx.helper.call('apps.frontmost', {}, { signal: ctx.signal })).app?.bundleId === CHROME ? true : null, 2_000, ctx.signal, 100, false);
      await ctx.helper.call('ax.enableWeb', { bundleId: CHROME, on: true }, { signal: ctx.signal });
      const before = await pollUntil(() => readPage(ctx, url), 4_000, ctx.signal, 150, false);
      if (!before) throw new ToolError('upload_unverified', 'Qwen did not expose its page to Accessibility. No attachment was attempted.');
      const elements = await tree(ctx);
      const composer = chatComposer(elements);
      if (!composer) throw new ToolError('upload_unverified', 'Could not identify a unique Qwen message composer. No attachment was attempted.');
      const region = composerRegion(elements, composer);
      const trigger = attachmentControl(region);
      const initialImages = region.filter((e) => e.role === 'AXImage').length;
      const initialRemoves = region.filter((e) => button(e) && /\b(?:remove|delete)\b/i.test(label(e))).length;
      const initialNames = region.filter((e) => label(e).includes(basename(path))).length;
      ctx.progress('Opening Qwen’s attachment picker');
      // A failed earlier attempt may have left this menu open. Reuse it rather than
      // toggling the plus again and closing the very menu we need.
      const existingMenu = attachmentMenuControl(elements);
      if (!existingMenu) await openAttachment(ctx, url, composer, trigger);
      const opened = existingMenu ? { picker: false, menu: existingMenu } : await pollUntil(async () => {
        await assertTarget(ctx, url);
        const current = await tree(ctx);
        if (nativeFilePicker(current)) return { picker: true, menu: null };
        const menu = attachmentMenuControl(current, elements, trigger?.ref);
        return menu ? { picker: false, menu } : null;
      }, 2_000, ctx.signal, 100, false);
      if (!opened) throw new ToolError('upload_unverified', 'The attachment control did not expose a file picker or a unique upload option. The message remains unsent.');
      if (opened.menu) {
        await press(ctx, url, opened.menu);
        const picker = await pollUntil(async () => nativeFilePicker(await tree(ctx)), 2_000, ctx.signal, 100, false);
        if (!picker) throw new ToolError('upload_unverified', 'Qwen did not open the native file picker. The message remains unsent.');
      }
      await chooseFile(ctx, url, path);
      ctx.progress(`Waiting for Qwen to finish attaching ${basename(path)}`);
      let readyAt = 0;
      const confirmation = await pollUntil(async () => {
        const page = await readPage(ctx, url);
        if (!page) return null;
        const current = await tree(ctx);
        if (nativeFilePicker(current)) return null;
        const field = chatComposer(current);
        const draft = field ? composerRegion(current, field) : [];
        if (FAILED.test(draft.map(label).join('\n'))) throw new ToolError('upload_unverified', 'Qwen reported an upload error. The message was left unsent; check the attachment before retrying.');
        const names = draft.filter((e) => label(e).includes(basename(path))).length;
        const images = draft.filter((e) => e.role === 'AXImage').length;
        const removes = draft.filter((e) => button(e) && /\b(?:remove|delete)\b/i.test(label(e))).length;
        const newAttachment = names > initialNames || (images > initialImages && removes > initialRemoves);
        const busy = page.busy || page.progressIndicators || draft.some((e) => e.role === 'AXProgressIndicator') || UPLOADING.test(draft.map(label).join('\n'));
        if (!newAttachment || busy) { readyAt = 0; return null; }
        readyAt ||= Date.now();
        return Date.now() - readyAt >= 400 ? `Qwen shows the new attachment in its composer; message left unsent.` : null;
      }, 20_000, ctx.signal, 150, false);
      if (!confirmation) throw new ToolError('upload_unverified', 'Could not confirm Qwen finished attaching the file. The message was not submitted. Check the composer before retrying to avoid duplicates.');
      return { path, url, title: selected.items[1] ?? 'Qwen', attached: true as const, submitted: false as const, confirmation };
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (error instanceof ToolError && error.code === 'upload_unverified') throw error;
      // A timeout/stale AX ref after Open may have already uploaded the file. Never let the
      // generic model-repair layer retry this non-idempotent workflow and attach it twice.
      throw new ToolError('upload_unverified', `Attachment stopped: ${error instanceof Error ? error.message : String(error)}. The chat message was not submitted; check the composer before retrying.`);
    }
  },
  summarize: (o) => ({ path: o.path, url: o.url, attached: o.attached, submitted: o.submitted, confirmation: o.confirmation }),
});

export const browserAttachmentTools = [browserAttachFile];
