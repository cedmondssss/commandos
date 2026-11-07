import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PathArg } from './fs';
import { displayPath, resolveUserPath } from './paths';
import { defineTool, type ToolContext, ToolError } from './types';

const execFileP = promisify(execFile);

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml', '.xml', '.ts', '.tsx', '.js', '.jsx', '.py', '.swift', '.go', '.rs', '.java', '.rb', '.sh', '.toml', '.ini', '.env.example', '.css', '.sql']);
const TEXTUTIL_EXT = new Set(['.rtf', '.rtfd', '.doc', '.html', '.htm', '.webarchive', '.odt', '.wordml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.heic', '.tiff', '.gif', '.webp']);

type Kind = 'text' | 'pdf' | 'docx' | 'rich' | 'image';

async function extract(path: string, ctx: ToolContext): Promise<{ kind: Kind; text: string; pages?: number }> {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext) || ext === '') return { kind: 'text', text: await readFile(path, 'utf8') };
  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return { kind: 'pdf', text: Array.isArray(text) ? text.join('\n') : text, pages: totalPages };
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ path });
    return { kind: 'docx', text: r.value };
  }
  if (TEXTUTIL_EXT.has(ext)) {
    const { stdout } = await execFileP('/usr/bin/textutil', ['-convert', 'txt', '-stdout', path], { maxBuffer: 20 * 1024 * 1024 });
    return { kind: 'rich', text: stdout };
  }
  if (IMAGE_EXT.has(ext)) {
    const r = await ctx.helper.call('vision.ocr', { path, level: 'accurate' }, { signal: ctx.signal, timeoutMs: 60_000 });
    return { kind: 'image', text: r.text };
  }
  throw new ToolError('unsupported', `cannot extract text from ${ext} files`);
}

export const docsExtract = defineTool({
  id: 'docs.extract',
  title: 'Extract document text',
  description:
    'Extract plain text from documents on this Mac: txt/md/csv/json/code, PDF (unpdf), Word .docx (mammoth), rtf/doc/html (textutil) and images (on-device OCR). Nothing leaves the machine.',
  tier: 1,
  args: z.object({ paths: z.array(PathArg).min(1).max(50), maxCharsPerFile: z.number().int().min(100).max(500_000).default(20_000) }),
  output: z.object({
    documents: z.array(
      z.object({
        path: z.string(),
        kind: z.string(),
        text: z.string(),
        chars: z.number().int(),
        truncated: z.boolean(),
        pages: z.number().int().nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
  effectClass: 'read',
  effects: ['fs_read'],
  risk: 'none',
  idempotent: true,
  defaultTimeoutMs: 120_000,
  paths: (a) => ({ read: a.paths, write: [] }),
  async run(a, ctx) {
    const documents = [];
    for (const raw of a.paths) {
      const path = resolveUserPath(raw);
      try {
        const s = await stat(path);
        if (s.size > 200 * 1024 * 1024) throw new ToolError('too_large', 'file larger than 200 MB');
        const r = await extract(path, ctx);
        documents.push({
          path,
          kind: r.kind,
          text: r.text.slice(0, a.maxCharsPerFile),
          chars: r.text.length,
          truncated: r.text.length > a.maxCharsPerFile,
          pages: r.pages ?? null,
          error: null,
        });
        ctx.progress(`Extracted ${r.text.length} chars from ${displayPath(path)}`);
      } catch (e) {
        documents.push({ path, kind: 'unknown', text: '', chars: 0, truncated: false, pages: null, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (documents.every((d) => d.error)) throw new ToolError('extract_failed', documents[0]?.error ?? 'nothing extracted');
    return { documents };
  },
  summarize: (o) => ({
    documents: o.documents.map((d) => ({ path: displayPath(d.path), kind: d.kind, chars: d.chars, error: d.error, preview: d.text.slice(0, 1200) })),
  }),
});

export const docTools = [docsExtract];
