import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSettings } from '@commandos/contracts';
import { fsList, fsMkdir, fsMove, fsOrganize, fsTrash, fsWriteText, gmailCompose, gmailSend, HelperClient, type ToolContext, visionAsk } from '@commandos/tools';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit';
import { evaluateCondition } from '../src/conditions';
import { checkBindingRefs, getPath, missingOutputPath, parsePath, resolveArgs, setPath } from '../src/bindings';
import { UndoJournal, undoEntries } from '../src/journal';
import { evaluatePolicy } from '../src/policy';
import { isStandardRoute, matchControl, matchDirectStandard, matchOrganizeScreenshots, matchWebForm, routeFromModelOutput, routeLocally } from '../src/router';
import { fixSwappedLetters, matchQuickCommand } from '../src/quick';
import { emailPlan, quickPlan } from '../src/templates';
import { tempDir } from './helpers';

describe('bindings', () => {
  const output = { files: [{ path: '/a.png', size: 1 }, { path: '/b.png', size: 2 }], dir: '/d' };

  it('reads nested paths, indexes and projections', () => {
    expect(getPath(output, 'files[1].path')).toBe('/b.png');
    expect(getPath(output, 'files[*].path')).toEqual(['/a.png', '/b.png']);
    expect(getPath(output, 'files.length')).toBe(2);
    expect(getPath(output, 'missing.x')).toBeUndefined();
    expect(() => parsePath('files[')).toThrow();
  });

  it('writes numeric segments as array slots', () => {
    const target: Record<string, unknown> = { paths: [] };
    setPath(target, 'paths.0', '/d');
    expect(target).toEqual({ paths: ['/d'] });
  });

  it('resolves bindings without mutating the spec', () => {
    const args = { items: [], destinationDir: '/x' };
    const resolved = resolveArgs(args, [{ arg: 'items', from: 'find.output.files' }], new Map([['find', output]]));
    expect(resolved.items).toHaveLength(2);
    expect(args.items).toHaveLength(0);
    expect(() => resolveArgs({}, [{ arg: 'x', from: 'find.output.nope' }], new Map([['find', output]]))).toThrow(/resolved to nothing/);
  });

  it('checks binding paths against the source tool output schema', () => {
    expect(missingOutputPath(fsList.output, 'entries[*].path')).toBeNull();
    expect(missingOutputPath(fsList.output, 'entries.length')).toBeNull();
    // the planner slip seen live: fs.find's field name on fs.list
    expect(missingOutputPath(fsList.output, 'files[*].path')).toEqual(['path', 'entries', 'truncated']);
    expect(missingOutputPath(fsList.output, 'entries[*].nope')).toContain('path');
  });

  it('requires binding sources to be declared dependencies', () => {
    expect(checkBindingRefs({ id: 'b', dependsOn: [], bind: [{ arg: 'x', from: 'a.output' }] })).toHaveLength(1);
    expect(checkBindingRefs({ id: 'b', dependsOn: ['a'], bind: [{ arg: 'x', from: 'a.output' }] })).toHaveLength(0);
  });
});

describe('output postconditions', () => {
  it('reads paths relative to the output, also when written as output.<path>', async () => {
    const output = { files: [{ path: '/a.png' }, { path: '/b.png' }] };
    for (const path of ['files', 'output.files']) {
      expect((await evaluateCondition({ kind: 'output_count', path, op: 'eq', value: 2 }, output, null)).ok).toBe(true);
    }
    expect((await evaluateCondition({ kind: 'output_truthy', path: 'output' }, output, null)).ok).toBe(true);
    // an output that really has an `output` key keeps the literal meaning
    expect((await evaluateCondition({ kind: 'output_equals', path: 'output.code', value: 0 }, { output: { code: 0 } }, null)).ok).toBe(true);
  });
});

