import { join } from 'node:path';
import type { PlanInput, Settings, TaskSpecInput } from '@commandos/contracts';
import { resolveUserPath } from '@commandos/tools';
import type { QuickStep } from './quick';
import type { PageQuestion } from './page-question';
import type { OrganizeSlots } from './router';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Take and attach a photo with no planning turns. Upload approval is still enforced. */
export function photoAttachmentPlan(path?: string): PlanInput {
  if (path) return {
    goal: 'Attach the specified image to the existing Qwen chat, leaving the message unsent',
    tasks: [{ id: 'attach', tool: 'browser.attachFile', title: 'Attach the existing photo to Qwen without submitting', args: { path, site: 'Qwen', browser: 'Google Chrome' } }],
  };
  return {
    goal: 'Take a Photo Booth photo and attach it to the existing Qwen chat, leaving the message unsent',
    tasks: [
      { id: 'photo', tool: 'photobooth.takePhoto', title: 'Take your photo', args: {} },
      { id: 'attach', tool: 'browser.attachFile', title: 'Attach the photo to Qwen without submitting', args: { path: '', site: 'Qwen', browser: 'Google Chrome' }, dependsOn: ['photo'], bind: [{ arg: 'path', from: 'photo.output.path' }] },
    ],
  };
}

/** Inspect the user's signed-in page, then answer once; no router or planning round trips. */
export function pageQuestionPlan(s: PageQuestion): PlanInput {
  const bundleIds = { 'Google Chrome': 'com.google.Chrome', 'Microsoft Edge': 'com.microsoft.edgemac', Brave: 'com.brave.Browser', Arc: 'company.thebrowser.Browser' };
  const tasks: TaskSpecInput[] = [];
  if (s.url) tasks.push({ id: 'open', tool: 'workspace.open', title: 'Open the page in your browser', args: { url: s.url, bundleId: bundleIds[s.browser] } });
  tasks.push(
    { id: 'page', tool: 'browser.readPage', title: 'Read the signed-in page', args: { browser: s.browser, scrollPages: s.scrollPages, ...(s.url ? { expectedUrl: s.url } : {}) }, dependsOn: s.url ? ['open'] : [] },
    {
      id: 'answer', tool: 'ai.write', title: 'Answer from the page',
      args: {
        instruction: `${s.question}\nToday is ${new Date().toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Answer from the page, not from general knowledge. Count distinct matching entries, not navigation labels. If the page does not establish a complete list, say the count is only for the visible entries.`,
        sources: [{ name: s.url ?? 'Current browser page', text: '' }], format: 'plain', maxWords: 350,
      },
      dependsOn: ['page'], bind: [{ arg: 'sources.0.text', from: 'page.output.text' }, { arg: 'sources.0.truncated', from: 'page.output.truncated' }],
    },
  );
  return { goal: s.question, tasks, assumptions: ['reads the page in the user’s signed-in browser; does not change the site'] };
}

/**
 * FAST template for "find my N latest screenshots, rename them by content, put them in a folder
 * (grouped by category), and write a report". Deterministic tool calls; the only model call is
 * the content-naming step, and only when renaming by content was requested.
 */
