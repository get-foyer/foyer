/**
 * Doc discovery — the pluggable DocSource seam (eng review D5).
 *
 * v1 ships LOCAL sources only:
 *   - the session repo's docs (cwd/docs/**, cwd root *.md) — DEFAULT-ON: repo content already
 *     reaches the provider via prompts/transcript tails, so this adds no new egress class.
 *   - user-configured external dirs (FOYER_DOC_DIRS) — EXPLICIT OPT-IN per dir (eng review D20):
 *     configuring a dir is the consent act; snippets from it are sent to the LLM provider.
 *
 * Only SNIPPETS leave the machine: {path, title, first paragraph ≤500 chars}. Full bodies are
 * never read into prompts (eng review D5). MCP-backed SaaS sources (Notion/Linear/Jira/Confluence)
 * are the designed-for follow-up behind this same interface — see TODOS.md.
 */
import { LocalDirSource } from './local.js';
import { cfg } from '../config.js';

/** One indexed doc, snippet-deep. The unit ranking scores and prompts cite. */
export interface DocSnippet {
  /** Display path (relative to the source root). Never an interactive target in v1 (DR14). */
  path: string;
  title: string;
  /** First paragraph after frontmatter/title, hard-capped. The ONLY content that reaches a prompt. */
  snippet: string;
  mtime: number;
  /** Source label ("repo" | external dir basename) — surfaced in the UI egress note. */
  source: string;
}

/** The pluggable seam. v1: LocalDirSource. Follow-up: MCP-backed search sources. */
export interface DocSource {
  readonly id: string;
  /** List the source's indexed snippets (internally mtime-cached + capped). */
  list(): Promise<DocSnippet[]>;
}

/** How long a per-root directory scan is reused before rescanning (file-level mtime caching is
 *  inside LocalDirSource; this TTL only bounds directory re-walks on the summarize tick path). */
const SCAN_TTL_MS = 60_000;

const sources = new Map<string, { source: DocSource; scannedAt: number; cached: DocSnippet[] }>();

function getOrCreate(
  id: string,
  make: () => DocSource,
): {
  source: DocSource;
  scannedAt: number;
  cached: DocSnippet[];
} {
  let e = sources.get(id);
  if (!e) {
    e = { source: make(), scannedAt: 0, cached: [] };
    sources.set(id, e);
  }
  return e;
}

async function listCached(id: string, make: () => DocSource): Promise<DocSnippet[]> {
  const e = getOrCreate(id, make);
  const now = Date.now();
  if (now - e.scannedAt > SCAN_TTL_MS) {
    try {
      e.cached = await e.source.list();
    } catch (err) {
      // A broken source must never break the summarize tick — skip + log, keep the stale cache.
      console.error(
        `[docsources] scan failed for ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
    e.scannedAt = now;
  }
  return e.cached;
}

/**
 * The doc index for a session: repo docs (from the session's cwd, default-on) + every configured
 * external dir (explicit opt-in). Snippet-deep, capped, defensive — see LocalDirSource guards.
 */
export async function getDocIndexForSession(cwd: string | null | undefined): Promise<DocSnippet[]> {
  const out: DocSnippet[] = [];
  if (cwd) {
    out.push(
      ...(await listCached(
        `repo:${cwd}`,
        () => new LocalDirSource('repo', cwd, { repoMode: true }),
      )),
    );
  }
  for (const dir of cfg.docDirs) {
    out.push(...(await listCached(`ext:${dir}`, () => new LocalDirSource(dir, dir, {}))));
  }
  return out;
}

/** Configured doc sources for UI display (id + the per-source egress note, eng review D20). */
export function describeDocSources(cwd: string | null | undefined): { id: string; note: string }[] {
  const out: { id: string; note: string }[] = [];
  if (cwd) out.push({ id: 'repo', note: 'repo docs — snippets sent to the LLM provider' });
  for (const dir of cfg.docDirs) {
    out.push({
      id: dir,
      note: `external dir — snippets from this source are sent to the LLM provider`,
    });
  }
  return out;
}

/** Clear the scan cache. Tests only. */
export function _resetDocSourcesForTest(): void {
  sources.clear();
}
