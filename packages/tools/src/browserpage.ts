import { z } from 'zod';
import { delay, pollUntil } from './poll';
import { defineTool, ToolError } from './types';

const BROWSERS = {
  'Google Chrome': 'com.google.Chrome',
  'Microsoft Edge': 'com.microsoft.edgemac',
  Brave: 'com.brave.Browser',
  Arc: 'company.thebrowser.Browser',
} as const;

/** Match the requested page, including Luma's canonical-domain redirect. */
export function matchesPageUrl(actual: string | null, expected?: string): boolean {
  if (!expected) return true;
  if (!actual) return false;
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    const host = (h: string) => (['lu.ma', 'luma.com'].includes(h) ? 'luma.com' : h);
    return (
      a.protocol === e.protocol &&
      host(a.host) === host(e.host) &&
      a.pathname.replace(/\/+$/, '') === e.pathname.replace(/\/+$/, '') &&
      a.search === e.search &&
      (!e.hash || a.hash === e.hash)
    );
  } catch {
    return false;
  }
}

/**
 * Reads the page open in the user's own browser, where they are signed in (Luma, Gmail, calendars),
 * through Accessibility: Chromium browsers expose page contents once asked (the screen-reader
 * switch), so no screenshots or a separate signed-out browser are needed. Scrolls page by page to
 * let lazy lists load, and stops when scrolling adds nothing.
 */
export const browserReadPage = defineTool({
  id: 'browser.readPage',
  title: 'Read the page in your browser',
  description:
    "Read the text of the page open in the user's own browser (Google Chrome by default), where they are signed in, and scroll to load more. Use after workspace_open with the browser's bundleId. Read-only. Not for web_open sessions.",
  tier: 3,
  args: z.object({
    browser: z.enum(['Google Chrome', 'Microsoft Edge', 'Brave', 'Arc']).default('Google Chrome'),
    scrollPages: z.number().int().min(0).max(15).default(3),
    waitForText: z.string().max(200).optional(),
    expectedUrl: z
      .url({ protocol: /^https?$/ })
      .optional()
      .describe('The URL just opened: wait for it instead of reading the previous page.'),
    maxChars: z.number().int().min(500).max(100_000).default(30_000),
  }),
  output: z.object({ title: z.string(), url: z.string().nullable(), text: z.string(), truncated: z.boolean(), scrolled: z.number().int() }),
  effectClass: 'read',
  effects: ['ui_read', 'ui_input'],
  risk: 'low',
  idempotent: true,
  defaultTimeoutMs: 60_000,
  resources: (a) => [`app:${BROWSERS[a.browser]}`, 'ui:frontmost'],
  async run(a, ctx) {
    const bundleId = BROWSERS[a.browser];
    await ctx.helper.call('ax.enableWeb', { bundleId, on: true }, { signal: ctx.signal });
    const read = () => ctx.helper.call('ax.webText', { bundleId, maxChars: a.maxChars }, { signal: ctx.signal, timeoutMs: 20_000 });
    const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = a.waitForText ? normalizeText(a.waitForText) : undefined;
    let latest: Awaited<ReturnType<typeof read>> | null = null;
    // the page, and the browser's accessibility tree for it, may still be loading
    const loaded = await pollUntil(
      async () => {
        const p = await read();
        latest = p;
        const text = p.text.trim();
        return p.found &&
          text &&
          !p.busy &&
          !/^(loading[.…]*|please wait[.…]*)$/i.test(text) &&
          matchesPageUrl(p.url, a.expectedUrl) &&
          (!wanted || normalizeText(text).includes(wanted))
          ? p
          : null;
      },
      15_000,
      ctx.signal,
    );
    if (!loaded) {
      const observed = latest as Awaited<ReturnType<typeof read>> | null;
      throw new ToolError('page_not_ready', `${a.browser} did not reach the requested page state${a.waitForText ? ` containing “${a.waitForText}”` : ''}.${observed ? ` Last observed page: ${observed.url ?? observed.title}. ${observed.text.trim().slice(0, 600)}` : ''} The requested effect is not confirmed.`);
    }
    let page: NonNullable<typeof loaded> = loaded;
    ctx.progress(`Read “${page.title}” (${page.text.length} characters)`);
    let scrolled = 0;
    let reachedEnd = false;
    const texts = new Set(page.text.split('\n'));
    let collected = page.text;
    if (a.scrollPages && !page.truncated) await ctx.helper.call('apps.activate', { bundleId }, { signal: ctx.signal });
    for (let i = 0; i < a.scrollPages && !page.truncated; i++) {
      await ctx.helper.call('keyboard.press', { key: 'pagedown', modifiers: [] }, { signal: ctx.signal });
      // Check for changes after 100 ms, rather than sleeping 900 ms on every scroll. If nothing
      // changes, retain the full loading window; after a change, wait for 250 ms of quiet.
      const deadline = Date.now() + 1_200;
      let next: typeof page = page;
      let changedAt = 0;
      do {
        await delay(100, ctx.signal);
        const candidate = await read();
        if (!candidate.found || !matchesPageUrl(candidate.url, a.expectedUrl)) continue;
        if (candidate.text !== next.text) {
          next = candidate;
          changedAt = Date.now();
        }
        if (changedAt && Date.now() - changedAt >= 250) break;
      } while (Date.now() < deadline);
      scrolled++;
      if (next.text === page.text) {
        reachedEnd = true;
        break;
      }
      // Virtualized lists replace rows instead of growing the text. Keep earlier visible rows.
      if (next.text.startsWith(page.text)) collected += next.text.slice(page.text.length);
      else for (const line of next.text.split('\n')) if (!texts.has(line)) collected += `\n${line}`;
      page = next;
      for (const line of page.text.split('\n')) texts.add(line);
      if (collected.length >= a.maxChars) {
        page.truncated = true;
        break;
      }
      ctx.progress(`Scrolled ${scrolled} page(s): ${page.text.length} characters`);
    }
    const text = collected;
    return {
      title: page.title,
      url: page.url,
      text: text.slice(0, a.maxChars),
      truncated: page.truncated || text.length > a.maxChars || (a.scrollPages > 0 && scrolled === a.scrollPages && !reachedEnd),
      scrolled,
    };
  },
  summarize: (o) => ({ title: o.title, url: o.url, chars: o.text.length, scrolled: o.scrolled, text: o.text.length > 2500 ? `${o.text.slice(0, 2500)}…` : o.text }),
});

export const browserPageTools = [browserReadPage];