describe('policy', () => {
  it('allows reversible changes inside allowed folders and denies outside', async () => {
    const dir = await tempDir();
    const settings = { ...defaultSettings(), allowedRoots: [dir] };
    expect(evaluatePolicy({ tool: fsMkdir, args: { path: join(dir, 'x') }, settings }).action).toBe('allow');
    const outside = evaluatePolicy({ tool: fsMkdir, args: { path: '/Library/x' }, settings });
    expect(outside.action).toBe('deny');
    expect(outside.reasons[0]).toMatch(/outside the folders/);
  });

  it('blocks protected locations even inside allowed roots', () => {
    const settings = { ...defaultSettings(), allowedRoots: ['~'] };
    const d = evaluatePolicy({ tool: fsMkdir, args: { path: '~/.ssh/new' }, settings });
    expect(d.action).toBe('deny');
    expect(d.risk).toBe('critical');
  });

  it('requires confirmation for deletions', async () => {
    const dir = await tempDir();
    const d = evaluatePolicy({ tool: fsTrash, args: { paths: [join(dir, 'a')] }, settings: { ...defaultSettings(), allowedRoots: [dir] } });
    expect(d.action).toBe('require_approval');
    expect(d.reasons.join()).toMatch(/deletes files/);
  });

  it('requires approval above the reversible auto-approve limit', async () => {
    const dir = await tempDir();
    const items = Array.from({ length: 30 }, (_, i) => ({ path: join(dir, `f${i}`) }));
    const d = evaluatePolicy({
      tool: fsOrganize,
      args: { items, destinationDir: join(dir, 'out'), groupByCategory: false, onConflict: 'suffix' },
      settings: { ...defaultSettings(), allowedRoots: [dir], autoApproveReversibleMax: 25 },
    });
    expect(d.action).toBe('require_approval');
  });

  it('treats the planner risk claim as advisory (can only raise risk)', async () => {
    const dir = await tempDir();
    const d = evaluatePolicy({ tool: fsMkdir, args: { path: join(dir, 'x') }, settings: { ...defaultSettings(), allowedRoots: [dir] }, claimedRisk: 'high' });
    expect(d.action).toBe('require_approval');
    const low = evaluatePolicy({ tool: fsTrash, args: { paths: [join(dir, 'x')] }, settings: { ...defaultSettings(), allowedRoots: [dir] }, claimedRisk: 'none' });
    expect(low.action).toBe('require_approval');
  });
});

describe('undo journal with real files', () => {
  function ctxFor(dir: string, journal: UndoJournal, taskId: string): ToolContext {
    return {
      runId: 'run_t',
      taskId,
      signal: new AbortController().signal,
      dryRun: false,
      settings: { ...defaultSettings(), allowedRoots: [dir] },
      helper: new HelperClient('/nonexistent'),
      models: null,
      providers: { get: () => Promise.reject(new Error('none')) },
      journal: { record: (op) => journal.record(taskId, op) },
      artifactsDir: join(dir, '.artifacts'),
      log: () => {},
      progress: () => {},
    };
  }

  it('organize → undo restores every file and removes created folders', async () => {
    const dir = await tempDir();
    const src = join(dir, 'inbox');
    await mkdir(src);
    for (const n of ['a.png', 'b.png', 'c.png']) await writeFile(join(src, n), n);
    const journal = new UndoJournal(join(dir, 'journal.jsonl'), 'run_t');
    const out = await fsOrganize.run(
      {
        items: [
          { path: join(src, 'a.png'), newName: 'Coffee Receipt', category: 'Receipts' },
          { path: join(src, 'b.png'), newName: 'Coffee Receipt', category: 'Receipts' },
          { path: join(src, 'c.png'), newName: 'Build Failure', category: 'Errors' },
        ],
        destinationDir: join(dir, 'Organized'),
        groupByCategory: true,
        onConflict: 'suffix',
      },
      ctxFor(dir, journal, 'organize'),
    );
    expect(out.moved.map((m) => m.to.replace(dir, ''))).toEqual([
      '/Organized/Receipts/Coffee Receipt.png',
      '/Organized/Receipts/Coffee Receipt 2.png',
      '/Organized/Errors/Build Failure.png',
    ]);
    const checks = await fsOrganize.verify!({ items: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] } as never, out, ctxFor(dir, journal, 'organize'));
    expect(checks.every((c) => c.ok)).toBe(true);
    await journal.flush();
    const report = await undoEntries(await UndoJournal.read(journal.file));
    expect(report).toEqual({ ok: true, steps: 6, failures: [] });
    expect(await readFile(join(src, 'b.png'), 'utf8')).toBe('b.png');
    await expect(readFile(join(dir, 'Organized', 'Receipts', 'Coffee Receipt.png'))).rejects.toThrow();
  });

  it('never deletes a created file that changed afterwards', async () => {
    const dir = await tempDir();
    const journal = new UndoJournal(join(dir, 'journal.jsonl'), 'run_t');
    const p = join(dir, 'notes.txt');
    await fsWriteText.run({ path: p, content: 'v1', overwrite: false }, ctxFor(dir, journal, 'w'));
    await writeFile(p, 'edited by the user');
    await journal.flush();
    const report = await undoEntries(await UndoJournal.read(journal.file));
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toMatch(/changed after CommandOS created it/);
    expect(await readFile(p, 'utf8')).toBe('edited by the user');
  });

  it('overwrite keeps a backup that undo restores', async () => {
    const dir = await tempDir();
    const journal = new UndoJournal(join(dir, 'journal.jsonl'), 'run_t');
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await writeFile(a, 'A');
    await writeFile(b, 'B');
    await fsMove.run({ from: a, to: b, overwrite: true }, ctxFor(dir, journal, 'm'));
    expect(await readFile(b, 'utf8')).toBe('A');
    await journal.flush();
    const report = await undoEntries(await UndoJournal.read(journal.file));
    expect(report.ok).toBe(true);
    expect(await readFile(a, 'utf8')).toBe('A');
    expect(await readFile(b, 'utf8')).toBe('B');
  });
});

