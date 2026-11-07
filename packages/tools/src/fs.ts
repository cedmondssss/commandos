import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, opendir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { CheckResult, UndoOp } from '@commandos/contracts';
import { z } from 'zod';
import { canonicalPath, displayPath, resolveUserPath, sanitizeFileName, uniquePath, withExtension } from './paths';
import { defineTool, type ToolContext, ToolError } from './types';

export const PathArg = z.string().min(1).max(1024).describe('Absolute path or ~/relative path');

const EntryKind = z.enum(['file', 'dir', 'symlink', 'other']);
const EntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: EntryKind,
  size: z.number(),
  modified: z.string(),
  created: z.string(),
});
export type FsEntry = z.infer<typeof EntrySchema>;

export async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function entryFor(path: string): Promise<FsEntry> {
  const s = await lstat(path);
  return {
    name: basename(path),
    path,
    kind: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
    size: s.size,
    modified: s.mtime.toISOString(),
    created: s.birthtime.toISOString(),
  };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

/** rename(2) with a copy+remove fallback across volumes. Refuses to overwrite. */
export async function movePath(from: string, to: string): Promise<void> {
  if (await pathExists(to)) throw new ToolError('exists', `destination already exists: ${displayPath(to)}`);
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

/** mkdir -p that journals every directory it creates so undo can remove them (deepest first). */
export async function ensureDir(dir: string, ctx: Pick<ToolContext, 'journal'>, created: string[]): Promise<void> {
  const missing: string[] = [];
  let cur = dir;
  while (!(await pathExists(cur))) {
    missing.unshift(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const d of missing) {
    await mkdir(d);
    created.push(d);
    await ctx.journal.record({ kind: 'delete_created', path: d, isDir: true });
  }
}

async function check(label: string, fn: () => Promise<boolean>, detail?: string): Promise<CheckResult> {
  try {
    const ok = await fn();
    return { label, ok, ...(detail ? { detail } : {}) };
  } catch (e) {
    return { label, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', 'Library', '.cache']);

async function walk(
  root: string,
  maxDepth: number,
  visit: (path: string, depth: number) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  async function rec(dir: string, depth: number): Promise<boolean> {
    if (signal?.aborted) return false;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(dir);
    } catch {
      return true;
    }
    for await (const ent of handle) {
      if (ent.name.startsWith('.')) continue;
      const p = join(dir, ent.name);
      if (!(await visit(p, depth))) return false;
      if (ent.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(ent.name)) {
        if (!(await rec(p, depth + 1))) return false;
      }
    }
    return true;
  }
  await rec(root, 0);
}

export const fsList = defineTool({
  id: 'fs.list',
  title: 'List folder',
  description: 'List the entries of one folder (not recursive): name, path, kind (file/dir), size and modified time.',
  tier: 1,
  args: z.object({
    path: PathArg,
    includeHidden: z.boolean().default(false),
    limit: z.number().int().min(1).max(2000).default(500),
  }),
  output: z.object({ path: z.string(), entries: z.array(EntrySchema), truncated: z.boolean() }),
  effectClass: 'read',
  effects: ['fs_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 15_000,
  paths: (a) => ({ read: [a.path], write: [] }),
  async run(a) {
    const dir = resolveUserPath(a.path);
    const entries: FsEntry[] = [];
    let truncated = false;
    const handle = await opendir(dir);
    for await (const ent of handle) {
      if (!a.includeHidden && ent.name.startsWith('.')) continue;
      if (entries.length >= a.limit) {
        truncated = true;
        break;
      }
      entries.push(await entryFor(join(dir, ent.name)));
    }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    return { path: dir, entries, truncated };
  },
  summarize: (o) => ({
    path: displayPath(o.path),
    count: o.entries.length,
    truncated: o.truncated,
    entries: o.entries.slice(0, 40).map((e) => `${e.kind === 'dir' ? '📁 ' : ''}${e.name}`),
  }),
});

export const fsStat = defineTool({
  id: 'fs.stat',
  title: 'File info',
  description: 'Check whether a path exists and return its kind, size, created and modified time.',
  tier: 1,
  args: z.object({ path: PathArg }),
  output: z.object({ path: z.string(), exists: z.boolean(), entry: EntrySchema.nullable() }),
  effectClass: 'read',
  effects: ['fs_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 5_000,
  paths: (a) => ({ read: [a.path], write: [] }),
  async run(a) {
    const p = resolveUserPath(a.path);
    if (!(await pathExists(p))) return { path: p, exists: false, entry: null };
    return { path: p, exists: true, entry: await entryFor(p) };
  },
});

export const fsFind = defineTool({
  id: 'fs.find',
  title: 'Find files',
  description:
    'Search folders for files by extension, name fragment and age. Recursive up to maxDepth. Returns files sorted newest first by default.',
  tier: 1,
  args: z.object({
    roots: z.array(PathArg).min(1).max(20),
    extensions: z.array(z.string().max(12)).max(30).optional(),
    nameContains: z.string().max(200).optional(),
    modifiedWithinDays: z.number().positive().max(36500).optional(),
    maxDepth: z.number().int().min(0).max(8).default(3),
    limit: z.number().int().min(1).max(5000).default(200),
    sort: z.enum(['newest', 'oldest', 'name', 'largest']).default('newest'),
  }),
  output: z.object({ files: z.array(EntrySchema), scanned: z.number().int() }),
  effectClass: 'read',
  effects: ['fs_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 60_000,
  paths: (a) => ({ read: a.roots, write: [] }),
  async run(a, ctx) {
    const exts = a.extensions?.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
    const needle = a.nameContains?.toLowerCase();
    const cutoff = a.modifiedWithinDays ? Date.now() - a.modifiedWithinDays * 86_400_000 : 0;
    const files: FsEntry[] = [];
    let scanned = 0;
    for (const root of a.roots.map(resolveUserPath)) {
      await walk(
        root,
        a.maxDepth,
        async (p) => {
          scanned++;
          if (exts && !exts.includes(extname(p).toLowerCase())) return true;
          if (needle && !basename(p).toLowerCase().includes(needle)) return true;
          const s = await stat(p).catch(() => null);
          if (!s?.isFile()) return true;
          if (cutoff && s.mtimeMs < cutoff) return true;
          files.push({
            name: basename(p),
            path: p,
            kind: 'file',
            size: s.size,
            modified: s.mtime.toISOString(),
            created: s.birthtime.toISOString(),
          });
          return scanned < 200_000;
        },
        ctx.signal,
      );
    }
    const sorters: Record<typeof a.sort, (x: FsEntry, y: FsEntry) => number> = {
      newest: (x, y) => y.modified.localeCompare(x.modified),
      oldest: (x, y) => x.modified.localeCompare(y.modified),
      name: (x, y) => x.name.localeCompare(y.name),
      largest: (x, y) => y.size - x.size,
    };
    files.sort(sorters[a.sort]);
    return { files: files.slice(0, a.limit), scanned };
  },
  summarize: (o) => ({ count: o.files.length, scanned: o.scanned, files: o.files.slice(0, 30).map((f) => displayPath(f.path)) }),
});

export const fsMkdir = defineTool({
  id: 'fs.mkdir',
  undo: 'journaled',
  title: 'Create folder',
  description: 'Create a folder (and missing parents). Reversible: undo removes folders it created if still empty.',
  tier: 1,
  args: z.object({ path: PathArg }),
  output: z.object({ path: z.string(), created: z.array(z.string()) }),
  effectClass: 'reversible_local',
  effects: ['fs_write'],
  risk: 'low',
  idempotent: true,
  defaultTimeoutMs: 5_000,
  paths: (a) => ({ read: [], write: [a.path] }),
  resources: (a) => [`fs:${resolveUserPath(a.path)}`],
  preview: (a) => ({ summary: `Create folder ${displayPath(resolveUserPath(a.path))}`, details: [] }),
  async run(a, ctx) {
    const p = resolveUserPath(a.path);
    const created: string[] = [];
    await ensureDir(p, ctx, created);
    return { path: p, created };
  },
  async verify(_a, o) {
    return [await check(`folder exists: ${displayPath(o.path)}`, async () => (await stat(o.path)).isDirectory())];
  },
});

export const fsMove = defineTool({
  id: 'fs.move',
  undo: 'journaled',
  title: 'Move or rename',
  description:
    'Move or rename one file or folder. If `to` is an existing folder the item is moved into it. Never overwrites unless overwrite=true (the overwritten file is backed up). Reversible.',
  tier: 1,
  args: z.object({ from: PathArg, to: PathArg, overwrite: z.boolean().default(false) }),
  output: z.object({ from: z.string(), to: z.string(), backedUp: z.string().nullable() }),
  effectClass: 'reversible_local',
  effects: ['fs_write'],
  risk: (a) => (a.overwrite ? 'medium' : 'low'),
  idempotent: false,
  defaultTimeoutMs: 60_000,
  paths: (a) => ({ read: [a.from], write: [a.from, a.to] }),
  itemCount: () => 1,
  resources: (a) => [`fs:${resolveUserPath(a.from)}`, `fs:${resolveUserPath(a.to)}`],
  preview: (a) => ({
    summary: `Move ${displayPath(resolveUserPath(a.from))} → ${displayPath(resolveUserPath(a.to))}`,
    details: a.overwrite ? ['Overwrites the destination if it exists (a backup is kept for undo)'] : [],
  }),
  async run(a, ctx) {
    const from = resolveUserPath(a.from);
    let to = resolveUserPath(a.to);
    if (!(await pathExists(from))) throw new ToolError('not_found', `no such file: ${displayPath(from)}`);
    const toStat = await stat(to).catch(() => null);
    if (toStat?.isDirectory()) to = join(to, basename(from));
    let backedUp: string | null = null;
    if (await pathExists(to)) {
      if (!a.overwrite) throw new ToolError('exists', `destination already exists: ${displayPath(to)}`);
      backedUp = join(ctx.artifactsDir, 'backups', ctx.taskId, `${Date.now()}-${basename(to)}`);
      await movePath(to, backedUp);
      await ctx.journal.record({ kind: 'restore_backup', path: to, backupPath: backedUp });
    }
    const created: string[] = [];
    await ensureDir(dirname(to), ctx, created);
    await movePath(from, to);
    await ctx.journal.record({ kind: 'move_back', from, to });
    return { from, to, backedUp };
  },
  async verify(_a, o) {
    return [
      await check(`exists: ${displayPath(o.to)}`, () => pathExists(o.to)),
      await check(`gone from: ${displayPath(o.from)}`, async () => !(await pathExists(o.from))),
    ];
  },
});

export const fsCopy = defineTool({
  id: 'fs.copy',
  undo: 'journaled',
  title: 'Copy file',
  description:
    'Copy one file to an allowed folder without changing the source. If the destination exists, keep both by adding a numeric suffix. Reversible; never overwrites.',
  tier: 1,
  args: z.object({ from: PathArg, to: PathArg }),
  output: z.object({ from: z.string(), to: z.string(), bytes: z.number().int(), sha256: z.string() }),
  effectClass: 'reversible_local',
  effects: ['fs_read', 'fs_write'],
  risk: 'low',
  idempotent: false,
  defaultTimeoutMs: 60_000,
  paths: (a) => ({ read: [a.from], write: [a.to] }),
  itemCount: () => 1,
  resources: (a) => [`fs:${resolveUserPath(a.from)}`, `fs:${resolveUserPath(a.to)}`],
  preview: (a) => ({
    summary: `Copy ${displayPath(resolveUserPath(a.from))} → ${displayPath(resolveUserPath(a.to))}`,
    details: ['The source stays in place; an existing destination is preserved with a numeric suffix.'],
  }),
  async run(a, ctx) {
    const from = resolveUserPath(a.from);
    let to = resolveUserPath(a.to);
    const sourceStat = await lstat(from).catch(() => null);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
      throw new ToolError('not_found', `no regular file: ${displayPath(from)}`);
    }
    if ((await stat(to).catch(() => null))?.isDirectory()) to = join(to, basename(from));
    if (from === to) throw new ToolError('invalid_path', 'source and destination are the same file');
    const created: string[] = [];
    await ensureDir(dirname(to), ctx, created);
    if (await pathExists(to)) to = await uniquePath(dirname(to), basename(to));
    await copyFile(from, to, constants.COPYFILE_EXCL);
    const sha256 = await sha256File(to);
    await ctx.journal.record({ kind: 'delete_created', path: to, isDir: false, sha256 });
    return { from, to, bytes: sourceStat.size, sha256 };
  },
  async verify(_a, o) {
    return [
      await check(`copy exists: ${displayPath(o.to)}`, () => pathExists(o.to)),
      await check('source remains in place', () => pathExists(o.from)),
      await check('copy matches source', async () => (await sha256File(o.from)) === o.sha256 && (await sha256File(o.to)) === o.sha256),
    ];
  },
  summarize: (o) => ({ from: displayPath(o.from), to: displayPath(o.to), bytes: o.bytes }),
});

const OrganizeItem = z.object({
  path: PathArg,
  newName: z.string().min(1).max(200).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  summary: z.string().max(1000).nullable().optional(),
});

const MovedSchema = z.object({
  from: z.string(),
  to: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  summary: z.string().nullable(),
});

export const fsOrganize = defineTool({
  id: 'fs.organize',
  undo: 'journaled',
  title: 'Rename & organize files',
  description:
    'Move many files into a destination folder, optionally renaming each (newName keeps the original extension) and grouping into category subfolders. Never overwrites: conflicting names get a numeric suffix. Files already at their exact target are verified and returned in alreadyInPlace without a move or undo entry. complete means every input is moved or already in place. Reversible.',
  tier: 1,
  args: z.object({
    items: z.array(OrganizeItem).min(1).max(1000),
    destinationDir: PathArg,
    groupByCategory: z.boolean().default(false),
    onConflict: z.enum(['suffix', 'fail']).default('suffix'),
  }),
  output: z.object({ destinationDir: z.string(), moved: z.array(MovedSchema), alreadyInPlace: z.array(z.string()), complete: z.boolean(), createdDirs: z.array(z.string()) }),
  effectClass: 'reversible_local',
  effects: ['fs_write'],
  risk: 'low',
  idempotent: false,
  defaultTimeoutMs: 120_000,
  paths: (a) => ({ read: a.items.map((i) => i.path), write: [...a.items.map((i) => i.path), a.destinationDir] }),
  itemCount: (a) => a.items.length,
  resources: (a) => [`fs:${resolveUserPath(a.destinationDir)}`, ...a.items.map((i) => `fs:${resolveUserPath(i.path)}`)],
  preview: (a) => ({
    summary: `Move ${a.items.length} file(s) into ${displayPath(resolveUserPath(a.destinationDir))}${a.groupByCategory ? ' (grouped by category)' : ''}`,
    details: a.items.slice(0, 20).map((i) => `${basename(resolveUserPath(i.path))}${i.newName ? ` → ${i.newName}${extname(i.path)}` : ''}`),
  }),
  async run(a, ctx) {
    const dest = resolveUserPath(a.destinationDir);
    const createdDirs: string[] = [];
    await ensureDir(dest, ctx, createdDirs);
    const taken = new Set<string>();
    const moved: z.infer<typeof MovedSchema>[] = [];
    const alreadyInPlace: string[] = [];
    for (const item of a.items) {
      if (ctx.signal.aborted) throw new ToolError('cancelled', 'cancelled');
      const from = resolveUserPath(item.path);
      if (!(await pathExists(from))) throw new ToolError('not_found', `no such file: ${displayPath(from)}`);
      const ext = extname(from);
      const name = item.newName ? withExtension(item.newName, ext) : basename(from);
      const category = item.category ? sanitizeFileName(item.category, 60) : null;
      const targetDir = a.groupByCategory && category ? join(dest, category) : dest;
      await ensureDir(targetDir, ctx, createdDirs);
      let to = join(targetDir, name);
      if (canonicalPath(to) === canonicalPath(from)) {
        alreadyInPlace.push(from);
        ctx.progress(`Already in destination: ${basename(from)}`);
        continue;
      }
      if (a.onConflict === 'suffix') to = await uniquePath(targetDir, name, taken);
      else if (await pathExists(to)) throw new ToolError('exists', `destination already exists: ${displayPath(to)}`);
      taken.add(to);
      await movePath(from, to);
      await ctx.journal.record({ kind: 'move_back', from, to });
      moved.push({ from, to, name: basename(to), category, summary: item.summary ?? null });
      ctx.progress(`Moved ${basename(from)} → ${displayPath(to)}`);
    }
    return { destinationDir: dest, moved, alreadyInPlace, complete: moved.length + alreadyInPlace.length === a.items.length, createdDirs };
  },
  async verify(a, o) {
    const checks: CheckResult[] = [
      { label: 'every requested item moved or already in place', ok: o.complete && o.moved.length + o.alreadyInPlace.length === a.items.length },
    ];
    for (const m of o.moved) {
      checks.push(await check(`exists: ${displayPath(m.to)}`, () => pathExists(m.to)));
      checks.push(await check(`moved away: ${displayPath(m.from)}`, async () => !(await pathExists(m.from))));
    }
    for (const path of o.alreadyInPlace) checks.push(await check(`already in destination: ${displayPath(path)}`, () => pathExists(path)));
    return checks;
  },
  alternatives(a, error) {
    if (error.code === 'exists' && a.onConflict === 'fail') return [{ args: { ...a, onConflict: 'suffix' as const }, label: 'keep both files by adding a numeric suffix' }];
    return [];
  },
  summarize: (o) => ({
    destinationDir: displayPath(o.destinationDir),
    moved: o.moved.map((m) => ({ name: m.name, category: m.category, from: basename(m.from) })),
    alreadyInPlace: o.alreadyInPlace.map(displayPath),
    complete: o.complete,
  }),
});

export const fsWriteText = defineTool({
  id: 'fs.writeText',
  undo: 'journaled',
  title: 'Write text file',
  description:
    'Create a UTF-8 text file. Refuses to overwrite unless overwrite=true, in which case the previous content is backed up for undo. Reversible.',
  tier: 1,
  args: z.object({ path: PathArg, content: z.string().max(5_000_000), overwrite: z.boolean().default(false) }),
  output: z.object({ path: z.string(), bytes: z.number().int(), overwrote: z.boolean() }),
  effectClass: 'reversible_local',
  effects: ['fs_write'],
  risk: (a) => (a.overwrite ? 'medium' : 'low'),
  idempotent: false,
  defaultTimeoutMs: 15_000,
  paths: (a) => ({ read: [], write: [a.path] }),
  itemCount: () => 1,
  resources: (a) => [`fs:${resolveUserPath(a.path)}`],
  preview: (a) => ({
    summary: `${a.overwrite ? 'Overwrite' : 'Create'} ${displayPath(resolveUserPath(a.path))} (${a.content.length} chars)`,
    details: [a.content.slice(0, 400)],
  }),
  async run(a, ctx) {
    const p = resolveUserPath(a.path);
    const existed = await pathExists(p);
    if (existed && !a.overwrite) throw new ToolError('exists', `file already exists: ${displayPath(p)}`);
    const created: string[] = [];
    await ensureDir(dirname(p), ctx, created);
    if (existed) {
      const backupPath = join(ctx.artifactsDir, 'backups', ctx.taskId, `${Date.now()}-${basename(p)}`);
      await mkdir(dirname(backupPath), { recursive: true });
      await cp(p, backupPath, { preserveTimestamps: true });
      await writeFile(p, a.content, 'utf8');
      await ctx.journal.record({ kind: 'restore_backup', path: p, backupPath });
    } else {
      await writeFile(p, a.content, { encoding: 'utf8', flag: 'wx' });
      await ctx.journal.record({ kind: 'delete_created', path: p, isDir: false, sha256: await sha256File(p) });
    }
    return { path: p, bytes: Buffer.byteLength(a.content), overwrote: existed };
  },
  async verify(a, o) {
    return [await check(`content written: ${displayPath(o.path)}`, async () => (await readFile(o.path, 'utf8')) === a.content)];
  },
});

export const fsReadText = defineTool({
  id: 'fs.readText',
  title: 'Read text file',
  description: 'Read a UTF-8 text file (truncated to maxBytes).',
  tier: 1,
  args: z.object({ path: PathArg, maxBytes: z.number().int().min(1).max(2_000_000).default(200_000) }),
  output: z.object({ path: z.string(), text: z.string(), bytes: z.number().int(), truncated: z.boolean() }),
  effectClass: 'read',
  effects: ['fs_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 15_000,
  paths: (a) => ({ read: [a.path], write: [] }),
  async run(a) {
    const p = resolveUserPath(a.path);
    const buf = await readFile(p);
    const truncated = buf.byteLength > a.maxBytes;
    return { path: p, text: buf.subarray(0, a.maxBytes).toString('utf8'), bytes: buf.byteLength, truncated };
  },
  summarize: (o) => ({ path: displayPath(o.path), bytes: o.bytes, truncated: o.truncated, preview: o.text.slice(0, 2000) }),
});

export const fsTrash = defineTool({
  id: 'fs.trash',
  undo: 'journaled',
  title: 'Move to Trash',
  description:
    'Move files or folders to the macOS Trash (never permanently deletes). Always requires user confirmation. Reversible until the Trash is emptied.',
  tier: 1,
  args: z.object({ paths: z.array(PathArg).min(1).max(500) }),
  output: z.object({ trashed: z.array(z.object({ from: z.string(), trashedPath: z.string() })) }),
  effectClass: 'reversible_local',
  effects: ['fs_delete'],
  risk: 'medium',
  idempotent: false,
  defaultTimeoutMs: 60_000,
  paths: (a) => ({ read: [], write: a.paths }),
  itemCount: (a) => a.paths.length,
  resources: (a) => a.paths.map((p) => `fs:${resolveUserPath(p)}`),
  preview: (a) => ({
    summary: `Move ${a.paths.length} item(s) to the Trash`,
    details: a.paths.slice(0, 30).map((p) => displayPath(resolveUserPath(p))),
  }),
  async run(a, ctx) {
    const trashed: Array<{ from: string; trashedPath: string }> = [];
    for (const raw of a.paths) {
      const from = resolveUserPath(raw);
      const { trashedPath } = await ctx.helper.call('fs.trash', { path: from }, { signal: ctx.signal });
      const op: UndoOp = { kind: 'untrash', trashedPath, originalPath: from };
      await ctx.journal.record(op);
      trashed.push({ from, trashedPath });
    }
    return { trashed };
  },
  async verify(_a, o) {
    const checks: CheckResult[] = [];
    for (const t of o.trashed) {
      checks.push(await check(`in Trash: ${basename(t.trashedPath)}`, () => pathExists(t.trashedPath)));
      checks.push(await check(`removed: ${displayPath(t.from)}`, async () => !(await pathExists(t.from))));
    }
    return checks;
  },
});

export const fsTools = [fsList, fsStat, fsFind, fsMkdir, fsMove, fsCopy, fsOrganize, fsWriteText, fsReadText, fsTrash];
