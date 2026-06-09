/**
 * Session persistence — the durable backing for the in-memory session Map.
 *
 * THE STANDARD (read before adding new persisted state):
 *   - `state.ts` keeps the in-memory Map as the SYNCHRONOUS read model. The store is
 *     write-through: mutators mark a session dirty, a debounced flusher calls `save()`.
 *   - Persist the whole `Session` AGGREGATE as one JSON document. The app never queries
 *     across sessions, so normalized tables / event sourcing would be accidental complexity.
 *   - The store API is SYNCHRONOUS (writeFileSync) so `state.ts` never has to go async.
 *   - One file per session: bounded per-flush writes, corruption isolation, prune = unlink.
 *
 *        WRITE                                   READ
 *   save({v, session})                      hydrate()
 *        │                                       │
 *        ▼                                       ▼
 *   <dir>/sessions/<sha256(id)>.json.tmp    read all *.json
 *        │  renameSync (atomic)                  │ normalize() over newSession() defaults
 *        ▼                                       │ demote live→interrupted, reset stale spinner
 *   <dir>/sessions/<sha256(id)>.json        prune (TTL + cap) → startedAt asc
 *
 * Filenames are sha256(sessionId) — session_id is hook input, so a raw `<id>.json` could
 * contain `/` or `..` and escape the sessions dir. The real id lives inside the envelope.
 *
 * Known limitation (documented, not engineered around): `getSession()`/`getAllSessions()`
 * return live mutable refs. A caller that mutates one without going through a `state.ts`
 * mutator won't `markDirty`. Convention: mutate only via mutators; the shutdown flush
 * catches most drift. Freezing/cloning every read would be over-engineering for a
 * single-process local tool.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Session, ResearchResult, ResearchLink, ResearchSection } from '../src/types.js';
import { newSession } from '../src/types.js';

/** Bumped when the persisted shape changes in a way `normalize()` must account for.
 *  v2: research moved from { summary } to { lede, sections[] } — normalizeResearchItem adapts old files. */
export const SESSION_SCHEMA_VERSION = 2;

/** Retention: keep at most this many sessions on disk (most-recently-started win). */
export const MAX_SESSIONS = 50;
/** Retention: prune terminal (done/interrupted) sessions older than this. */
export const DONE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface SessionStore {
  /** Boot: read + normalize + retention-prune every persisted session, sorted by startedAt asc. */
  hydrate(): Session[];
  /** Upsert one aggregate (called by the debounced flusher in state.ts). */
  save(session: Session): void;
  /** Remove a session's file (used when a closed session is hard-deleted, if ever). */
  delete(sessionId: string): void;
  /** Release resources. Flushing is the caller's job (state.ts flushes the dirty set first). */
  close(): void;
}

interface Envelope {
  v: number;
  session: Session;
}

/** No-op store — the default. Unit tests and persistence-disabled boots use it (no disk I/O). */
export function createNoopStore(): SessionStore {
  return {
    hydrate: () => [],
    save: () => {},
    delete: () => {},
    close: () => {},
  };
}

function fileFor(sessionsDir: string, sessionId: string): string {
  const safe = createHash('sha256').update(sessionId).digest('hex');
  return join(sessionsDir, `${safe}.json`);
}

/**
 * Coerce a parsed file into a full Session, merging over newSession() defaults so a session
 * persisted before a field existed (focusHistory, turnSeq, closed) still loads. Tolerates both
 * the enveloped `{v, session}` shape and a bare session object.
 *
 * Recovery normalization (the owning server is gone):
 *   - working/waiting → interrupted (terminal), stamp finishedAt, clear waitingReason.
 *   - a stale `activityStatus: 'generating'` would spin the UI forever → reset to ready/idle.
 */
/**
 * Adapt one persisted research item to the current `{ topic, lede, sections[], links, ts }` shape.
 * Sessions saved before the structured-briefing change carry a flat `summary` string — wrap it as
 * a single section so old briefings still render as a (minimal) doc. Returns null for junk.
 */
export function normalizeResearchItem(raw: unknown): ResearchResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const topic = typeof r.topic === 'string' ? r.topic : '';
  const ts = typeof r.ts === 'number' ? r.ts : Date.now();
  const links = Array.isArray(r.links) ? (r.links as ResearchLink[]) : [];

  if (Array.isArray(r.sections)) {
    return {
      topic,
      lede: typeof r.lede === 'string' ? r.lede : '',
      sections: r.sections as ResearchSection[],
      links,
      ts,
    };
  }
  // Legacy shape: a single `summary` string → one section.
  const summary = typeof r.summary === 'string' ? r.summary : '';
  return { topic, lede: '', sections: [{ heading: topic, body: summary }], links, ts };
}