describe('audit log', () => {
  it('chains hashes and detects tampering', async () => {
    const dir = await tempDir();
    const file = join(dir, 'audit.jsonl');
    const log = new AuditLog(file);
    await log.init();
    const testKey = ['sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz', '123456'].join('');
    await log.append('a', 'user', { command: 'x', apiKey: testKey });
    await log.append('b', 'agent', { n: 2 }, { runId: 'run_1' });
    const reopened = new AuditLog(file);
    await reopened.init();
    await reopened.append('c', 'system', {});
    expect(await AuditLog.verify(file)).toEqual({ ok: true, records: 3 });
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('sk-proj-');
    await writeFile(file, text.replace('"n":2', '"n":3'));
    const v = await AuditLog.verify(file);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });
});

describe('router grammar', () => {
  it('parses the flagship screenshot command without a model', () => {
    const s = matchOrganizeScreenshots('Find my five latest screenshots, rename them based on their contents, and put them in a folder');
    expect(s).toMatchObject({ count: 5, renameByContent: true, groupByCategory: false, report: false });
  });

  it('extracts folder names, sources, categories and reports', () => {
    const s = matchOrganizeScreenshots(
      'Take the 3 most recent screenshots from my CommandOS demo, sort them into categories, put them in a folder called Inbox Zero and write a report',
    );
    expect(s).toMatchObject({ count: 3, sourceFolder: '~/CommandOS-Demo', destinationName: 'Inbox Zero', groupByCategory: true, report: true });
  });

  it('refuses risky phrasings so they go to the model and policy', () => {
    expect(matchOrganizeScreenshots('delete my old screenshots')).toBeNull();
    expect(matchOrganizeScreenshots('email my latest screenshots to Sam')).toBeNull();
    expect(matchOrganizeScreenshots('what is on my screen')).toBeNull();
  });

  it('recognizes control phrases', () => {
    expect(matchControl('Stop')).toBe('cancel');
    expect(matchControl('undo that')).toBe('undo');
    expect(matchControl('go ahead')).toBe('approve');
    expect(matchControl('emergency stop')).toBe('emergency_stop');
    expect(matchControl('stop the music in Spotify')).toBeNull();
  });
});

