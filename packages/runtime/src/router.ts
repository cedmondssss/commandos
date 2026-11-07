import { IntentSchema, type RouteDecision } from '@commandos/contracts';
import { type ModelGateway, OpenInferenceSpanKind, SemanticConventions, spanJson, withSpan } from '@commandos/providers';
import { z } from 'zod';
import { matchQuickCommand, type QuickStep } from './quick';
import { matchPageQuestion, type PageQuestion } from './page-question';
import { matchExistingAttachment, matchPhotoAttachment } from './photo-attachment';

export type ControlAction = 'cancel' | 'undo' | 'approve' | 'deny' | 'emergency_stop';

export interface OrganizeSlots {
  count: number | null;
  sourceFolder: string | null;
  destinationFolder: string | null;
  destinationName: string | null;
  renameByContent: boolean;
  groupByCategory: boolean;
  withinDays: number | null;
  report: boolean;
  reportTitle: string | null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  fifty: 50,
  'a couple of': 2,
  'a few': 3,
};

function toNumber(word: string | undefined): number | null {
  if (!word) return null;
  const w = word.toLowerCase().trim();
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w] ?? null;
}

const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|fifty|a couple of|a few)';

const KNOWN_FOLDERS: Record<string, string> = {
  desktop: '~/Desktop',
  downloads: '~/Downloads',
  documents: '~/Documents',
  pictures: '~/Pictures',
  'commandos-demo': '~/CommandOS-Demo',
  'commandos demo': '~/CommandOS-Demo',
  'demo folder': '~/CommandOS-Demo/Screenshots',
};

function folderFrom(phrase: string | undefined): string | null {
  if (!phrase) return null;
  const p = phrase.trim().replace(/[.,!?]+$/, '');
  if (p.startsWith('~/') || p.startsWith('/')) return p;
  const key = p.toLowerCase().replace(/^(my|the)\s+/, '');
  return KNOWN_FOLDERS[key] ?? null;
}

/** Finds a folder the user named (known folders like "my downloads", or ~/ and absolute paths). */
export function extractFolder(text: string): string | null {
  const m = /\b(?:from|in|on|for|of|to|inside|within)\s+((?:my|the)\s+)?(desktop|downloads|documents|pictures|commandos[- ]demo|demo folder|~\/[^\s,;]+|\/[^\s,;]+)/i.exec(text);
  return folderFrom(m?.[2]);
}

/** "Do the same for …", "repeat that on …", "again with …": reuse a stored procedure. */
export function matchReplay(text: string): boolean {
  return /\b(do (the )?same( thing)?|same as (before|last time)|repeat (that|it|this|the last( one)?|what you did)|again (for|with|on|in)|like (before|last time))\b/i.test(text);
}