export function normalizeSession(raw: unknown): Session | null {
  if (!raw || typeof raw !== 'object') return null;
  const env = raw as Partial<Envelope>;
  const s = (env.session ?? raw) as Partial<Session>;
  if (!s || typeof s.sessionId !== 'string' || s.sessionId.length === 0) return null;

  const base = newSession(
    s.sessionId,
    typeof s.prompt === 'string' && s.prompt ? s.prompt : '(no prompt)',
    typeof s.startedAt === 'number' ? s.startedAt : Date.now(),
  );

  const merged: Session = {
    ...base,
    ...s,
    sessionId: s.sessionId,
    prompts: Array.isArray(s.prompts) && s.prompts.length > 0 ? s.prompts : base.prompts,
    turnSeq: typeof s.turnSeq === 'number' ? s.turnSeq : base.turnSeq,
    focusHistory: Array.isArray(s.focusHistory) ? s.focusHistory : base.focusHistory,
    touchPoints: Array.isArray(s.touchPoints) ? s.touchPoints : base.touchPoints,
    research: Array.isArray(s.research)
      ? s.research.map(normalizeResearchItem).filter((r): r is ResearchResult => r !== null)
      : base.research,
    suggestedTopics: Array.isArray(s.suggestedTopics) ? s.suggestedTopics : base.suggestedTopics,
    // Sessions persisted before pinning existed (or with a malformed value) load as unpinned.
    // Guarding here keeps a non-number out of sortPinnedFirst, where `b - a` would yield NaN.
    pinnedAt: typeof s.pinnedAt === 'number' ? s.pinnedAt : null,
  };

  if (merged.status === 'working' || merged.status === 'waiting') {
    merged.status = 'interrupted';
    merged.waitingReason = null;
    if (merged.finishedAt == null) merged.finishedAt = Date.now();
  }
  if (merged.activityStatus === 'generating') {
    merged.activityStatus = merged.summary ? 'ready' : 'idle';
  }
  return merged;
}

/** Retention: drop expired terminal sessions, then cap total at MAX_SESSIONS (newest kept). */
export function applyRetention(sessions: Session[], now: number): Session[] {
  let kept = sessions.filter((s) => {
    const terminal = s.status === 'done' || s.status === 'interrupted';
    if (!terminal) return true;
    return now - (s.finishedAt ?? s.startedAt) <= DONE_TTL_MS;
  });
  if (kept.length > MAX_SESSIONS) {
    // Pinned sessions are user-retained — exempt them from the newest-N cap so a pin survives
    // restart (ADR 0004), then fill the remaining slots with the newest unpinned sessions.
    const pinned = kept.filter((s) => s.pinnedAt != null);
    const rest = kept
      .filter((s) => s.pinnedAt == null)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(0, MAX_SESSIONS - pinned.length));
    kept = [...pinned, ...rest];
  }
  return kept;
}

export function createJsonStore(dir: string): SessionStore {
  const sessionsDir = join(dir, 'sessions');
  try {
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // Data dir not writable — fall back to in-memory only so the tool still runs.
    console.warn(
      `[store] data dir not writable (${dir}); running in-memory only:`,
      err instanceof Error ? err.message : err,
    );
    return createNoopStore();
  }

  return {
    hydrate(): Session[] {
      let files: string[];
      try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      } catch {
        return [];
      }
      const loaded: Session[] = [];
      for (const f of files) {
        const full = join(sessionsDir, f);
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8'));
          const s = normalizeSession(parsed);
          if (s) loaded.push(s);
          else console.warn(`[store] skipping unparseable session file: ${f}`);
        } catch (err) {
          console.warn(
            `[store] skipping corrupt session file ${f}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      const kept = applyRetention(loaded, Date.now());
      const keptIds = new Set(kept.map((s) => s.sessionId));
      for (const s of loaded) {
        if (!keptIds.has(s.sessionId)) this.delete(s.sessionId);
      }
      return kept.sort((a, b) => a.startedAt - b.startedAt);
    },

    save(session: Session): void {
      const env: Envelope = { v: SESSION_SCHEMA_VERSION, session };
      const target = fileFor(sessionsDir, session.sessionId);
      const tmp = `${target}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
        renameSync(tmp, target); // atomic on POSIX — readers never see a partial file
      } catch (err) {
        console.warn(
          `[store] failed to persist ${session.sessionId}:`,
          err instanceof Error ? err.message : err,
        );
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
          /* best effort */
        }
      }
    },

    delete(sessionId: string): void {
      try {
        unlinkSync(fileFor(sessionsDir, sessionId));
      } catch {
        /* already gone */
      }
    },

    close(): void {
      // Each save() is an immediate synchronous write; there are no buffered handles.
      // state.ts flushes its dirty set before calling this, so there's nothing to release.
    },
  };
}