export function organizeScreenshotsPlan(slots: OrganizeSlots, settings: Settings, opts: { reveal?: boolean } = {}): PlanInput {
  // no number given ("organize my screenshots") means all of them, capped; the policy asks for
  // approval above the auto-approve limit
  const count = Math.max(1, Math.min(200, slots.count ?? 200));
  const which = slots.count === null ? 'screenshots' : count === 1 ? 'latest screenshot' : `${count} latest screenshots`;
  const roots = slots.sourceFolder ? [slots.sourceFolder] : settings.screenshotRoots;
  const firstRoot = resolveUserPath(roots[0] ?? '~/Desktop');
  const destName = slots.destinationName?.trim() || `Organized Screenshots ${today()}`;
  const destinationDir = slots.destinationFolder ? resolveUserPath(slots.destinationFolder) : join(firstRoot, destName);

  const tasks: TaskSpecInput[] = [
    {
      id: 'find',
      tool: 'screenshots.find',
      title: `Find the ${which}`,
      args: {
        limit: count,
        ...(slots.sourceFolder ? { roots: [slots.sourceFolder] } : {}),
        ...(slots.withinDays ? { withinDays: slots.withinDays } : {}),
      },
      postconditions: [{ kind: 'output_count', path: 'files', op: 'gte', value: 1 }],
    },
    {
      id: 'mkdir',
      tool: 'fs.mkdir',
      title: 'Create the destination folder',
      args: { path: destinationDir },
    },
  ];

  if (slots.renameByContent || slots.groupByCategory) {
    tasks.push(
      {
        id: 'ocr',
        tool: 'image.ocr',
        title: 'Read each screenshot on-device',
        args: { images: [], level: 'accurate' },
        dependsOn: ['find'],
        bind: [{ arg: 'images', from: 'find.output.files' }],
      },
      {
        id: 'name',
        tool: 'ai.nameFiles',
        title: 'Name and classify by content',
        args: { items: [] },
        dependsOn: ['ocr'],
        bind: [{ arg: 'items', from: 'ocr.output.results' }],
        postconditions: [{ kind: 'output_count', path: 'items', op: 'gte', value: 1 }],
      },
      {
        id: 'organize',
        tool: 'fs.organize',
        title: slots.groupByCategory ? 'Rename and file into category folders' : 'Rename and move into the folder',
        args: { items: [], destinationDir, groupByCategory: slots.groupByCategory },
        dependsOn: ['name', 'mkdir'],
        bind: [{ arg: 'items', from: 'name.output.items' }],
        postconditions: [{ kind: 'output_equals', path: 'complete', value: true }],
      },
    );
  } else {
    tasks.push({
      id: 'organize',
      tool: 'fs.organize',
      title: 'Move into the folder',
      args: { items: [], destinationDir, groupByCategory: false },
      dependsOn: ['find', 'mkdir'],
      bind: [{ arg: 'items', from: 'find.output.files' }],
      postconditions: [{ kind: 'output_equals', path: 'complete', value: true }],
    });
  }

  if (slots.report) {
    tasks.push({
      id: 'report',
      tool: 'report.write',
      title: 'Write the report',
      args: {
        title: slots.reportTitle ?? 'Screenshot report',
        outputPath: join(destinationDir, 'Screenshot report.md'),
        intro: `CommandOS organized the ${which} into ${destName}.`,
        columns: ['name', 'category', 'summary', 'from'],
        entries: [],
      },
      dependsOn: ['organize'],
      bind: [{ arg: 'entries', from: 'organize.output.moved' }],
    });
  }

  if (opts.reveal !== false) tasks.push({
    id: 'reveal',
    tool: 'workspace.reveal',
    title: 'Show the folder in Finder',
    args: { paths: [] },
    dependsOn: slots.report ? ['organize', 'report'] : ['organize'],
    bind: [{ arg: 'paths.0', from: 'organize.output.destinationDir' }],
  });

  return {
    goal: `Organize the ${which} into ${destinationDir}`,
    tasks,
    assumptions: [
      slots.sourceFolder ? `screenshots come from ${slots.sourceFolder}` : `screenshots come from ${settings.screenshotRoots.join(', ')}`,
      `destination: ${destinationDir}`,
    ],
  };
}

/**
 * FAST template for "run the tests in <repo>, find the failures and propose a fix": the repo is
 * staged in an isolated Daytona sandbox, failures are parsed, gpt-6-astra proposes a patch that is
 * validated by re-running the tests in the sandbox, and only then offered for local review.
 */
export function repoTestFixPlan(slots: { repoPath: string }): PlanInput {
  const repoPath = slots.repoPath;
  return {
    goal: `Run the tests in ${repoPath}, fix the failures, validate the fix in a sandbox and present it for review`,
    tasks: [
      { id: 'inspect', tool: 'repo.inspect', title: 'Inspect the repository', args: { repoPath } },
      { id: 'sandbox', tool: 'sandbox.create', title: 'Stage the repo in a Daytona sandbox', args: { repoPath, network: 'auto' } },
      {
        id: 'tests',
        tool: 'sandbox.exec',
        title: 'Run the test suite in the sandbox',
        args: { sandboxId: '', command: '', timeoutSec: 300, expectZeroExit: false },
        dependsOn: ['sandbox'],
        bind: [
          { arg: 'sandboxId', from: 'sandbox.output.sandboxId' },
          { arg: 'command', from: 'sandbox.output.testCommand' },
        ],
      },
      {
        id: 'propose',
        tool: 'code.proposePatch',
        title: 'Propose a fix for the failing tests',
        args: { repoPath, testOutput: '', failures: [] },
        dependsOn: ['tests'],
        bind: [
          { arg: 'testOutput', from: 'tests.output.stdout' },
          { arg: 'failures', from: 'tests.output.failures' },
        ],
      },
      {
        id: 'apply_sandbox',
        tool: 'sandbox.applyChanges',
        title: 'Apply the patch inside the sandbox',
        args: { sandboxId: '', changes: [] },
        dependsOn: ['sandbox', 'propose'],
        bind: [
          { arg: 'sandboxId', from: 'sandbox.output.sandboxId' },
          { arg: 'changes', from: 'propose.output.changes' },
        ],
      },
      {
        id: 'retest',
        tool: 'sandbox.exec',
        title: 'Re-run the tests with the patch',
        args: { sandboxId: '', command: '', timeoutSec: 300, expectZeroExit: true },
        dependsOn: ['sandbox', 'apply_sandbox'],
        bind: [
          { arg: 'sandboxId', from: 'sandbox.output.sandboxId' },
          { arg: 'command', from: 'sandbox.output.testCommand' },
        ],
      },
      {
        id: 'apply_local',
        tool: 'patch.apply',
        title: 'Apply the validated patch locally (review)',
        args: { repoPath, changes: [] },
        dependsOn: ['propose', 'retest', 'inspect'],
        bind: [{ arg: 'changes', from: 'propose.output.changes' }],
      },
    ],
    assumptions: ['tests run only inside the sandbox; nothing from the repository executes on this Mac'],
  };
}