describe('local routes that skip the router model', () => {
  it('reads the draft purchase request slots and refuses wording the template cannot honour', () => {
    expect(
      matchWebForm('Open the Northwind partner portal and fill a draft purchase request for Rivera Labs, ops@rivera.example, 40 units of the cheapest in-stock product. Do not submit it.'),
    ).toMatchObject({ company: 'Rivera Labs', email: 'ops@rivera.example', quantity: 40, criteria: 'cheapest in-stock product', variant: null, sku: null });
    expect(matchWebForm('Fill the purchase request on the partner portal layout B for Acme & Sons, buyer@acme.co.uk, 12 units of NW-2210')).toMatchObject({
      company: 'Acme & Sons',
      quantity: 12,
      sku: 'NW-2210',
      variant: 'b',
    });
    // submitting, natural-language dates and missing details go to the router model
    expect(matchWebForm('Fill a purchase request on the partner portal for Rivera Labs, ops@rivera.example, 40 units and submit it')).toBeNull();
    expect(matchWebForm('Fill a purchase request on the partner portal for Rivera Labs, ops@rivera.example, 40 units, needed by next Friday')).toBeNull();
    expect(matchWebForm('Fill a purchase request on the partner portal for Rivera Labs, 40 units')).toBeNull();
  });

  it('sends plainly safe commands straight to STANDARD and everything risky to the router', () => {
    for (const safe of [
      'Make a folder ~/Desktop/notes and write a.txt in it',
      'Read every document in ~/Documents/Inbox and write a summary.md',
      'Look at the newest screenshot on my Desktop and tell me what it shows',
      'Group the files in ~/Downloads by type into subfolders',
    ]) {
      expect(matchDirectStandard(safe)?.decision).toMatchObject({ mode: 'standard', via: 'grammar' });
    }
    for (const risky of [
      'Delete every screenshot in ~/Desktop/Old except the newest',
      'Email the Q3 board deck to Dana',
      'Clean up my desktop please',
      'Search the web for flights to Lisbon',
      'Click the Send button in Mail',
      'text Mom that I am running late',
      'Type "hello" into the open window',
      'Fix the failing tests in ~/code/app',
      'open Safari',
    ]) {
      expect(matchDirectStandard(risky)).toBeNull();
    }
    // grammars still win over the direct route
    expect(routeLocally('stop')?.control).toBe('cancel');
    // ambiguous clean-ups and unplaced paths are not the screenshot workflow
    expect(matchOrganizeScreenshots('Clean up /tmp/x/Inbox2 by archiving the screenshots into a subfolder called Archive')).toBeNull();
    expect(routeLocally('Clean up /tmp/x/Inbox2 by archiving the screenshots into a subfolder called Archive')).toBeNull();
    expect(matchOrganizeScreenshots('Sort /tmp/x/Inbox2 screenshots into folders')).toBeNull();
    expect(matchOrganizeScreenshots('Find my five latest screenshots in ~/CommandOS-Demo/Screenshots, sort them into categories, put them in a folder called Sorted')).not.toBeNull();
  });
});

describe('fewer prompts, same safety', () => {
  const settings = { ...defaultSettings(), userEmail: 'me@x.com' };
  it('sends to your own address without asking, and asks for anyone else', () => {
    expect(evaluatePolicy({ tool: gmailSend, args: { to: 'Me@X.com', subject: 'Photo', body: '' }, settings }).action).toBe('allow');
    expect(evaluatePolicy({ tool: gmailSend, args: { to: 'someone@else.com', subject: 'Photo', body: '' }, settings }).action).toBe('require_approval');
    expect(evaluatePolicy({ tool: gmailSend, args: { to: 'me@x.com', subject: 'Photo', body: '' }, settings: { ...settings, confirmSelfEmail: true } }).action).toBe('require_approval');
    // without a saved address nothing counts as "yourself"
    expect(evaluatePolicy({ tool: gmailSend, args: { to: 'me@x.com', subject: 'Photo', body: '' }, settings: { ...settings, userEmail: null } }).action).toBe('require_approval');
  });

  it('asks once per run to send screenshots to the model, and reads its own captures freely', () => {
    const args = { imagePath: '/tmp/run/artifacts/captures/a.png', question: 'what is this?', wantBox: false };
    const first = evaluatePolicy({ tool: visionAsk, args, settings, extraReadRoots: ['/tmp/run/artifacts'] });
    expect(first.action).toBe('require_approval');
    expect(first.reasons).toEqual(['sends images to the model provider']);
    expect(evaluatePolicy({ tool: visionAsk, args, settings, extraReadRoots: ['/tmp/run/artifacts'], consents: new Set(['images']) }).action).toBe('allow');
  });
});

