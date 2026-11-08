import { basename, join } from 'node:path';
import type { AxElement } from '@commandos/contracts';
import { z } from 'zod';
import { PathArg } from './fs';
import { runOsaTemplate } from './osa';
import { attachGmailImages } from './gmail-attachment';
import { pollUntil } from './poll';
import { defineTool, type ToolContext, ToolError } from './types';

/**
 * Gmail in the user's signed-in Chrome: compose URL, native Accessibility readiness checks,
 * and the verified Send button. Screen capture and OCR remain compose fallbacks.
 */
const CHROME = 'com.google.Chrome';
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const SELF = /^(me|myself|self|my ?self|my (?:own )?(?:email|address|account))$/i;
const cleanText = (s: string) => s.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();

/** "Inbox (3) - you@gmail.com - Gmail" → "you@gmail.com" */
export function gmailAccountFromTitle(title: string): string | null {
  return /\s-\s([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s-\s.*\bGmail\b/.exec(title)?.[1] ?? null;
}

export function gmailComposeUrl(d: { to: string; subject: string; body: string; account: string | null }): string {
  const q: Array<[string, string]> = [
    ['view', 'cm'],
    ['fs', '1'],
    ['tf', '1'],
    ['to', d.to],
    ['su', d.subject],
    ['body', d.body],
    ...(d.account ? ([['authuser', d.account]] as Array<[string, string]>) : []),
  ];
  return `https://mail.google.com/mail/?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

async function enableChromePage(ctx: ToolContext): Promise<void> {
  await ctx.helper.call('ax.enableWeb', { bundleId: CHROME, on: true }, { signal: ctx.signal, timeoutMs: 4_000 }).catch(() => {
    ctx.signal.throwIfAborted(); // old helpers and inaccessible pages still have the OCR fallback
  });
}

/** Fast, on-device page evidence; ignore any page outside Gmail. No screenshots on this path. */
async function chromePage(ctx: ToolContext) {
  const p = await ctx.helper.call('ax.webText', { bundleId: CHROME, maxChars: 30_000 }, { signal: ctx.signal, timeoutMs: 4_000 }).catch((error: unknown) => {
    ctx.signal.throwIfAborted();
    ctx.log('debug', 'Gmail page read unavailable', { error: error instanceof Error ? error.message : String(error) });
    return null;
  });
  if (!p?.found || !p.url) return null;
  try {
    return new URL(p.url).hostname === 'mail.google.com' ? p : null;
  } catch {
    return null;
  }
}

async function chromeWindowTitles(ctx: ToolContext): Promise<string[]> {
  const r = await ctx.helper.call('ax.find', { bundleId: CHROME, query: { role: 'AXWindow' }, maxResults: 30, maxDepth: 2 }, { signal: ctx.signal });
  return r.elements.flatMap((e) => (e.title ? [e.title] : []));
}

type WindowText = { text: string; lines: Array<{ text: string; box: number[] }>; frame: { x: number; y: number; width: number; height: number }; title: string | null };

/** Text of Chrome's front window, read on-device (Screen Recording permission). */
async function chromeWindowText(ctx: ToolContext, name: string, timeoutMs = 15_000): Promise<WindowText> {
  const cap = await ctx.helper.call(
    'screen.capture',
    { target: 'window', bundleId: CHROME, outPath: join(ctx.artifactsDir, `${name}-${Date.now()}.png`) },
    { signal: ctx.signal, timeoutMs },
  );
  const ocr = await ctx.helper.call('vision.ocr', { path: cap.path, level: 'accurate' }, { signal: ctx.signal, timeoutMs });
  return { text: ocr.text, lines: ocr.lines, frame: cap.frame, title: cap.windowTitle };
}

/** The same, as optional evidence: null when the screen cannot be read quickly (no permission, macOS prompt pending). */
const chromeWindowTextIfReadable = (ctx: ToolContext, name: string) => chromeWindowText(ctx, name, 4_000).catch(() => null);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** the signed-in account seen in this session, so later drafts need no lookup */
let lastAccount: string | null = null;

async function signedInAccount(ctx: ToolContext): Promise<string | null> {
  const titles = await chromeWindowTitles(ctx).catch(() => []);
  for (const t of titles) {
    const account = gmailAccountFromTitle(t);
    if (account) {
      lastAccount = account;
      return account;
    }
  }
  return null;
}

const gmailLoading = async (ctx: ToolContext) => ((await chromeWindowTitles(ctx).catch(() => [])).some((t) => /\bgmail\b|mail\.google\.com/i.test(t)) ? true : null);

/**
 * "me" → the user's address: Settings, then the account already seen, then a Gmail tab in Chrome.
 * A Gmail tab that is still loading is waited for; a new one is opened only when there is none.
 */
async function resolveRecipient(to: string, ctx: ToolContext): Promise<{ to: string; account: string | null }> {
  const raw = to.trim();
  if (!SELF.test(raw)) {
    if (!EMAIL.test(raw)) throw new ToolError('invalid_recipient', `“${raw}” is not an email address`);
    return { to: raw, account: await signedInAccount(ctx) };
  }
  const known = ctx.settings.userEmail ?? lastAccount;
  if (known) return { to: known, account: lastAccount ?? known };
  let account = await signedInAccount(ctx);
  if (!account && (await pollUntil(() => gmailLoading(ctx), 2_000, ctx.signal, 250))) {
    ctx.progress('Waiting for Gmail to load to find your address');
    account = await pollUntil(() => signedInAccount(ctx), 12_000, ctx.signal);
  }
  if (!account) {
    await ctx.helper.call('workspace.open', { url: 'https://mail.google.com/mail/u/0/#inbox', bundleId: CHROME }, { signal: ctx.signal });
    ctx.progress('Opening Gmail in Chrome to find your address');
    account = await pollUntil(() => signedInAccount(ctx), 20_000, ctx.signal);
  }
  const self = account;
  if (!self) {
    throw new ToolError('needs_user', 'Could not tell which email address is yours: sign in to Gmail in Chrome, set “Your email” in Settings, or say the address.');
  }
  return { to: self, account };
}

/** A full-page compose tab can close before its banner is readable. Look for a
 * matching message in Sent, restricted to this send's time, in the same account.
 * This only reads Gmail; it must never recreate a draft or press Send again.
 */
async function sentReceipt(ctx: ToolContext, a: { to: string; subject: string; body: string }, composeUrl: string, sentAt: number, deadline: number): Promise<string | null> {
  const target = new URL(composeUrl);
  const account = target.searchParams.get('authuser');
  target.search = '';
  if (account) target.searchParams.set('authuser', account);
  const query = `in:sent to:${a.to} after:${Math.floor(sentAt / 1000) - 1}`;
  target.hash = `search/${encodeURIComponent(query)}`;
  const opened = await ctx.helper.call('workspace.open', { url: target.href, bundleId: CHROME }, { signal: ctx.signal, timeoutMs: 2_000 });
  if (!opened.opened) return null;
  ctx.progress('Checking Gmail Sent for the photo or message (no resend)');
  return pollUntil(async () => {
    const p = await chromePage(ctx);
    if (!p?.url) return null;
    const hash = new URL(p.url).hash;
    if (!hash.startsWith('#search/') || decodeURIComponent(hash.slice(8).replace(/\+/g, ' ')) !== query) return null;
    const tree = await ctx.helper.call('ax.tree', { bundleId: CHROME, scope: 'window', maxDepth: 40, maxNodes: 5000 }, { signal: ctx.signal, timeoutMs: 2_000 });
    if (tree.truncated) return null;
    const web = tree.elements.find((e) => e.role === 'AXWebArea');
    const elements = web ? tree.elements.filter((e) => e.ref.startsWith(`${web.ref}.`)) : [];
    const matches = elements.filter((e) => e.role === 'AXRow').filter((row) => {
      const cells = elements.filter((e) => e.ref.startsWith(`${row.ref}.`));
      const values = cells.flatMap((e) => [e.title, e.label, e.value, e.description]).filter((s): s is string => s !== null).map(cleanText);
      const subject = cleanText(a.subject);
      const body = cleanText(a.body).slice(0, 40);
      return (subject ? values.some((s) => s === subject) : !!body) && (!body || values.join(' ').includes(body));
    });
    return matches.length === 1 ? 'Verified the matching new message in Gmail Sent' : null;
  }, Math.max(0, deadline - Date.now()), ctx.signal, 200);
}

export const gmailCompose = defineTool({
  id: 'gmail.compose',
  title: 'Open a Gmail draft',
  description:
    'Open a Gmail draft in Google Chrome with recipient, subject and body filled in, using the Gmail account signed in there. Nothing is sent. Use to "me" when the user emails themself. attachments: image files (e.g. a photo path bound from photobooth_takePhoto) are attached through Gmail’s native file picker and verified before sending; other file types are not supported, so for those finish with needs_user. Follow with gmail_send to send it. Never drive Gmail’s web page with ui_* tools.',
  tier: 2,
  args: z.object({
    to: z.string().min(1).max(320),
    subject: z.string().max(500).default(''),
    body: z.string().max(20_000).default(''),
    attachments: z.array(PathArg).max(4).default([]),
  }),
  output: z.object({ to: z.string(), subject: z.string(), body: z.string(), account: z.string().nullable(), windowTitle: z.string(), attached: z.array(z.string()) }),
  effectClass: 'reversible_local',
  effects: ['app_control'],
  risk: 'low',
  idempotent: false,
  defaultTimeoutMs: 60_000,
  resources: () => [`app:${CHROME}`, 'ui:frontmost'],
  paths: (a) => ({ read: a.attachments ?? [], write: [] }),
  preview: (a) => ({
    summary: `Open a Gmail draft to ${a.to}`,
    details: [`Subject: ${a.subject ?? ''}`, (a.body ?? '').slice(0, 300), ...(a.attachments ?? []).map((p) => `Attach ${basename(p)}`)],
  }),
  async run(a, ctx) {
    const { to, account } = await resolveRecipient(a.to, ctx);
    await enableChromePage(ctx);
    const opened = await ctx.helper.call('workspace.open', { url: gmailComposeUrl({ to, subject: a.subject, body: a.body, account }), bundleId: CHROME }, { signal: ctx.signal });
    if (!opened.opened) throw new ToolError('not_opened', 'Chrome did not open the Gmail draft');
    ctx.progress('Waiting for the Gmail draft to load');
    const marker = (a.subject || a.body).trim().slice(0, 40).toLowerCase();
    let title = await pollUntil(
      async () => {
        const titles = await chromeWindowTitles(ctx);
        const draft = titles.find((t) => /\bcompose\b/i.test(t));
        const p = await chromePage(ctx);
        if (draft && !p) return draft;
        return p && /\bSend\b/.test(p.text) && (!marker || p.text.toLowerCase().includes(marker)) ? p.title : null;
      },
      8_000,
      ctx.signal,
    );
    if (!title) {
      // fall back to what the window shows: a Send button and the draft's own text
      const seen = await pollUntil(
        async () => {
          const w = await chromeWindowTextIfReadable(ctx, 'gmail-draft');
          return w && /\bSend\b/.test(w.text) && (!marker || w.text.toLowerCase().includes(marker)) ? (w.title ?? 'Gmail draft') : null;
        },
        12_000,
        ctx.signal,
        1_000,
      );
      if (!seen) throw new ToolError('not_opened', 'Gmail did not show a draft in Chrome (are you signed in to Gmail there?)');
      title = seen;
    }
    const attached = a.attachments.length ? await attachGmailImages(ctx, a.attachments, () => chromePage(ctx)) : [];
    return { to, subject: a.subject, body: a.body, account: gmailAccountFromTitle(title) ?? account, windowTitle: title, attached };
  },
  summarize: (o) => ({ to: o.to, subject: o.subject, account: o.account, windowTitle: o.windowTitle, attached: o.attached.map((p) => basename(p)) }),
});

export const gmailSend = defineTool({
  id: 'gmail.send',
  title: 'Send the Gmail draft',
  description:
    'Verify the recipient, subject and body of the Gmail draft that gmail_compose opened, press its Send button exactly once, and wait for Gmail’s sent confirmation. Bind to/subject/body from gmail_compose so approval shows the exact email. Never retry an uncertain send; ask the user to check Sent. Always needs approval; cannot be undone.',
  tier: 3,
  args: z.object({ to: z.string().min(1).max(320), subject: z.string().max(500), body: z.string().max(20_000) }),
  output: z.object({ sent: z.boolean(), confirmation: z.string() }),
  effectClass: 'external',
  effects: ['external_send', 'ui_input'],
  risk: 'high',
  idempotent: false,
  defaultTimeoutMs: 45_000,
  // keystrokes and clicks go to the frontmost app: nothing else may use the UI meanwhile
  resources: () => [`app:${CHROME}`, 'ui:frontmost'],
  recipients: (a) => [a.to],
  preview: (a) => ({
    summary: `Send an email to ${a.to} from Gmail`,
    details: [`Subject: ${a.subject || '(none)'}`, a.body.slice(0, 1000) || '(empty body)', 'This cannot be undone.'],
  }),
  async run(a, ctx) {
    if (!EMAIL.test(a.to)) throw new ToolError('precondition', 'The draft recipient must be the resolved email address; nothing was sent.');
    await ctx.helper.call('apps.activate', { bundleId: CHROME }, { signal: ctx.signal });
    await enableChromePage(ctx);
    const before = await pollUntil(
      async () => {
        const p = await chromePage(ctx);
        return p ? p : null;
      },
      2_000,
      ctx.signal,
    );
    if (!before) throw new ToolError('precondition', 'No Gmail draft is open in Chrome; nothing was sent.');
    const tree = await ctx.helper.call('ax.tree', { bundleId: CHROME, scope: 'window', maxDepth: 40, maxNodes: 5000 }, { signal: ctx.signal, timeoutMs: 2_000 });
    if (tree.truncated) throw new ToolError('precondition', 'Could not read the complete Gmail draft; nothing was sent.');
    const web = tree.elements.find((e) => e.role === 'AXWebArea');
    const elements = web ? tree.elements.filter((e) => e.ref.startsWith(`${web.ref}.`)) : [];
    const clean = cleanText;
    const labels = (e: AxElement) => [e.title, e.label, e.description].filter((s): s is string => s !== null).map(clean);
    const buttons = elements.filter((e) => e.role === 'AXButton' && e.enabled !== false && labels(e).some((s) => /^Send(?:\s*\([^)]*(?:Enter|Return)[^)]*\))?$/i.test(s)));
    const subjects = elements.filter((e) => e.role === 'AXTextField' && labels(e).some((s) => /^Subject$/i.test(s)));
    const bodies = elements.filter((e) => e.role === 'AXTextArea' && labels(e).some((s) => /^Message Body$/i.test(s)));
    if (buttons.length !== 1 || subjects.length !== 1 || bodies.length !== 1) {
      throw new ToolError('precondition', 'Could not identify one Gmail draft and its Send button; nothing was sent.');
    }
    const subject = subjects[0]!;
    // The full-page composer exposes recipient chips immediately before Subject.
    // Check those live values as well as the compose URL; the user may have edited a chip.
    const recipientText = elements.slice(0, elements.indexOf(subject)).filter((e) => ['AXStaticText', 'AXTextField'].includes(e.role))
      .flatMap((e) => [e.title, e.label, e.value]).filter((s): s is string => s !== null).join('\n');
    const recipients = [...new Set((recipientText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((s) => s.toLowerCase()))];
    const urlTo = new URL(before.url!).searchParams.get('to');
    if (recipients.length !== 1 || recipients[0] !== a.to.toLowerCase() || (urlTo && urlTo.toLowerCase() !== a.to.toLowerCase())
      || clean(subject.value ?? '') !== clean(a.subject) || clean(bodies[0]!.value ?? '') !== clean(a.body)) {
      throw new ToolError('precondition', 'The Gmail draft does not match the approved recipient, subject and body; nothing was sent.');
    }
    if (before.busy || before.progressIndicators) throw new ToolError('page_not_ready', 'Gmail is still busy uploading; the draft was left unsent.');
    const button = buttons[0]!;
    const sentAt = Date.now();
    const deadline = sentAt + 8_000;
    const uncertain = () => new ToolError('send_unverified', 'Pressed Gmail’s Send button once, but Gmail did not confirm sending. Check Sent and the open draft before retrying to avoid a duplicate.');
    // Never fall back to another send after a dispatched action: an RPC failure
    // or a missing banner does not prove the first action had no external effect.
    try {
      if (button.actions.includes('AXPress')) {
        const pressed = await ctx.helper.call('ax.press', { ref: button.ref }, { signal: ctx.signal, timeoutMs: 2_000 });
        if (!pressed.ok) throw uncertain();
      } else if (button.frame) {
        const f = button.frame;
        await ctx.helper.call('mouse.click', { x: f.x + f.width / 2, y: f.y + f.height / 2, button: 'left', clicks: 1 }, { signal: ctx.signal });
      } else {
        throw new ToolError('precondition', 'Gmail’s Send button cannot be pressed; nothing was sent.');
      }
    } catch (error) {
      if (error instanceof ToolError && error.code === 'precondition') throw error;
      ctx.signal.throwIfAborted();
      throw uncertain();
    }
    const sentBanner = (text: string) => text.split('\n').some((s) => /^(?:your )?message (?:has been |was )?sent[.!]?(?:\s*(?:undo|view message)\b.*)?$/i.test(clean(s)));
    const hadSentBanner = sentBanner(before.text);
    let confirmation = await pollUntil(async () => {
      const p = await chromePage(ctx);
      // A pre-existing banner/body string or a closed/navigated tab is not a send acknowledgement.
      if (p && !hadSentBanner && sentBanner(p.text)) return 'Gmail confirmed the message was sent';
      return !p || p.url !== before.url ? 'check_sent' : null;
    }, Math.max(0, deadline - Date.now()), ctx.signal, 150);
    if (confirmation === 'check_sent') {
      confirmation = await sentReceipt(ctx, a, before.url!, sentAt, deadline).catch(() => {
        ctx.signal.throwIfAborted();
        return null;
      });
    }
    if (!confirmation) {
      throw uncertain();
    }
    return { sent: true, confirmation };
  },
});

export const gmailTools = [gmailCompose, gmailSend];
