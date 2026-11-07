import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { UndoOp } from '@commandos/contracts';
import { z } from 'zod';
import type { HelperClient } from './helper/client';
import { scrubbedEnv } from './terminal';
import { defineTool, ToolError } from './types';

const execFileP = promisify(execFile);

/** AppleScript string literal (escapes backslashes and quotes). */
export function asString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Fixed Apple Events templates. The model chooses a template and supplies string parameters;
 * it never authors AppleScript. Each template that creates something has an inverse so undo works.
 */
export const OSA_TEMPLATES: Record<string, (p: Record<string, string>) => string> = {
  'notes.create': (p) =>
    `tell application "Notes"\nset n to make new note at folder "Notes" with properties {name:${asString(p.title ?? '')}, body:${asString(p.body ?? '')}}\nreturn id of n\nend tell`,
  'notes.delete': (p) => `tell application "Notes" to delete note id ${asString(p.id ?? '')}`,
  'reminders.create': (p) =>
    `tell application "Reminders"\nset r to make new reminder with properties {name:${asString(p.title ?? '')}, body:${asString(p.notes ?? '')}}\nreturn id of r\nend tell`,
  'reminders.delete': (p) => `tell application "Reminders" to delete (every reminder whose id is ${asString(p.id ?? '')})`,
  'textedit.new': (p) =>
    `tell application "TextEdit"\nactivate\nset d to make new document with properties {text:${asString(p.text ?? '')}}\nreturn name of d\nend tell`,
  'textedit.close': (p) => `tell application "TextEdit" to close (every document whose name is ${asString(p.name ?? '')}) saving no`,
  'finder.selection': () =>
    'tell application "Finder"\nset out to {}\nrepeat with f in (selection as alias list)\nset end of out to POSIX path of f\nend repeat\nreturn out\nend tell',
  'safari.frontTab': () => 'tell application "Safari" to return {URL of front document, name of front document}',
  'chrome.frontTab': () => 'tell application "Google Chrome" to return {URL of active tab of front window, title of active tab of front window}',
  // Select an existing Qwen tab, preserving its conversation. Never navigate or create a tab.
  // An already selected Qwen tab wins; otherwise require exactly one matching tab.
  'chrome.selectQwenTab': () => `if application "Google Chrome" is not running then error "Open your Qwen tab in Chrome first."
tell application "Google Chrome"
set chosenWindow to 0
set chosenTab to 0
set matches to {}
if (count of windows) > 0 then
set currentURL to URL of active tab of front window
if currentURL is "https://chat.qwen.ai" or currentURL starts with "https://chat.qwen.ai/" or currentURL is "https://chat.qwenlm.ai" or currentURL starts with "https://chat.qwenlm.ai/" then
set chosenWindow to id of front window
set chosenTab to active tab index of front window
end if
end if
if chosenWindow is 0 then
repeat with w in windows
repeat with i from 1 to count of tabs of w
set tabURL to URL of tab i of w
if tabURL is "https://chat.qwen.ai" or tabURL starts with "https://chat.qwen.ai/" or tabURL is "https://chat.qwenlm.ai" or tabURL starts with "https://chat.qwenlm.ai/" then set end of matches to {id of w, i}
end repeat
end repeat
if (count of matches) is 0 then error "No Qwen tab is open in Chrome."
if (count of matches) > 1 then error "Several Qwen tabs are open. Select the chat you want first."
set chosenWindow to item 1 of item 1 of matches
set chosenTab to item 2 of item 1 of matches
end if
set w to window id chosenWindow
set active tab index of w to chosenTab
set index of w to 1
activate
return {URL of active tab of w, title of active tab of w}
end tell`,
  // puts an image file on the clipboard (Standard Additions only: no app is controlled)
  'clipboard.setImage': (p) =>
    `set the clipboard to (read (POSIX file ${asString(p.path ?? '')}) as ${/\.png$/i.test(p.path ?? '') ? '«class PNGf»' : /\.gif$/i.test(p.path ?? '') ? 'GIF picture' : /\.tiff?$/i.test(p.path ?? '') ? 'TIFF picture' : 'JPEG picture'})`,
  'system.notify': (p) => `display notification ${asString(p.message ?? '')} with title ${asString(p.title ?? 'CommandOS')}`,
};