describe('email workflow', () => {
  const slots = (over: Record<string, unknown>) =>
    ({
      count: null, sourceFolder: null, destinationFolder: null, destinationName: null, renameByContent: null, groupByCategory: null, withinDays: null, report: null, reportTitle: null,
      target: null, company: null, email: null, quantity: null, neededBy: null, notes: null, sku: null, criteria: null, url: null, variant: null, to: null, subject: null, body: null,
      ...over,
    }) as Parameters<typeof routeFromModelOutput>[0]['slots'];

  it('maps a routed email to the Gmail template, even when the router chose deep', () => {
    const r = routeFromModelOutput({ mode: 'deep', intent: 'send_email', confidence: 0.9, reason: 'sends an email', needsFullPreview: true, slots: slots({ to: 'myself', body: 'Hi' }) });
    expect(r.email).toEqual({ to: 'me', subject: 'Hi', body: 'Hi' });
    expect(r.decision.mode).toBe('fast');
    // without a recipient there is no template: the model plans it
    expect(routeFromModelOutput({ mode: 'deep', intent: 'send_email', confidence: 0.9, reason: 'x', needsFullPreview: true, slots: slots({ body: 'Hi' }) }).email).toBeUndefined();
  });

  it('opens the draft first and sends only with the exact email bound for the approval', () => {
    const plan = emailPlan({ to: 'me', subject: 'Hi', body: 'Hi' });
    expect(plan.tasks.map((t) => t.tool)).toEqual(['gmail.compose', 'gmail.send']);
    expect(plan.tasks[1]?.bind?.map((b) => b.arg).sort()).toEqual(['body', 'subject', 'to']);
    const settings = defaultSettings();
    // sending is external: approval every time, whatever the risk settings
    const send = evaluatePolicy({ tool: gmailSend, args: { to: 'me@x.com', subject: 'Hi', body: 'Hi' }, settings });
    expect(send.action).toBe('require_approval');
    expect(evaluatePolicy({ tool: gmailCompose, args: { to: 'me', subject: 'Hi', body: 'Hi' }, settings }).action).toBe('allow');
  });
});

describe('explicit website audit routing', () => {
  it('streams a multi-provider audit without a router call or DEEP plan', () => {
    const text = 'Audit https://www.daytona.io with Anchor Browser. Visit the homepage and three internal pages. Create a dependency-free Node.js audit project with a package.json in ~/Desktop/Website-Audit. Use a real Daytona sandbox for analysis. Close the browser and delete the sandbox afterward. Do not submit forms.';
    expect(routeLocally(text)).toMatchObject({ decision: { mode: 'standard', intent: 'general', via: 'grammar', needsFullPreview: true } });
    expect(routeLocally(text)?.repo).toBeUndefined();
    expect(routeLocally(text)?.web).toBeUndefined();
  });
});

describe('GitHub issue repair routing', () => {
  it.each([
    'Open my checkout-demo GitHub repo in Chrome. Read issue one with Anchor, then fix it in Daytona using the local copy listed in the issue. Show the patch and test results. Keep the sandbox, and don’t push changes',
    'Read GitHub issue https://github.com/example/checkout/issues/1 with Anchor Browser. Fix the tests in ~/Projects/checkout in Daytona and keep the sandbox.',
  ])('streams an issue repair without DEEP planning or dropping the browser steps: %s', (text) => {
    const route = routeLocally(text)!;
    expect(route).toMatchObject({ decision: { mode: 'standard', intent: 'repo_test_fix', via: 'grammar', needsFullPreview: true } });
    expect(isStandardRoute(route)).toBe(true);
    expect(route.repo).toBeUndefined();
  });

  it('resolves the named checkout before planning instead of guessing a GitHub owner', () => {
    expect(routeLocally('Open my checkout-demo GitHub repo in Chrome. Read issue one with Anchor, then fix it in Daytona using the local copy listed in the issue.')?.githubRepositoryName).toBe('checkout-demo');
    expect(routeLocally('Read GitHub issue https://github.com/example/checkout-demo/issues/1 with Anchor and fix it in Daytona.')?.githubRepositoryName).toBeUndefined();
  });

  it('does not select the repair route for unrelated GitHub browsing', () => {
    expect(routeLocally('Use Anchor to read my GitHub issues and save a report in Daytona')?.decision.reason).not.toContain('GitHub issue repair');
  });
});