/** "Run the tests in <repo> and fix/patch the failures": the repository test-and-fix workflow. */
export function matchRepoFix(text: string): { repoPath: string } | null {
  const t = text.toLowerCase();
  if (!/\b(tests?|test suite|specs?)\b/.test(t)) return null;
  if (!/\b(fix|patch|repair|failing|failures|broken|debug)\b/.test(t)) return null;
  if (/\b(push|deploy|publish|merge|release)\b/.test(t)) return null;
  const path = /(~\/[^\s,;"'”]+|\/[^\s,;"'”]+)/.exec(text)?.[1]?.replace(/[.,!?]+$/, '');
  return path ? { repoPath: path } : null;
}

/** Cancel/undo/approve/deny/stop: handled locally with zero model calls. */
export function matchControl(text: string): ControlAction | null {
  const t = text.toLowerCase().trim().replace(/[.!?]+$/, '');
  if (/^(emergency stop|stop everything|abort everything|kill (it|everything))$/.test(t)) return 'emergency_stop';
  if (/^(stop|cancel|abort|never ?mind)( (it|that|this|the run|the task))?$/.test(t)) return 'cancel';
  if (/^undo( (it|that|this|the last (run|one)|last run))?$/.test(t)) return 'undo';
  if (/^(approve|approved|yes|yes please|confirm|go ahead|do it)$/.test(t)) return 'approve';
  if (/^(deny|denied|no|reject|don'?t)$/.test(t)) return 'deny';
  return null;
}

/**
 * Deterministic grammar for the screenshot-organizing workflow. Returns null whenever the
 * phrasing is ambiguous or contains risky verbs, so those commands go to the router model.
 */
export function matchOrganizeScreenshots(text: string): OrganizeSlots | null {
  const t = text.toLowerCase();
  if (!/\bscreen ?shots?\b/.test(t)) return null;
  if (/\b(delete|trash|remove|erase|send|e-?mail|upload|share|post|publish|print)\b/.test(t)) return null;
  // "clean up" / "tidy" may mean deleting or archiving everything: the router model decides those
  if (/\b(tidy|clean ?up|cleanup|archiv\w*|declutter)\b/.test(t)) return null;
  if (!/\b(organi[sz]e|rename|sort|move|put|file them|group|classify|categori[sz]e)\b/.test(t)) return null;

  const countMatch =
    new RegExp(`\\b(?:latest|last|newest|recent|most recent)\\s+${NUM}\\b`).exec(t) ??
    new RegExp(`\\b${NUM}\\s+(?:latest|last|newest|most recent|recent)?\\s*screen ?shots?\\b`).exec(t);
  const count = toNumber(countMatch?.[1]);

  const named = /(?:folder|directory)\s+(?:called|named|titled)\s+["“']?(.+?)["”']?(?=\s+(?:and|then|on|in|under|with|from|so)\b|\s*[.,!?;]|$)/i.exec(text);
  const destinationName = named?.[1]?.trim() ?? null;

  const source = /\b(?:from|in|on)\s+((?:my|the)\s+)?(desktop|downloads|documents|pictures|commandos[- ]demo|demo folder|~\/[^\s,]+|\/[^\s,]+)/i.exec(text);
  const sourceFolder = folderFrom(source?.[2]);
  // an explicit path the grammar could not place (e.g. "sort /x/Inbox by …"): let the router read it
  if (!sourceFolder && /(?:^|\s)(~\/|\/)[^\s,]+/.test(text)) return null;

  const destIn = /\b(?:folder|directory)\b[^.]*?\b(?:on|in|under)\s+((?:my|the)\s+)?(desktop|downloads|documents|pictures|~\/[^\s,]+)/i.exec(text);
  const destParent = folderFrom(destIn?.[2]);

  let withinDays: number | null = null;
  if (/\btoday\b/.test(t)) withinDays = 1;
  else if (/\bthis week\b/.test(t)) withinDays = 7;
  const days = /\b(?:last|past)\s+(\d+)\s+days?\b/.exec(t);
  if (days) withinDays = Number(days[1]);

  const renameByContent =
    /\brename\b/.test(t) && (/\b(content|contents|what'?s in|based on|describ)/.test(t) || !/\bdon'?t rename\b/.test(t));
  const groupByCategory = /\b(categor|classif|group|by type|by topic|sort them into)/.test(t);
  const report = /\b(report|summary|summari[sz]e|write ?up)\b/.test(t);

  return {
    count,
    sourceFolder,
    destinationFolder: destParent && destinationName ? `${destParent}/${destinationName}` : null,
    destinationName,
    renameByContent,
    groupByCategory,
    withinDays,
    report,
    reportTitle: null,
  };
}

/**
 * The controlled web-form workflow ("fill a draft purchase request on the partner portal for
 * <company>, <email>, <n> units of …") with its slots read deterministically. Returns null when
 * a required detail is missing or the wording asks for anything the draft-only template does not
 * do (submitting, other sites, notes, natural-language dates), so the router model handles it.
 */
export function matchWebForm(text: string): WebFormRouteSlots | null {
  if (!/\b(partner portal|purchase request)\b/i.test(text)) return null;
  const affirmative = text.replace(/\b(?:do not|don'?t|never|without)\s+(?:submit|send)(?:ting|ing)?\b/gi, '');
  if (/\b(submit|send|pay|checkout|buy|place the order|order it)\b/i.test(affirmative)) return null;
  if (/https?:\/\/|\bwww\./i.test(text)) return null;
  if (/\b(notes?|comments?)\b\s*[:"“]/i.test(text)) return null;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? null;
  if (!iso && /\b(needed by|due|deliver(?:ed|y)? by|by (?:mon|tue|wed|thu|fri|sat|sun|next|tomorrow|end of|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d))/i.test(text)) return null;
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0]?.replace(/[.]+$/, '') ?? null;
  const quantity = Number(/\b(\d{1,6})\s*(?:units?|pcs|pieces|items|boxes|cases)\b/i.exec(text)?.[1] ?? Number.NaN);
  const company = email ? new RegExp(`\\bfor\\s+([A-Za-z][\\w&.' -]{0,79}?)\\s*,\\s*${email.replace(/[.+]/g, '\\$&')}`).exec(text)?.[1]?.trim() : undefined;
  if (!email || !company || !Number.isInteger(quantity) || quantity <= 0) return null;
  const criteria = /\b(cheapest|least expensive|lowest[- ]priced?|most expensive|premium|fastest|quickest|shortest lead time)\b[^.,;]*/i.exec(text)?.[0]?.trim() ?? null;
  return {
    company,
    email,
    quantity,
    neededBy: iso,
    notes: null,
    sku: /\b([A-Z]{2,4}-\d{3,5})\b/.exec(text)?.[1] ?? null,
    criteria,
    url: null,
    variant: /\b(?:layout|variant)\s+([a-z])\b/i.exec(text)?.[1]?.toLowerCase() ?? null,
  };
}

/**
 * Words that keep a command on the router model: deletion and other irreversible effects,
 * anything leaving the Mac, the web, code repair, UI control, and vague clean-ups. False alarms
 * only cost the router's latency; everything else may skip it (see matchDirectStandard).
 */
const NEEDS_ROUTER =
  /\b(delet\w*|remov\w*|trash\w*|eras\w*|wip\w*|destroy\w*|purg\w*|shred\w*|empty\w*|overwrit\w*|uninstall\w*|install\w*|kill\w*|quit\w*|forc\w*|shut ?down|restart\w*|reboot\w*|log ?out|sign ?out|sudo|password\w*|passcode|credential\w*|secret\w*|api keys?|keychain|send\w*|e-?mail\w*|mail|tweet\w*|publish\w*|shar\w*|upload\w*|submit\w*|pay\w*|purchas\w*|buy\w*|checkout|transfer\w*|wire|deploy\w*|push\w*|merg\w*|releas\w*|website|web ?site|webpage|web ?page|browser|portal|online|internet|url|google|search the web|download(?:ed|ing)?|fix\w*|repair\w*|debug\w*|refactor\w*|patch\w*|repo|repository|git|compil\w*|click\w*|press\w*|tap|(?<!\b(?:by|file|files|same|content|mime)\s)type(?=\s+(?:in|into|out|the|a|an|this|that|my|some|["'“]))|typing|clean ?up|cleanup|declutter|get rid|free up|archiv\w*|replac\w*)\b|https?:\/\/|www\.|^\s*(?:text|message|call|reply|invite|schedule|book|order|post)\b/i;

/**
 * Commands with no risky, external, web, code or vague wording go straight to the STANDARD
 * planner without a router call, so the first task can start as soon as the planner streams it.
 * Safety does not depend on this: every task still passes the policy engine and approvals.
 */
export function matchDirectStandard(text: string): RouteResult | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4 || NEEDS_ROUTER.test(text)) return null;
  const files = /\b(files?|folders?|director(?:y|ies)|documents?|docs?|pdfs?|screenshots?|images?|photos?|reports?|notes?|\.\w{2,4}\b|~\/)/i.test(text);
  return {
    decision: {
      mode: 'standard',
      intent: files ? 'file_operations' : 'general',
      confidence: 0.7,
      via: 'grammar',
      reason: 'no risky, external, web or code wording: planned directly without a router call',
      slots: {},
      needsFullPreview: false,
    },
  };
}

const RouterOutputSchema = z.object({
  mode: z.enum(['fast', 'standard', 'deep']),
  intent: IntentSchema,
  confidence: z.number(),
  reason: z.string(),
  needsFullPreview: z.boolean(),
  slots: z.object({
    count: z.number().int().nullable(),
    sourceFolder: z.string().nullable(),
    destinationFolder: z.string().nullable(),
    destinationName: z.string().nullable(),
    renameByContent: z.boolean().nullable(),
    groupByCategory: z.boolean().nullable(),
    withinDays: z.number().nullable(),
    report: z.boolean().nullable(),
    reportTitle: z.string().nullable(),
    target: z.string().nullable(),
    company: z.string().nullable(),
    email: z.string().nullable(),
    quantity: z.number().int().nullable(),
    neededBy: z.string().nullable().describe('YYYY-MM-DD'),
    notes: z.string().nullable(),
    sku: z.string().nullable(),
    criteria: z.string().nullable().describe('how to choose a product, e.g. "cheapest in stock"'),
    url: z.string().nullable(),
    variant: z.string().nullable().describe('site layout variant if the user names one, e.g. "b"'),
    to: z.string().nullable().describe('email recipient address, or "me" when the user emails themself'),
    subject: z.string().nullable().describe('email subject'),
    body: z.string().nullable().describe('email body text'),
  }),
});

const ROUTER_INSTRUCTIONS = `You are the intent router of CommandOS, a macOS computer agent. Classify the user's spoken or typed command.

Modes:
- fast: the command matches a known workflow whose steps are fixed (organize_screenshots) and all needed details are present or have safe defaults.
- standard: anything else that needs a plan of several tool steps (files, apps, documents, terminal, browser, sandboxes), including clear commands with risky steps such as deleting or sending: CommandOS asks the user to approve every risky step anyway, so risk alone never needs deep.
- deep: only when the goal is genuinely ambiguous or needs careful multi-step reasoning before acting (many interdependent steps, code repair).

Intents: organize_screenshots (find/rename/move/classify screenshots, optional report), repo_test_fix (inspect a code repo, run tests, propose a fix), web_research_form (visit a website, collect info, fill a form; extract company, email, quantity, neededBy, notes, sku, product criteria, url and layout variant when given), send_email (write or send one email, e.g. with Gmail; extract to — an address, or "me" when the user emails themself — subject and body; for a short message like "hi" use it as both subject and body; ignore filler words from speech), replay_procedure ("do the same as before" on new inputs), app_control (operate a Mac app), file_operations (other file work), control (stop/cancel/undo/approve), general.

Set needsFullPreview=true when any step would send data outside the Mac, submit a form, pay, or delete. Extract slots when present, else null. Paths: use ~/ for the home folder (e.g. ~/Desktop). Never invent folder names the user did not say.`;

export interface WebFormRouteSlots {
  company: string;
  email: string;
  quantity: number;
  neededBy: string | null;
  notes: string | null;
  sku: string | null;
  criteria: string | null;
  url: string | null;
  variant: string | null;
}

export interface EmailRouteSlots {
  /** an address, or "me" */
  to: string;
  subject: string;
  body: string;
}

export interface RouteResult {
  decision: RouteDecision;
  control?: ControlAction;
  organize?: OrganizeSlots;
  repo?: { repoPath: string };
  web?: WebFormRouteSlots;
  email?: EmailRouteSlots;
  /** everyday commands run as fixed steps with no model call (see quick.ts) */
  quick?: QuickStep[];
  pageQuestion?: PageQuestion;
  photoAttachment?: true;
  existingAttachment?: { path: string };
  /** A named checkout whose GitHub owner must be resolved before planning. */
  githubRepositoryName?: string;
}

/** Local grammars only (zero model calls): control, replay, repo test-and-fix, screenshot organizing, the web form, and plainly safe commands that go straight to the STANDARD planner. */
export function routeLocally(text: string): RouteResult | null {
  const control = matchControl(text);
  if (control) {
    return {
      control,
      decision: { mode: 'fast', intent: 'control', confidence: 1, via: 'grammar', reason: `control command: ${control}`, slots: { action: control }, needsFullPreview: false },
    };
  }
  // Spoken and copied bounded website audits can stream their first tools
  // immediately, without a slow router/deep-plan turn.
  const auditLead = /^\s*[“”"']*\s*(?:(?:hello|hi|um|uh)[\s,.]*)*(?:(?:can|could) you\s+)?audit\b/i.test(text);
  const auditTarget = /https?:\/\/\S+|\b(?:www\.)?daytona\.io\b/i.test(text);
  const auditScope = /\b(?:three|3|four|4) pages\b|\bhomepage\b.*\binternal pages\b|\b(?:node\.?js|package\.json)\b/i.test(text);
  const auditProviders = /\banchor(?: browser)?\b/i.test(text) && /\b(?:daytona|sandbox)\b/i.test(text);
  if (auditLead && auditTarget && auditScope && auditProviders) {
    return { decision: { mode: 'standard', intent: 'general', confidence: 0.95, via: 'grammar', reason: 'explicit website audit: stream tools and plan from observed page data', slots: {}, needsFullPreview: true } };
  }
  // Reading one GitHub issue and testing a patch is a bounded tool workflow. Start
  // streaming useful steps instead of generating a complete DEEP plan up front.
  // Keep it ahead of the local repo template: that template would omit Anchor,
  // issue requirements, and sandbox-only/review constraints from the command.
  if (/\bgithub\b|github\.com\//i.test(text) && /\bissue(?:s)?\b/i.test(text) &&
      /\banchor(?: browser)?\b/i.test(text) && /\bdaytona\b/i.test(text) &&
      /\b(?:fix|repair|patch)\b/i.test(text)) {
    const named = /\b(?:my|the)\s+([\w.-]+)\s+(?:github\s+)?repo(?:sitory)?\b/i.exec(text)?.[1];
    return { ...(!/github\.com\/[\w.-]+\/[\w.-]+/i.test(text) && named ? { githubRepositoryName: named } : {}), decision: { mode: 'standard', intent: 'repo_test_fix', confidence: 0.95, via: 'grammar', reason: 'GitHub issue repair: read directly with Anchor and stream sandbox steps', slots: {}, needsFullPreview: true } };
  }
  if (matchReplay(text)) {
    return { decision: { mode: 'fast', intent: 'replay_procedure', confidence: 0.85, via: 'grammar', reason: 'asked to repeat an earlier procedure', slots: {}, needsFullPreview: false } };
  }
  const repo = matchRepoFix(text);
  if (repo) {
    return {
      repo,
      decision: { mode: 'fast', intent: 'repo_test_fix', confidence: 0.85, via: 'grammar', reason: 'matched the test-and-fix workflow grammar', slots: { ...repo }, needsFullPreview: true },
    };
  }
  const organize = matchOrganizeScreenshots(text);
  if (organize) {
    return {
      organize,
      decision: { mode: 'fast', intent: 'organize_screenshots', confidence: 0.9, via: 'grammar', reason: 'matched the screenshot-organizing workflow grammar', slots: { ...organize }, needsFullPreview: false },
    };
  }
  const existingAttachment = matchExistingAttachment(text);
  if (existingAttachment) {
    return {
      existingAttachment,
      decision: { mode: 'fast', intent: 'app_control', confidence: 1, via: 'grammar', reason: 'attach the specified image to the existing Qwen chat without taking a photo or submitting', slots: { ...existingAttachment }, needsFullPreview: false },
    };
  }
  if (matchPhotoAttachment(text)) {
    return {
      photoAttachment: true,
      decision: { mode: 'fast', intent: 'app_control', confidence: 0.95, via: 'grammar', reason: 'take a photo and attach it to the existing Qwen chat without submitting', slots: {}, needsFullPreview: false },
    };
  }
  const quick = matchQuickCommand(text);
  if (quick) {
    const describe = (q: QuickStep) =>
      q.kind === 'open_app'
        ? `open ${q.name}`
        : q.kind === 'open_url' || q.kind === 'open_folder'
          ? `open ${q.label}`
          : q.kind === 'take_photo'
            ? 'take a photo'
            : q.kind === 'open_photo'
              ? 'open the photo'
              : `email ${q.to}${q.attachPhoto ? ' with the photo' : ''}`;
    return {
      quick,
      decision: {
        mode: 'fast',
        intent: quick.some((q) => q.kind === 'email') ? 'send_email' : 'app_control',
        confidence: 0.9,
        via: 'grammar',
        reason: `everyday command, no model needed: ${quick.map(describe).join(' → ')}`,
        slots: { steps: quick },
        needsFullPreview: false,
      },
    };
  }
  const pageQuestion = matchPageQuestion(text);
  if (pageQuestion) {
    return {
      pageQuestion,
      decision: { mode: 'fast', intent: 'general', confidence: 0.9, via: 'grammar', reason: 'read the signed-in browser directly; one model call for the answer', slots: { ...pageQuestion }, needsFullPreview: false },
    };
  }
  const web = matchWebForm(text);
  if (web) {
    return {
      web,
      decision: { mode: 'fast', intent: 'web_research_form', confidence: 0.85, via: 'grammar', reason: 'matched the draft purchase request workflow grammar', slots: { ...web }, needsFullPreview: false },
    };
  }
  return matchDirectStandard(text);
}

/** True when a route should be planned by the incremental STANDARD planner (no template, not deep). */
export function isStandardRoute(r: RouteResult): boolean {
  return r.decision.mode === 'standard' && !r.control && !r.organize && !r.repo && !r.web && !r.email && !r.quick && !r.pageQuestion && !r.photoAttachment && !r.existingAttachment && r.decision.intent !== 'replay_procedure';
}

/** The fast router model (gpt-6-luna): intent, mode and slots for commands no grammar handles. */
export type RouterOutput = z.infer<typeof RouterOutputSchema>;

export async function routeWithModel(text: string, models: ModelGateway, ctx: { runId: string; signal?: AbortSignal }): Promise<RouteResult> {
  const { data } = await models.parse({
    tier: 'fast',
    purpose: 'route',
    runId: ctx.runId,
    signal: ctx.signal,
    schema: RouterOutputSchema,
    schemaName: 'route_decision',
    instructions: ROUTER_INSTRUCTIONS,
    input: text,
    cacheKey: 'commandos.router.v1',
    maxOutputTokens: 800,
    // routing gates every model-planned run; two requests cut its latency tail (see hedged())
    hedgeAfterMs: 0,
  });
  return routeFromModelOutput(data);
}

/** Maps the router model's output to a route, binding workflow templates when their slots are complete. */
export function routeFromModelOutput(data: RouterOutput): RouteResult {
  const decision: RouteDecision = {
    mode: data.mode,
    intent: data.intent,
    confidence: Math.max(0, Math.min(1, data.confidence)),
    via: 'router',
    reason: data.reason,
    slots: Object.fromEntries(Object.entries(data.slots).filter(([, v]) => v !== null)),
    needsFullPreview: data.needsFullPreview,
  };
  const result: RouteResult = { decision };
  if (data.intent === 'web_research_form' && data.slots.company && data.slots.email && data.slots.quantity) {
    result.web = {
      company: data.slots.company,
      email: data.slots.email,
      quantity: data.slots.quantity,
      neededBy: data.slots.neededBy,
      notes: data.slots.notes,
      sku: data.slots.sku,
      criteria: data.slots.criteria,
      url: data.slots.url,
      variant: data.slots.variant,
    };
    result.decision = { ...decision, mode: 'fast', reason: `${decision.reason} (template: draft purchase request)` };
  }
  const to = data.slots.to?.trim();
  if (data.intent === 'send_email' && to && (data.slots.body || data.slots.subject)) {
    result.email = {
      to: /^(me|myself|self|my ?self)$/i.test(to) ? 'me' : to,
      subject: (data.slots.subject ?? data.slots.body ?? '').trim(),
      body: (data.slots.body ?? data.slots.subject ?? '').trim(),
    };
    // a fixed two-step workflow: open the draft, then send only after the user approves it
    result.decision = { ...decision, mode: 'fast', reason: `${decision.reason} (template: Gmail draft in Chrome, sent only after approval)` };
  }
  if (data.intent === 'repo_test_fix' && data.slots.target && /^(~\/|\/)/.test(data.slots.target)) {
    result.repo = { repoPath: data.slots.target };
  }
  if (data.intent === 'organize_screenshots') {
    result.organize = {
      count: data.slots.count,
      sourceFolder: data.slots.sourceFolder,
      destinationFolder: data.slots.destinationFolder,
      destinationName: data.slots.destinationName,
      // rename only when asked: renaming files nobody asked about is not a safe default
      renameByContent: data.slots.renameByContent ?? false,
      groupByCategory: data.slots.groupByCategory ?? false,
      withinDays: data.slots.withinDays,
      report: data.slots.report ?? false,
      reportTitle: data.slots.reportTitle,
    };
  }
  return result;
}

const NO_MODEL: RouteResult = {
  decision: {
    mode: 'standard',
    intent: 'general',
    confidence: 0,
    via: 'grammar',
    reason: 'no router model available (OPENAI_API_KEY missing) and no local grammar matched',
    slots: {},
    needsFullPreview: true,
  },
};

/**
 * Cheapest reliable path first: local grammars → fast router model (gpt-6-luna). The router
 * never grants permissions; it only picks a mode.
 */
export async function routeCommand(text: string, models: ModelGateway | null, ctx: { runId: string; signal?: AbortSignal }): Promise<RouteResult> {
  return withSpan('route', OpenInferenceSpanKind.CHAIN, { [SemanticConventions.INPUT_VALUE]: text }, async (span) => {
    const local = routeLocally(text);
    const result = local ?? (models ? await routeWithModel(text, models, ctx) : NO_MODEL);
    span.setAttributes({
      'commandos.route.via': result.decision.via,
      'commandos.route.intent': result.decision.intent,
      'commandos.route.mode': result.decision.mode,
      [SemanticConventions.OUTPUT_VALUE]: spanJson(result.decision),
    });
    return result;
  });
}