export interface WebFormSlots {
  baseUrl: string;
  provider: 'anchor' | 'local';
  headless: boolean;
  company: string;
  email: string;
  quantity: number;
  neededBy: string | null;
  notes: string | null;
  sku: string | null;
  criteria: string | null;
  variant: string | null;
}

/** Maps a natural-language product preference to a deterministic row selection. */
export function productSelection(criteria: string | null): { where: Array<{ field: string; op: 'eq'; value: string }>; orderBy: { field: string; direction: 'asc' | 'desc'; numeric: boolean } } {
  const c = (criteria ?? 'cheapest in stock').toLowerCase();
  const where = /in.?stock|available|ships now/.test(c) || !/out of stock/.test(c) ? [{ field: 'In stock', op: 'eq' as const, value: 'Yes' }] : [];
  if (/fast|soon|quick|shortest lead|lead time/.test(c)) return { where, orderBy: { field: 'Lead time (days)', direction: 'asc', numeric: true } };
  if (/expensive|premium|highest/.test(c)) return { where, orderBy: { field: 'Unit price', direction: 'desc', numeric: true } };
  return { where, orderBy: { field: 'Unit price', direction: 'asc', numeric: true } };
}

/**
 * FAST template for the controlled web workflow: read the catalog in a browser session (Anchor
 * cloud or local Chromium), pick the product deterministically, fill the draft purchase request
 * by CSS selector, read every field back, keep screenshot evidence, never submit.
 */
export function webFormPlan(s: WebFormSlots): PlanInput {
  const base = s.baseUrl.replace(/\/+$/, '');
  const orderUrl = `${base}/order.html${s.variant ? `?variant=${encodeURIComponent(s.variant)}` : ''}`;
  const fields: Array<{ selector: string; label: string; value: string }> = [
    { selector: '#company', label: 'Company name', value: s.company },
    { selector: '#email', label: 'Contact email', value: s.email },
    { selector: '#sku', label: 'Product', value: s.sku ?? '' },
    { selector: '#quantity', label: 'Quantity', value: String(s.quantity) },
  ];
  if (s.neededBy) fields.push({ selector: '#needed-by', label: 'Needed by', value: s.neededBy });
  if (s.notes) fields.push({ selector: '#notes', label: 'Notes', value: s.notes });
  const tasks: TaskSpecInput[] = [
    { id: 'open', tool: 'web.open', title: `Open the catalog (${s.provider === 'anchor' ? 'Anchor cloud browser' : 'local Chromium'})`, args: { provider: s.provider, url: `${base}/catalog.html`, headless: s.headless } },
    {
      id: 'catalog',
      tool: 'web.extract',
      title: 'Read the product catalog',
      args: { sessionId: '' },
      dependsOn: ['open'],
      bind: [{ arg: 'sessionId', from: 'open.output.sessionId' }],
      postconditions: [{ kind: 'output_count', path: 'tables', op: 'gte', value: 1 }],
    },
  ];
  if (!s.sku) {
    const sel = productSelection(s.criteria);
    tasks.push({
      id: 'pick',
      tool: 'data.select',
      title: `Pick the product (${s.criteria ?? 'cheapest in stock'})`,
      args: { rows: [], where: sel.where, orderBy: sel.orderBy, limit: 1 },
      dependsOn: ['catalog'],
      bind: [{ arg: 'rows', from: 'catalog.output.tables[0].rows' }],
      postconditions: [{ kind: 'output_count', path: 'rows', op: 'gte', value: 1 }],
    });
  }
  tasks.push(
    {
      id: 'goto',
      tool: 'web.goto',
      title: 'Open the draft purchase request',
      args: { sessionId: '', url: orderUrl },
      dependsOn: ['open', 'catalog'],
      bind: [{ arg: 'sessionId', from: 'open.output.sessionId' }],
    },
    {
      id: 'fill',
      tool: 'web.fillForm',
      title: 'Fill the draft request (no submission)',
      args: { sessionId: '', strategy: 'selector', fields },
      dependsOn: ['open', 'goto', ...(s.sku ? [] : ['pick'])],
      bind: [{ arg: 'sessionId', from: 'open.output.sessionId' }, ...(s.sku ? [] : [{ arg: 'fields.2.value', from: 'pick.output.rows[0].SKU' }])],
      postconditions: [{ kind: 'output_equals', path: 'submissionsBlocked', value: 0 }],
    },
    { id: 'evidence', tool: 'web.screenshot', title: 'Save a screenshot of the filled form', args: { sessionId: '', fullPage: true }, dependsOn: ['open', 'fill'], bind: [{ arg: 'sessionId', from: 'open.output.sessionId' }] },
    { id: 'close', tool: 'web.close', title: 'End the browser session', args: { sessionId: '' }, dependsOn: ['open', 'evidence'], bind: [{ arg: 'sessionId', from: 'open.output.sessionId' }] },
  );
  return { goal: `Fill a draft purchase request on ${base} without submitting`, tasks, assumptions: ['the form is filled but never submitted'] };
}