export async function runOsaTemplate(helper: HelperClient, template: string, params: Record<string, string>, signal?: AbortSignal) {
  const render = OSA_TEMPLATES[template];
  if (!render) throw new ToolError('unknown_template', `unknown Apple Events template ${template}`);
  return helper.call('osa.run', { source: render(params) }, { signal, timeoutMs: 30_000 });
}

export const notesCreate = defineTool({
  id: 'notes.create',
  undo: 'journaled',
  title: 'Create note',
  description: 'Create a note in Apple Notes with a title and body (Apple Events). Undo deletes it.',
  tier: 2,
  args: z.object({ title: z.string().min(1).max(200), body: z.string().max(50_000) }),
  output: z.object({ noteId: z.string() }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'low',
  idempotent: false,
  defaultTimeoutMs: 30_000,
  resources: () => ['app:com.apple.Notes'],
  preview: (a) => ({ summary: `Create note “${a.title}”`, details: [a.body.slice(0, 300)] }),
  async run(a, ctx) {
    const r = await runOsaTemplate(ctx.helper, 'notes.create', { title: a.title, body: a.body }, ctx.signal);
    if (!r.result) throw new ToolError('no_result', 'Notes did not return the new note id');
    const op: UndoOp = { kind: 'applescript', template: 'notes.delete', params: { id: r.result }, description: `delete note “${a.title}”` };
    await ctx.journal.record(op);
    return { noteId: r.result };
  },
});

export const remindersCreate = defineTool({
  id: 'reminders.create',
  undo: 'journaled',
  title: 'Create reminder',
  description: 'Create a reminder in Apple Reminders (Apple Events). Undo deletes it.',
  tier: 2,
  args: z.object({ title: z.string().min(1).max(200), notes: z.string().max(5000).default('') }),
  output: z.object({ reminderId: z.string() }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'low',
  idempotent: false,
  defaultTimeoutMs: 30_000,
  resources: () => ['app:com.apple.reminders'],
  preview: (a) => ({ summary: `Create reminder “${a.title}”`, details: [] }),
  async run(a, ctx) {
    const r = await runOsaTemplate(ctx.helper, 'reminders.create', { title: a.title, notes: a.notes }, ctx.signal);
    if (!r.result) throw new ToolError('no_result', 'Reminders did not return the new reminder id');
    await ctx.journal.record({ kind: 'applescript', template: 'reminders.delete', params: { id: r.result }, description: `delete reminder “${a.title}”` });
    return { reminderId: r.result };
  },
});

export const textEditNew = defineTool({
  id: 'textedit.newDocument',
  undo: 'journaled',
  title: 'New TextEdit document',
  description: 'Open TextEdit with a new (unsaved) document containing the given text (Apple Events). Undo closes it without saving.',
  tier: 2,
  args: z.object({ text: z.string().max(200_000) }),
  output: z.object({ documentName: z.string() }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'low',
  idempotent: false,
  defaultTimeoutMs: 30_000,
  resources: () => ['app:com.apple.TextEdit'],
  async run(a, ctx) {
    const r = await runOsaTemplate(ctx.helper, 'textedit.new', { text: a.text }, ctx.signal);
    if (!r.result) throw new ToolError('no_result', 'TextEdit did not return the document name');
    await ctx.journal.record({ kind: 'applescript', template: 'textedit.close', params: { name: r.result }, description: `close TextEdit document “${r.result}” without saving` });
    return { documentName: r.result };
  },
});

export const finderSelection = defineTool({
  id: 'finder.selection',
  title: 'Get Finder selection',
  description: 'Return the POSIX paths of the files currently selected in Finder (Apple Events).',
  tier: 2,
  args: z.object({}),
  output: z.object({ paths: z.array(z.string()) }),
  effectClass: 'read',
  effects: ['ui_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 15_000,
  async run(_a, ctx) {
    const r = await runOsaTemplate(ctx.helper, 'finder.selection', {}, ctx.signal);
    return { paths: r.items.length ? r.items : r.result ? [r.result] : [] };
  },
});

export const browserFrontTab = defineTool({
  id: 'browser.frontTab',
  title: 'Current browser tab',
  description: 'Return the URL and title of the frontmost tab of Safari or Google Chrome on this Mac (read-only, Apple Events).',
  tier: 2,
  args: z.object({ browser: z.enum(['Safari', 'Google Chrome']) }),
  output: z.object({ url: z.string(), title: z.string() }),
  effectClass: 'read',
  effects: ['ui_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 15_000,
  async run(a, ctx) {
    const r = await runOsaTemplate(ctx.helper, a.browser === 'Safari' ? 'safari.frontTab' : 'chrome.frontTab', {}, ctx.signal);
    return { url: r.items[0] ?? '', title: r.items[1] ?? '' };
  },
});

export const systemNotify = defineTool({
  id: 'system.notify',
  title: 'Show notification',
  description: 'Show a macOS notification banner with a title and message.',
  tier: 2,
  args: z.object({ title: z.string().min(1).max(100), message: z.string().min(1).max(500) }),
  output: z.object({ shown: z.boolean() }),
  effectClass: 'irreversible_local',
  effects: ['app_control'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 10_000,
  async run(a, ctx) {
    await runOsaTemplate(ctx.helper, 'system.notify', { title: a.title, message: a.message }, ctx.signal);
    return { shown: true };
  },
});

export const shortcutsList = defineTool({
  id: 'shortcuts.list',
  title: 'List Shortcuts',
  description: "List the user's Shortcuts (names) available to run.",
  tier: 2,
  args: z.object({}),
  output: z.object({ shortcuts: z.array(z.string()) }),
  effectClass: 'read',
  effects: ['app_control'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 20_000,
  async run() {
    const { stdout } = await execFileP('/usr/bin/shortcuts', ['list'], { env: scrubbedEnv(), timeout: 15_000 });
    return { shortcuts: stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
  },
});

export const shortcutsRun = defineTool({
  id: 'shortcuts.run',
  title: 'Run Shortcut',
  description: "Run one of the user's Shortcuts by exact name, optionally with text input. Shortcuts can do anything, so this always asks first.",
  tier: 2,
  args: z.object({ name: z.string().min(1).max(200), input: z.string().max(20_000).optional() }),
  output: z.object({ output: z.string() }),
  effectClass: 'irreversible_local',
  effects: ['app_control', 'process_exec'],
  risk: 'medium',
  idempotent: false,
  defaultTimeoutMs: 120_000,
  preview: (a) => ({ summary: `Run the Shortcut “${a.name}”`, details: a.input ? [a.input.slice(0, 300)] : [] }),
  async run(a, ctx) {
    const args = ['run', a.name];
    let dir: string | null = null;
    if (a.input !== undefined) {
      dir = await mkdtemp(join(tmpdir(), 'commandos-shortcut-'));
      const file = join(dir, 'input.txt');
      await writeFile(file, a.input, 'utf8');
      args.push('--input-path', file);
    }
    try {
      const { stdout } = await execFileP('/usr/bin/shortcuts', args, { env: scrubbedEnv(), timeout: 110_000, signal: ctx.signal });
      return { output: stdout.slice(0, 20_000) };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  },
});

export const osaTools = [notesCreate, remindersCreate, textEditNew, finderSelection, browserFrontTab, systemNotify, shortcutsList, shortcutsRun];
