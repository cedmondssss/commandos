import { mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSettings } from '@commandos/contracts';
import { fsOrganize, HelperClient, type ToolContext } from '@commandos/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRuntime } from '../src/runtime';
import { UndoJournal, undoEntries } from '../src/journal';
import { tempDir } from './helpers';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await tempDir('commandos-repeat-'); directories.push(dir);
  const journal = new UndoJournal(join(dir, 'journal.jsonl'), 'repeat');
  const ctx: ToolContext = {
    runId: 'repeat', taskId: 'organize', signal: new AbortController().signal, dryRun: false,
    settings: { ...defaultSettings(), allowedRoots: [dir] }, helper: new HelperClient('/nonexistent'), models: null,
    providers: { get: async () => { throw new Error('No providers'); } },
    journal: { record: (op) => journal.record('organize', op) }, artifactsDir: join(dir, 'artifacts'),
    log: () => {}, progress: () => {},
  };
  return { dir, journal, ctx };
}

describe('repeating screenshot organization', () => {
  it('verifies already-in-place files without suffix copies or undo entries, and detects a missing file', async () => {
    const { dir, journal, ctx } = await fixture();
    const path = join(dir, 'Screenshot 1.png'); await writeFile(path, 'original');
    const args = { items: [{ path }], destinationDir: dir, groupByCategory: false, onConflict: 'suffix' as const };
    const output = await fsOrganize.run(args, ctx);
    expect(output).toMatchObject({ moved: [], alreadyInPlace: [path], complete: true, createdDirs: [] });
    expect((await fsOrganize.verify!(args, output, ctx)).every((c) => c.ok)).toBe(true);
    expect(await readdir(dir)).toEqual(['Screenshot 1.png']);
    expect(journal.entryCount).toBe(0);
    expect(await UndoJournal.read(journal.file)).toEqual([]);
    await rm(path);
    expect((await fsOrganize.verify!(args, output, ctx)).some((c) => !c.ok)).toBe(true);
  });

  it('handles mixed inputs and undoes only files actually moved', async () => {
    const { dir, journal, ctx } = await fixture();
    const dest = join(dir, 'Sorted'); await mkdir(dest);
    const already = join(dest, 'a.png'); const source = join(dir, 'b.png');
    await writeFile(already, 'A'); await writeFile(source, 'B');
    const args = { items: [{ path: already }, { path: source }], destinationDir: dest, groupByCategory: false, onConflict: 'suffix' as const };
    const output = await fsOrganize.run(args, ctx);
    expect(output.complete).toBe(true); expect(output.moved).toHaveLength(1); expect(output.alreadyInPlace).toEqual([already]);
    expect((await fsOrganize.verify!(args, output, ctx)).every((c) => c.ok)).toBe(true);
    expect((await fsOrganize.verify!(args, { ...output, alreadyInPlace: [] }, ctx))[0]?.ok).toBe(false);
    await journal.flush();
    expect(await undoEntries(await UndoJournal.read(journal.file))).toEqual({ ok: true, steps: 1, failures: [] });
    expect(await readFile(already, 'utf8')).toBe('A'); expect(await readFile(source, 'utf8')).toBe('B');
  });

  it('recognizes the same categorized target through a symlink alias', async () => {
    const { dir, journal, ctx } = await fixture();
    const dest = join(dir, 'Sorted'); await mkdir(join(dest, 'Receipts'), { recursive: true });
    const path = join(dest, 'Receipts', 'Coffee.png'); await writeFile(path, 'receipt');
    const alias = join(dir, 'alias'); await symlink(dest, alias);
    const args = { items: [{ path, newName: 'Coffee', category: 'Receipts' }], destinationDir: alias, groupByCategory: true, onConflict: 'suffix' as const };
    const output = await fsOrganize.run(args, ctx);
    expect(output.moved).toEqual([]); expect(output.alreadyInPlace).toEqual([path]); expect(journal.entryCount).toBe(0);
    expect((await fsOrganize.verify!(args, output, ctx)).every((c) => c.ok)).toBe(true);
    expect(await readdir(join(dest, 'Receipts'))).toEqual(['Coffee.png']);
  });

  it('repeats the exact FAST workflow with recursive Spotlight results and reports a verified no-op', async () => {
    const { dir } = await fixture();
    const inbox = join(dir, 'Screenshots'); await mkdir(inbox);
    for (let index = 0; index < 8; index++) {
      const path = join(inbox, `Screenshot ${index}.png`);
      await writeFile(path, `image-${index}`);
      const modified = new Date(1_790_000_000_000 + index * 60_000); await utimes(path, modified, modified);
    }
    const rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: '/nonexistent', env: {}, useKeychain: false, telemetry: false, revealResults: false, settingsOverride: { allowedRoots: [inbox], screenshotRoots: [inbox] } });
    // Spotlight really searches descendants, including the destination after the first run.
    const findImages = async (root: string): Promise<string[]> => {
      const paths: string[] = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) paths.push(...await findImages(path));
        else if (entry.name.endsWith('.png')) paths.push(path);
      }
      return paths;
    };
    vi.spyOn(rt.helper, 'call').mockImplementation(async () => ({ items: (await findImages(inbox)).map((path) => ({ path, pixelWidth: null, pixelHeight: null })), truncated: false }) as never);
    try {
      const command = `Move my five latest screenshots in ${inbox} into a folder called HackBU Picks.`;
      const first = await rt.submit(command, 'text');
      const firstSummary = await rt.waitForRun(first);
      expect(firstSummary.state).toBe('succeeded'); expect(firstSummary.undoable).toBe(true);
      const paths = await findImages(inbox);
      const before = await Promise.all(paths.map(async (path) => ({ path, text: await readFile(path, 'utf8'), modified: (await stat(path)).mtimeMs })));
      const second = await rt.submit(command, 'text');
      const secondSummary = await rt.waitForRun(second);
      expect(secondSummary.state).toBe('succeeded'); expect(secondSummary.summary).toContain('5 file(s) are already in');
      expect(secondSummary.summary).toContain('No files needed moving'); expect(secondSummary.undoable).toBe(false); expect(secondSummary.modelCalls).toBe(0);
      const snapshot = await rt.getRun(second);
      expect(snapshot.events.some((e) => e.type === 'metric' && e.name === 'undo_operations' && e.value === 0)).toBe(true);
      expect((await findImages(inbox)).sort()).toEqual(paths.sort());
      for (const file of before) { expect(await readFile(file.path, 'utf8')).toBe(file.text); expect((await stat(file.path)).mtimeMs).toBe(file.modified); }
      await rt.undo(first);
      expect((await readdir(inbox)).filter((name) => name.endsWith('.png'))).toHaveLength(8);
    } finally { await rt.shutdown(); }
  });
});
