import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { AxElement, HelperResult } from '@commandos/contracts';
import { nativeFilePicker, resolveAttachmentPath } from './browser-attachment';
import { runOsaTemplate } from './osa';
import { pollUntil } from './poll';
import { type ToolContext, ToolError } from './types';

const CHROME = 'com.google.Chrome';
const clean = (s: string) => s.normalize('NFC').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
const labels = (e: AxElement) => [e.title, e.label, e.description, e.value, e.identifier].filter((s): s is string => Boolean(s)).map(clean);
const inside = (e: AxElement, ref: string) => e.ref.startsWith(`${ref}.`);
const fail = (message: string) => new ToolError('upload_unverified', `${message} The draft was left unsent; check its attachment before retrying.`);
type PageReader = () => Promise<HelperResult<'ax.webText'> | null>;

async function readTree(ctx: ToolContext) {
  const tree = await ctx.helper.call('ax.tree', { bundleId: CHROME, scope: 'window', maxDepth: 40, maxNodes: 5000 }, { signal: ctx.signal, timeoutMs: 3_000 });
  if (tree.truncated) throw fail('Could not read the complete Gmail attachment controls.');
  return tree.elements;
}

/** Require one compose form; inbox/history text is never attachment evidence. */
function draftElements(elements: AxElement[]) {
  const bodies = elements.filter((e) => e.role === 'AXTextArea' && labels(e).includes('Message Body'));
  const subjects = elements.filter((e) => e.role === 'AXTextField' && labels(e).includes('Subject'));
  if (bodies.length !== 1 || subjects.length !== 1) throw fail('Could not identify one Gmail draft.');
  const web = elements.filter((e) => e.role === 'AXWebArea' && inside(bodies[0]!, e.ref) && inside(subjects[0]!, e.ref))
    .sort((a, b) => b.ref.length - a.ref.length)[0];
  if (!web) throw fail('Gmail did not expose its compose form.');
  return elements.filter((e) => inside(e, web.ref));
}

function attachmentElements(elements: AxElement[]) {
  const fields = elements.filter((e) => ['AXTextArea', 'AXTextField'].includes(e.role));
  return elements.filter((e) => !fields.some((field) => e.ref === field.ref || inside(e, field.ref)));
}

async function assertTarget(ctx: ToolContext, url: string) {
  ctx.signal.throwIfAborted();
  const front = await ctx.helper.call('apps.frontmost', {}, { signal: ctx.signal });
  if (front.app?.bundleId !== CHROME) throw fail('Chrome lost keyboard focus.');
  // Unlike AXWebArea, Chrome's tab URL remains available while a native sheet is open.
  const tab = await runOsaTemplate(ctx.helper, 'chrome.frontTab', {}, ctx.signal);
  if (tab.items[0] !== url) throw fail('The selected Gmail draft changed.');
}

async function chooseFile(ctx: ToolContext, url: string, path: string) {
  await assertTarget(ctx, url);
  if (!nativeFilePicker(await readTree(ctx))) throw fail('Gmail did not open the native file picker.');
  await ctx.helper.call('keyboard.press', { key: 'g', modifiers: ['command', 'shift'] }, { signal: ctx.signal });
  const pathField = await pollUntil(async () => {
    await assertTarget(ctx, url);
    const focused = await ctx.helper.call('ax.focused', {}, { signal: ctx.signal });
    const panel = nativeFilePicker(await readTree(ctx));
    return focused.bundleId === CHROME && focused.element && ['AXTextField', 'AXComboBox'].includes(focused.element.role)
      && panel?.some((e) => e.ref === focused.element?.ref) ? focused.element : null;
  }, 2_000, ctx.signal, 100, false);
  if (!pathField) throw fail('The file picker did not focus its path field.');
  // Preserve Photo Booth's U+202F before AM/PM; synthesized typing can drop it.
  await assertTarget(ctx, url);
  await ctx.helper.call('ax.setValue', { ref: pathField.ref, value: path }, { signal: ctx.signal });
  const typed = await ctx.helper.call('ax.focused', {}, { signal: ctx.signal });
  const panel = nativeFilePicker(await readTree(ctx));
  if (typed.bundleId !== CHROME || typed.element?.value !== path || !panel?.some((e) => e.ref === typed.element?.ref)) {
    throw fail('Could not verify the exact attachment path.');
  }
  await assertTarget(ctx, url);
  // Return is restricted to the read-back native path field, never the email body.
  await ctx.helper.call('keyboard.press', { key: 'return', modifiers: [] }, { signal: ctx.signal });
  const open = await pollUntil(async () => {
    await assertTarget(ctx, url);
    const panel = nativeFilePicker(await readTree(ctx));
    const button = panel?.find((e) => e.role === 'AXButton' && e.enabled !== false && labels(e).includes('Open'));
    // Finder may hide the extension. Go to Folder has already accepted the full path.
    const names = [basename(path), basename(path, extname(path))].map(clean);
    return button && panel?.some((e) => labels(e).some((s) => names.includes(s))) ? button : null;
  }, 3_000, ctx.signal, 100, false);
  if (!open) throw fail('Could not verify the selected file in the native picker.');
  await assertTarget(ctx, url);
  const pressed = await ctx.helper.call('ax.press', { ref: open.ref }, { signal: ctx.signal });
  if (!pressed.ok) throw fail('The file picker did not acknowledge the selected file.');
}

