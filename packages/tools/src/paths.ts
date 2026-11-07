import { existsSync, realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const HOME = homedir();

/** Expands `~` and resolves relative paths against the home directory. */
export function resolveUserPath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return HOME;
  if (trimmed.startsWith('~/')) return resolve(HOME, trimmed.slice(2));
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return resolve(HOME, trimmed);
}

/**
 * Canonical path with symlinks resolved for the deepest existing ancestor, so a path that
 * does not exist yet can still be checked against roots without symlink escapes.
 */
export function canonicalPath(p: string): string {
  const abs = resolveUserPath(p);
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync(existing);
  } catch {
    // keep lexical path
  }
  return rest.length ? join(real, ...rest) : real;
}

/** True when `child` is `root` or inside it (both canonicalized). */
export function isWithin(root: string, child: string): boolean {
  const r = canonicalPath(root);
  const c = canonicalPath(child);
  if (r === c) return true;
  const rel = relative(r, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function displayPath(p: string): string {
  return p.startsWith(HOME + sep) ? `~${p.slice(HOME.length)}` : p;
}

const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f]+/g;

/** Makes a safe single path component: no separators, no control chars, bounded length. */
export function sanitizeFileName(name: string, maxLength = 120): string {
  let s = name.normalize('NFC').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (s.length > maxLength) s = s.slice(0, maxLength).trim();
  return s || 'untitled';
}

/** Keeps `ext` (".png") on a sanitized base name. */
export function withExtension(base: string, ext: string): string {
  const cleanExt = ext.startsWith('.') ? ext : ext ? `.${ext}` : '';
  const stripped = cleanExt && base.toLowerCase().endsWith(cleanExt.toLowerCase()) ? base.slice(0, -cleanExt.length) : base;
  return `${sanitizeFileName(stripped)}${cleanExt.toLowerCase()}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Returns `dir/name`, or `dir/name 2.ext`, `dir/name 3.ext`… for the first free slot. */
export async function uniquePath(dir: string, name: string, taken: Set<string> = new Set()): Promise<string> {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10_000; i++) {
    const candidate = join(dir, i === 1 ? name : `${stem} ${i}${ext}`);
    if (!taken.has(candidate) && !(await exists(candidate))) return candidate;
  }
  throw new Error(`no free file name for ${name} in ${dir}`);
}
