/**
 * LocalDirSource — snippet-indexes markdown/text docs under a local root.
 *
 * Scan guards (eng review D10 — every one is a hard cap, with a logged skip, never a throw):
 *   - extension allowlist (.md/.mdx/.markdown/.txt)
 *   - per-file size cap (a 400MB log in a configured dir must not blow up the scan)
 *   - per-source file-count cap
 *   - depth cap
 *   - symlink-escape guard (a link pointing outside the root is refused — realpath check)
 *   - skip dirs that are never docs (node_modules, .git, dist, build, …)
 *
 * Snippet extraction: title = first ATX heading (else filename); snippet = first prose paragraph
 * after frontmatter/title, ≤ SNIPPET_MAX chars. mtime-cached per file so unchanged files are
 * never re-read across scans.
 */
import { readdir, stat, realpath, open } from 'fs/promises';
import { join, relative, extname, basename, resolve, sep } from 'path';
import type { DocSnippet, DocSource } from './index.js';

const ALLOWED_EXT = new Set(['.md', '.mdx', '.markdown', '.txt']);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_SOURCE = 200;
const MAX_DEPTH = 4;
const SNIPPET_MAX = 500;
/** Read at most this much of a file when extracting the snippet (caps I/O per file). */
const READ_HEAD_BYTES = 16 * 1024;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  'vendor',
]);

interface CacheEntry {
  mtime: number;
  title: string;
  snippet: string;
}

export interface LocalDirSourceOpts {
  /** Repo mode narrows the scan to docs/** + root-level files — a repo cwd is arbitrary user
   *  code; we only index its documentation surface, not every stray .md in the tree. */
  repoMode?: boolean;
}

export class LocalDirSource implements DocSource {
  readonly id: string;
  private readonly root: string;
  private readonly opts: LocalDirSourceOpts;
  private readonly fileCache = new Map<string, CacheEntry>();
  private realRoot: string | null = null;

  constructor(id: string, root: string, opts: LocalDirSourceOpts) {
    this.id = id;
    this.root = resolve(root);
    this.opts = opts;
  }

  async list(): Promise<DocSnippet[]> {
    try {
      this.realRoot = await realpath(this.root);
    } catch {
      return []; // missing/unreadable root — skip silently (a session cwd may be gone)
    }
    const out: DocSnippet[] = [];
    if (this.opts.repoMode) {
      // Root-level docs only (README.md, DESIGN.md, …) + the docs/ tree.
      await this.walk(this.root, 0, out, /* filesOnlyAtThisLevel */ true);
      await this.walk(join(this.root, 'docs'), 0, out, false);
    } else {
      await this.walk(this.root, 0, out, false);
    }
    return out;
  }

  private async walk(
    dir: string,
    depth: number,
    out: DocSnippet[],
    filesOnly: boolean,
  ): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES_PER_SOURCE) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_SOURCE) {
        console.log(
          `[docsources] ${this.id}: file cap (${MAX_FILES_PER_SOURCE}) hit — rest skipped`,
        );
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!filesOnly && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await this.walk(full, depth + 1, out, false);
        }
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!ALLOWED_EXT.has(extname(entry.name).toLowerCase())) continue;
      const snippet = await this.indexFile(full);
      if (snippet) out.push(snippet);
    }
  }

  private async indexFile(full: string): Promise<DocSnippet | null> {
    let real: string;
    let st;
    try {
      real = await realpath(full);
      // Symlink-escape guard: the resolved file must live under the resolved root.
      if (this.realRoot && !real.startsWith(this.realRoot + sep) && real !== this.realRoot) {
        console.log(`[docsources] ${this.id}: symlink escape refused — ${full}`);
        return null;
      }
      st = await stat(real);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) return null; // oversized — never read

    const mtime = st.mtimeMs;
    const cached = this.fileCache.get(full);
    if (cached && cached.mtime === mtime) {
      return this.toSnippet(full, mtime, cached.title, cached.snippet);
    }

    let head: string;
    try {
      const fh = await open(real, 'r');
      try {
        const buf = Buffer.alloc(Math.min(READ_HEAD_BYTES, st.size));
        await fh.read(buf, 0, buf.length, 0);
        head = buf.toString('utf-8');
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }

    const { title, snippet } = extractTitleAndSnippet(head, basename(full));
    this.fileCache.set(full, { mtime, title, snippet });
    return this.toSnippet(full, mtime, title, snippet);
  }

  private toSnippet(full: string, mtime: number, title: string, snippet: string): DocSnippet {
    return {
      path: relative(this.root, full),
      title,
      snippet,
      mtime,
      source: this.id,
    };
  }
}

/**
 * Title = first ATX heading (else the filename); snippet = the first prose paragraph after
 * frontmatter, the title heading, and blockquote/HTML-comment noise. Exported for unit tests.
 */
export function extractTitleAndSnippet(
  head: string,
  filename: string,
): { title: string; snippet: string } {
  let text = head;
  // Strip YAML frontmatter.
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end >= 0) text = text.slice(end + 4);
  }
  // Strip HTML comments (e.g. "AUTO-GENERATED" banners).
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  const lines = text.split('\n');
  let title = '';
  const paraLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!title && /^#{1,6}\s+/.test(trimmed)) {
      title = trimmed.replace(/^#{1,6}\s+/, '').trim();
      continue;
    }
    if (paraLines.length === 0) {
      // Skip pre-paragraph noise: blanks, further headings, blockquotes, rules, badges/images.
      if (
        !trimmed ||
        /^#{1,6}\s+/.test(trimmed) ||
        trimmed.startsWith('>') ||
        /^[-=*_]{3,}$/.test(trimmed) ||
        trimmed.startsWith('![')
      ) {
        continue;
      }
      paraLines.push(trimmed);
    } else {
      if (!trimmed) break; // paragraph ended
      paraLines.push(trimmed);
    }
  }
  return {
    title: (title || filename).slice(0, 160),
    snippet: paraLines.join(' ').slice(0, SNIPPET_MAX),
  };
}