/** Attach the actual files through Gmail's picker, without clipboard images or guessed coordinates. */
export async function attachGmailImages(ctx: ToolContext, inputs: string[], readPage: PageReader): Promise<string[]> {
  try {
    const paths: string[] = [];
    for (const input of inputs) {
      const path = await resolveAttachmentPath(input);
      if (!/\.(jpe?g|png|gif|tiff?)$/i.test(path)) throw new ToolError('unsupported_attachment', `Only images can be attached for now (${basename(path)}).`);
      if (!(await stat(path)).isFile()) throw fail('The attachment path is not a file.');
      paths.push(path);
    }
    await ctx.helper.call('apps.activate', { bundleId: CHROME }, { signal: ctx.signal });
    for (const path of paths) {
      ctx.progress('Waiting for Gmail’s attachment controls to finish loading');
      let readinessIssue = 'the compose page was not readable';
      // The Compose window title can appear before its AX document is available.
      // Retry only these reads; never reopen the draft or repeat an upload here.
      const before = await pollUntil(async () => {
        const page = await readPage();
        if (!page?.url) { readinessIssue = 'the compose page was not readable'; return null; }
        if (page.truncated) { readinessIssue = 'the page read was incomplete'; return null; }
        if (page.busy === undefined || page.progressIndicators === undefined) {
          readinessIssue = 'the helper did not return upload-state information';
          return null;
        }
        if (page.busy || page.progressIndicators) { readinessIssue = 'Gmail was still busy'; return null; }
        return page;
      }, 10_000, ctx.signal, 200, false);
      if (!before?.url) throw fail(`Gmail attachment controls did not become ready: ${readinessIssue}.`);
      const url = before.url;
      await assertTarget(ctx, url);
      const initial = draftElements(await readTree(ctx));
      const triggers = initial.filter((e) => ['AXButton', 'AXPopUpButton'].includes(e.role) && e.enabled !== false && labels(e).includes('Attach files'));
      if (triggers.length !== 1) throw fail('Could not identify Gmail’s Attach files control.');
      const name = clean(basename(path));
      const filenameCount = (elements: AxElement[]) => elements.filter((e) => labels(e).some((s) => s.includes(name))).length;
      const initialNames = filenameCount(attachmentElements(initial));
      ctx.progress(`Attaching ${basename(path)} with Gmail’s file picker`);
      await assertTarget(ctx, url);
      const clicked = await ctx.helper.call('ax.click', { bundleId: CHROME, role: triggers[0]!.role, text: 'Attach files', expectLabel: 'Attach files' }, { signal: ctx.signal });
      if (!clicked.clicked) throw fail('Gmail’s Attach files control did not open.');
      const picker = await pollUntil(async () => {
        await assertTarget(ctx, url);
        return nativeFilePicker(await readTree(ctx));
      }, 2_000, ctx.signal, 100, false);
      if (!picker) throw fail('Gmail did not open the native file picker.');
      await chooseFile(ctx, url, path);
      let readyAt: number | null = null;
      const uploaded = await pollUntil(async () => {
        await assertTarget(ctx, url);
        const page = await readPage();
        if (!page || page.url !== url || page.truncated) { readyAt = null; return null; }
        const elements = await readTree(ctx);
        if (nativeFilePicker(elements)) return null;
        const draft = attachmentElements(draftElements(elements));
        const text = draft.flatMap(labels).join('\n');
        if (/\b(?:upload failed|failed to upload|couldn[’']t upload|failed to attach|file (?:is )?too large)\b/i.test(text)) throw fail('Gmail reported an attachment error.');
        const busy = page.busy !== false || page.progressIndicators !== 0 || draft.some((e) => e.role === 'AXProgressIndicator') || /\b(?:uploading|attaching)\b/i.test(text);
        if (busy || filenameCount(draft) <= initialNames) { readyAt = null; return null; }
        readyAt ??= Date.now();
        return Date.now() - readyAt >= 300 ? true : null;
      }, 20_000, ctx.signal, 100, false);
      if (!uploaded) throw fail(`Could not confirm Gmail finished attaching ${basename(path)}.`);
      ctx.progress(`Verified Gmail attached ${basename(path)}`);
    }
    return paths;
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (error instanceof ToolError && ['upload_unverified', 'unsupported_attachment'].includes(error.code)) throw error;
    // Open may already have uploaded the file. Never let model repair repeat an uncertain upload.
    throw fail(`Attachment stopped: ${error instanceof Error ? error.message : String(error)}.`);
  }
}