export interface EmailSlots {
  /** an address, or "me" (resolved by gmail.compose) */
  to: string;
  subject: string;
  body: string;
}

/**
 * FAST template for one email through Gmail in Chrome: open the filled-in draft, then send it.
 * The send step is external, so the policy engine asks for approval with the exact email (bound
 * from the draft) every time; nothing is sent without it.
 */
export function emailPlan(s: EmailSlots): PlanInput {
  return {
    goal: `Email ${s.to === 'me' ? 'yourself' : s.to}: ${s.subject || s.body}`.slice(0, 200),
    tasks: [
      { id: 'compose', tool: 'gmail.compose', title: `Open a Gmail draft to ${s.to === 'me' ? 'you' : s.to}`, args: { to: s.to, subject: s.subject, body: s.body } },
      {
        id: 'send',
        tool: 'gmail.send',
        title: 'Send it (after your approval)',
        args: { to: '', subject: '', body: '' },
        dependsOn: ['compose'],
        bind: [
          { arg: 'to', from: 'compose.output.to' },
          { arg: 'subject', from: 'compose.output.subject' },
          { arg: 'body', from: 'compose.output.body' },
        ],
      },
    ],
    assumptions: ['uses the Gmail account signed in to Google Chrome'],
  };
}

/** Fixed steps for everyday commands, run in the order spoken (each waits for the one before). */
export function quickPlan(steps: QuickStep[]): PlanInput {
  const tasks: TaskSpecInput[] = [];
  let previous: string | null = null;
  let photoTask: string | null = null;
  const after = () => (previous ? { dependsOn: [previous] } : {});
  steps.forEach((step, i) => {
    const id = `s${i + 1}`;
    if (step.kind === 'take_photo') {
      tasks.push({ id, tool: 'photobooth.takePhoto', title: 'Take your photo', args: {}, ...after() });
      previous = id;
      photoTask = id;
    } else if (step.kind === 'open_photo') {
      if (!photoTask) return;
      tasks.push({
        id,
        tool: 'workspace.open',
        title: 'Open the photo',
        args: { path: '', ...(step.bundleId ? { bundleId: step.bundleId } : {}) },
        ...after(),
        bind: [{ arg: 'path', from: `${photoTask}.output.path` }],
      });
      previous = id;
    } else if (step.kind === 'open_app') {
      tasks.push({ id, tool: 'apps.launch', title: `Open ${step.name}`, args: { bundleId: step.bundleId, activate: true }, ...after() });
      previous = id;
    } else if (step.kind === 'open_url') {
      tasks.push({ id, tool: 'workspace.open', title: `Open ${step.label}`, args: { url: step.url, ...(step.bundleId ? { bundleId: step.bundleId } : {}) }, ...after() });
      previous = id;
    } else if (step.kind === 'open_folder') {
      tasks.push({ id, tool: 'workspace.open', title: `Open ${step.label}`, args: { path: step.path }, ...after() });
      previous = id;
    } else {
      const email = emailPlan(step);
      for (const t of email.tasks) {
        const tid = `${id}_${t.id}`;
        const attach = t.id === 'compose' && step.attachPhoto && photoTask ? [{ arg: 'attachments.0', from: `${photoTask}.output.path` }] : [];
        const bind = [...(t.bind ?? []).map((b) => ({ ...b, from: b.from.replace(/^compose\./, `${id}_compose.`) })), ...attach];
        tasks.push({
          ...t,
          id: tid,
          ...(attach.length ? { args: { ...t.args, attachments: [] } } : {}),
          dependsOn: t.id === 'compose' ? (previous ? [previous] : []) : [`${id}_compose`],
          ...(bind.length ? { bind } : {}),
        });
        previous = tid;
      }
    }
  });
  return { goal: steps.map((s) => s.kind).join(' → '), tasks, assumptions: [] };
}