describe('everyday commands with no model', () => {
  it('chains apps and sites in the browser the user named', () => {
    const steps = matchQuickCommand('open google chrome and open gmail');
    expect(steps).toEqual([
      { kind: 'open_app', name: 'google chrome', bundleId: 'com.google.Chrome' },
      { kind: 'open_url', label: 'gmail', url: 'https://mail.google.com/mail/u/0/#inbox', bundleId: 'com.google.Chrome' },
    ]);
    expect(quickPlan(steps!).tasks.map((t) => `${t.id}:${t.tool}:${(t.dependsOn ?? []).join('+')}`)).toEqual(['s1:apps.launch:', 's2:workspace.open:s1']);
  });

  it('turns "open Chrome, open Gmail, email myself" into just the draft and the send (no extra tabs)', () => {
    const steps = matchQuickCommand('open google chrome and open gmail and email myself hi');
    expect(steps).toEqual([{ kind: 'email', to: 'me', subject: 'hi', body: 'hi' }]);
    const plan = quickPlan(steps!);
    expect(plan.tasks.map((t) => `${t.id}:${t.tool}:${(t.dependsOn ?? []).join('+')}`)).toEqual(['s1_compose:gmail.compose:', 's1_send:gmail.send:s1_compose']);
    expect(plan.tasks.at(-1)?.bind?.every((b) => b.from.startsWith('s1_compose.output.'))).toBe(true);
    expect(routeLocally('open google chrome and open gmail and email myself hi')?.decision).toMatchObject({ mode: 'fast', intent: 'send_email', via: 'grammar' });
    // instructions about sending are not part of the message
    expect(matchQuickCommand('open google chrome and open gmail and email myself hi and make sure it sends')).toEqual([{ kind: 'email', to: 'me', subject: 'hi', body: 'hi' }]);
    expect(matchQuickCommand('email me lunch at noon, send it now')?.[0]).toMatchObject({ body: 'lunch at noon' });
  });

  it('understands sites, folders, searches and plainly worded emails', () => {
    expect(matchQuickCommand('go to github.com')).toEqual([{ kind: 'open_url', label: 'github.com', url: 'https://github.com', bundleId: null }]);
    expect(matchQuickCommand('open my downloads folder')).toEqual([{ kind: 'open_folder', label: 'downloads', path: '~/Downloads' }]);
    expect(matchQuickCommand('search google for best ramen in boston')?.[0]).toMatchObject({ kind: 'open_url', url: 'https://www.google.com/search?q=best%20ramen%20in%20boston' });
    expect(matchQuickCommand('open notes')).toEqual([{ kind: 'open_app', name: 'notes', bundleId: 'com.apple.Notes' }]);
    // an email keeps the rest of the command as its message, "and" included
    expect(matchQuickCommand('email me buy bread and milk')).toEqual([{ kind: 'email', to: 'me', subject: 'buy bread and milk', body: 'buy bread and milk' }]);
    expect(matchQuickCommand('send an email to sam@example.com saying the build is done')?.[0]).toMatchObject({ kind: 'email', to: 'sam@example.com', body: 'the build is done' });
  });

  it('takes a photo, opens it and emails it to you with no model', () => {
    const steps = matchQuickCommand('open photo booth and take a photo of me and open the photo in google chrome and send it to myself');
    expect(steps).toEqual([
      { kind: 'open_app', name: 'photo booth', bundleId: 'com.apple.PhotoBooth' },
      { kind: 'take_photo' },
      { kind: 'open_photo', bundleId: 'com.google.Chrome' },
      { kind: 'email', to: 'me', subject: 'Photo', body: '', attachPhoto: true },
    ]);
    const plan = quickPlan(steps!);
    expect(plan.tasks.map((t) => `${t.id}:${t.tool}`)).toEqual(['s1:apps.launch', 's2:photobooth.takePhoto', 's3:workspace.open', 's4_compose:gmail.compose', 's4_send:gmail.send']);
    expect(plan.tasks[2]?.bind).toEqual([{ arg: 'path', from: 's2.output.path' }]);
    expect(plan.tasks[3]?.bind).toContainEqual({ arg: 'attachments.0', from: 's2.output.path' });
    // typed commands with swapped letters still match
    expect(fixSwappedLetters('take a selfie and sned it to myslef')).toBe('take a selfie and send it to myself');
    expect(matchQuickCommand('take a selfie and sned it to myslef')).toEqual([{ kind: 'take_photo' }, { kind: 'email', to: 'me', subject: 'Photo', body: '', attachPhoto: true }]);
    // "send it" with nothing to send is not understood
    expect(matchQuickCommand('send it to myself')).toBeNull();
  });

  it.each([
    'Open Photo Booth, take a picture, and send an email to myself.',
    'Open Photo Booth, take a picture and send an email to myself.',
    'Open Photo Booth and take a picture and email myself.',
  ])('routes the spoken photo-email command without router or planner calls: %s', (text) => {
    const steps = matchQuickCommand(text);
    expect(steps).toEqual([
      { kind: 'open_app', name: 'Photo Booth', bundleId: 'com.apple.PhotoBooth' },
      { kind: 'take_photo' },
      { kind: 'email', to: 'me', subject: 'Photo', body: '', attachPhoto: true },
    ]);
    expect(routeLocally(text)?.decision).toMatchObject({ mode: 'fast', via: 'grammar', intent: 'send_email' });
    const tasks = quickPlan(steps!).tasks;
    expect(tasks.at(-2)?.bind).toContainEqual({ arg: 'attachments.0', from: 's2.output.path' });
    expect(tasks.at(-1)?.bind).toContainEqual({ arg: 'to', from: 's3_compose.output.to' });
  });

  it('preserves email commas and declines unsupported photo-email constraints', () => {
    expect(matchQuickCommand('email me Hello, Sam, the build is done')?.[0]).toMatchObject({ body: 'Hello, Sam, the build is done' });
    expect(matchQuickCommand('Take a picture, and send an email to myself without the photo')).toBeNull();
    expect(matchQuickCommand('Open Photo Booth, do not take a photo, and email myself')).toBeNull();
    expect(matchQuickCommand('Send an email to myself')).toBeNull();
  });

  it('leaves anything it does not fully understand to the router', () => {
    // speech filler: the router model separates the message from the noise
    expect(matchQuickCommand('OPEN GOOGLE CHROME AND OPEN GMAIL AND EMAIL MYSLEF LIKE WTV EMAIL IS THERE HI')).toBeNull();
    expect(matchQuickCommand('open terminal and run rm -rf ~/Documents')).toBeNull();
    expect(matchQuickCommand('delete my old screenshots')).toBeNull();
    expect(matchQuickCommand('open the quarterly report and summarize it')).toBeNull();
    expect(matchQuickCommand('email me')).toBeNull();
    // other instructions inside the message are for the router model to read
    expect(matchQuickCommand('email me the notes and attach the pdf')).toBeNull();
  });
});

describe('least privilege: symlink escapes', () => {
  it('denies writes through a symlink that points outside the allowed folders', async () => {
    const { symlink } = await import('node:fs/promises');
    const allowed = await tempDir('commandos-allowed-');
    const outside = await tempDir('commandos-outside-');
    await symlink(outside, join(allowed, 'innocent-looking-folder'));
    const d = evaluatePolicy({
      tool: fsWriteText,
      args: { path: join(allowed, 'innocent-looking-folder', 'payload.txt'), content: 'x', overwrite: false },
      settings: { ...defaultSettings(), allowedRoots: [allowed] },
    });
    expect(d.action).toBe('deny');
    expect(d.reasons.join()).toMatch(/outside the folders/);
  });
});
