import type {
  Session,
  ResearchResult,
  SuggestedTopic,
  FocusEntry,
  DocRef,
  PrimaryBriefing,
} from '../src/types.js';
import { newSession, MAX_FOCUS, sortPinnedFirst, topicKey } from '../src/types.js';
import { normalizeWhitespace } from './providers/text.js';
import { createNoopStore, DONE_TTL_MS, MAX_SESSIONS, type SessionStore } from './store.js';

export type { Session };

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;

// ---------------------------------------------------------------------------
// Persistence (write-through to a SessionStore)
//
// The Map above stays the synchronous read model. Mutators mark a session dirty;
// a debounced flusher writes it through to the store. Lifecycle transitions
// (finish / waiting / close) flush immediately so terminal state survives a crash.
// Default store is a no-op (unit tests + persistence-disabled boots); server/index.ts
// swaps in the JSON store via initPersistence().
// ---------------------------------------------------------------------------
let store: SessionStore = createNoopStore();
const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 1500;

/** Install the durable store (called once from server boot). */
export function initPersistence(s: SessionStore): void {
  store = s;
}

/** Load persisted sessions into the Map (boot). `loaded` is already startedAt-sorted, so
 *  Map insertion order — and therefore getAllSessions() order — matches. activeSessionId
 *  stays null; the client's snapshot picks the most recent tab. */
export function hydrateSessions(loaded: Session[]): void {
  for (const s of loaded) sessions.set(s.sessionId, s);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDirty();
  }, FLUSH_DEBOUNCE_MS);
  // Never let the flush timer keep the process alive on its own.
  flushTimer.unref?.();
}

function markDirty(sessionId: string): void {
  dirty.add(sessionId);
  scheduleFlush();
}

function flushDirty(): void {
  for (const id of dirty) {
    const s = sessions.get(id);
    if (s) store.save(s);
  }
  dirty.clear();
}

/** Persist one session right now (lifecycle transitions that must survive an immediate crash). */
function flushNow(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) store.save(s);
  dirty.delete(sessionId);
}

/** Flush every pending session synchronously. Called from the shutdown handler. */
export function flushAll(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushDirty();
}

// ---------------------------------------------------------------------------
// In-flight research guard
//
// Tracks which research topics have a /research call in flight, per session.
// Server-only and ephemeral — deliberately NOT on the Session object, so it
// never serializes to the client or (PR2) to disk.
//
// Why it exists: a chip click runs research for 5-30s. An activity tick during
// that window calls setActivity, which would otherwise re-surface the clicked
// topic (it's not in session.research yet) — letting a second click or a second
// client re-research it. setActivity excludes in-flight topics; /research
// no-ops if a topic is already in flight.
//
//   click ──► addResearchInFlight ──► research() ──► addResearch (removes chip)
//                    │                                    └─► removeResearchInFlight
//                    └─► setActivity filters it out while present
// ---------------------------------------------------------------------------
const inFlightResearch = new Map<string, Set<string>>();

// Canonical topic identity now lives in src/types.ts (shared with the pure ranking module and
// the client). Re-exported here so existing server imports keep working.
export { topicKey };

export function addResearchInFlight(sessionId: string, topic: string): void {
  let set = inFlightResearch.get(sessionId);
  if (!set) {
    set = new Set();
    inFlightResearch.set(sessionId, set);
  }
  set.add(topicKey(topic));
}

export function removeResearchInFlight(sessionId: string, topic: string): void {
  inFlightResearch.get(sessionId)?.delete(topicKey(topic));
}

export function isResearchInFlight(sessionId: string, topic: string): boolean {
  return inFlightResearch.get(sessionId)?.has(topicKey(topic)) ?? false;
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

export function getActiveSession(): Session | null {
  return activeSessionId ? (sessions.get(activeSessionId) ?? null) : null;
}

export function getSession(id: string): Session | null {
  return sessions.get(id) ?? null;
}

/** Returns all visible sessions — working/done/interrupted — pinned first (most-recently-pinned
 *  first), then unpinned in insertion (start) order. Closed sessions are filtered out (they stay
 *  on disk + in the Map but are hidden from the UI). The Map yields insertion order, which
 *  sortPinnedFirst preserves as the unpinned tiebreak. */
export function getAllSessions(): Session[] {
  return sortPinnedFirst([...sessions.values()].filter((s) => !s.closed));
}

function pruneLiveSessions(now: number = Date.now()): void {
  const candidates = [...sessions.values()];
  if (candidates.length <= MAX_SESSIONS) {
    for (const s of candidates) {
      const terminal = s.status === 'done' || s.status === 'interrupted';
      if (terminal && now - (s.finishedAt ?? s.startedAt) > DONE_TTL_MS) {
        dropSessionFromMemory(s.sessionId);
      }
    }
    return;
  }

  const eligible = candidates.filter((s) => {
    const terminal = s.status === 'done' || s.status === 'interrupted';
    return !terminal || now - (s.finishedAt ?? s.startedAt) <= DONE_TTL_MS;
  });
  const keep = new Set<string>();

  for (const s of eligible) {
    const live = s.status === 'working' || s.status === 'waiting';
    const activeVisible = !s.closed && s.sessionId === activeSessionId;
    // A pin is an explicit "keep this" from the user — never evict a pinned session from the live
    // window when over MAX_SESSIONS, or the pin would silently vanish from the sidebar.
    if (live || activeVisible || s.pinnedAt != null) keep.add(s.sessionId);
  }
  for (const s of [...eligible].sort((a, b) => b.startedAt - a.startedAt)) {
    if (keep.size >= MAX_SESSIONS) break;
    keep.add(s.sessionId);
  }

  for (const s of candidates) {
    if (!keep.has(s.sessionId)) dropSessionFromMemory(s.sessionId);
  }
}

function dropSessionFromMemory(sessionId: string): void {
  sessions.delete(sessionId);
  dirty.delete(sessionId);
  inFlightResearch.delete(sessionId);
  sessionDropListener?.(sessionId);
  if (activeSessionId === sessionId) {
    const visible = [...sessions.values()].filter((s) => !s.closed);
    activeSessionId = visible.length > 0 ? visible[visible.length - 1].sessionId : null;
  }
}

/**
 * Resolves the target session for a research request.
 * If a sessionId is provided and known, use that; otherwise fall back to the active session.
 * This seam lets the /research route target the session the user is *viewing*, not the last-started one.
 */
export function resolveResearchSession(sessionId: string | null | undefined): Session | null {
  return (sessionId ? getSession(sessionId) : null) ?? getActiveSession();
}

/** Clears all state. Call only from test files (`beforeEach`). */
export function _resetStateForTest(): void {
  sessions.clear();
  inFlightResearch.clear();
  activeSessionId = null;
  dirty.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  store = createNoopStore();
  sessionEndListener = null;
  sessionDropListener = null;
}

/** Max prompts retained per session. Beyond this, the goal (prompts[0]) and the most
 *  recent entries are kept; the oldest middle turns are dropped. */
const MAX_PROMPTS = 100;

/**
 * Start a NEW session, or CONTINUE an existing one (same Claude Code session_id, next turn).
 *
 * Claude Code reuses one stable session_id across every turn of a session, so a follow-up
 * prompt must NOT wipe the card. On continue we reopen to `working` and preserve the
 * accumulated `summary`/`research`/`startedAt`, appending the new
 * prompt to the `prompts` arc (the goal stays at `prompts[0]`, the latest is `prompt`).
 *
 * Returns `continued: true` when an existing session was extended — the caller uses this
 * (not a `prompts.length` proxy) to force a fresh summary after the reopen.
 */
export function startSession(
  sessionId: string,
  prompt: string,
): { session: Session; continued: boolean } {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.status = 'working';
    existing.waitingReason = null;
    existing.finishedAt = null;
    // Skip the push on duplicate UserPromptSubmit delivery (same text as the last turn).
    if (existing.prompts.at(-1) !== prompt) {
      existing.prompts.push(prompt);
      existing.turnSeq += 1; // new turn — bump the monotonic counter focus entries are stamped with
      if (existing.prompts.length > MAX_PROMPTS) {
        // Keep the goal (index 0) + the most recent MAX_PROMPTS-1 turns.
        existing.prompts = [
          existing.prompts[0],
          ...existing.prompts.slice(existing.prompts.length - (MAX_PROMPTS - 1)),
        ];
      }
    }
    existing.prompt = existing.prompts.at(-1) ?? prompt; // latest = current focus
    activeSessionId = sessionId;
    // Re-open a dismissed session: a fresh prompt un-closes the tab so server + client agree
    // (otherwise the client re-adds it via `task` while snapshots keep hiding it — split-brain).
    // Flip + flushNow ONLY on the closed→open transition; the common continue path stays on the
    // debounced markDirty below (no write amplification on the hot path).
    if (existing.closed) {
      existing.closed = false;
      flushNow(sessionId); // lifecycle transition — persist immediately
    }
    markDirty(sessionId);
    pruneLiveSessions();
    return { session: existing, continued: true };
  }
  const session = newSession(sessionId, prompt, Date.now());
  sessions.set(sessionId, session);
  activeSessionId = sessionId;
  markDirty(sessionId);
  pruneLiveSessions();
  return { session, continued: false };
}

// ---------------------------------------------------------------------------
// Activity state — live summary produced by summarizeActivity()
// ---------------------------------------------------------------------------

export function setActivityGenerating(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.activityStatus = 'generating';
  return true;
}

/**
 * Records a fresh activity summary. Returns the FocusEntry it appended to `focusHistory`,
 * or `null` if nothing was appended (unknown session, or the summary was a non-meaningful
 * repeat). Either way the live `summary`/`suggestedTopics` are refreshed.
 *
 * Append gate (two layers, both must pass):
 *   1. `allowAppend` — the caller (activity.ts) only sets this when real progress happened
 *      (the transcript grew since the last entry). Kills the no-transcript
 *      30s-poll flood where the LLM re-narrates the same state.
 *   2. content change — normalizeWhitespace(new) differs from the last entry, so casing /
 *      spacing / line-wrap variants of the same narration don't add a row.
 *
 * Turn identity (`turnSeq`/`turnPrompt`) is supplied by the caller, captured BEFORE the LLM
 * await, so a summary that finishes after a new prompt arrives is still filed under the turn
 * it was actually about.
 */
export function setActivity(
  sessionId: string,
  update: {
    summary: string;
    topics: SuggestedTopic[];
    turnSeq: number;
    turnPrompt: string;
    allowAppend: boolean;
    /** Touched-areas snapshot taken at this tick — this write IS the touched-areas flush
     *  (eng review D14: persistence rides the tick, never per tool call). */
    touchedAreas?: string[];
    /** Top doc matches for the extractive strip readout (capped at the call site). */
    contextDocs?: DocRef[];
  },
): FocusEntry | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (update.touchedAreas) s.touchedAreas = update.touchedAreas;
  if (update.contextDocs) s.contextDocs = update.contextDocs;

  const last = s.focusHistory[0];
  const isNew =
    update.allowAppend &&
    (!last || normalizeWhitespace(last.summary) !== normalizeWhitespace(update.summary));
  let entry: FocusEntry | null = null;
  if (isNew) {
    const ts = Date.now();
    entry = {
      id: `${sessionId}-${ts}`,
      summary: update.summary,
      ts,
      turnSeq: update.turnSeq,
      turnPrompt: update.turnPrompt,
    };
    s.focusHistory.unshift(entry); // newest first
    if (s.focusHistory.length > MAX_FOCUS) s.focusHistory.length = MAX_FOCUS;
  }

  s.summary = update.summary;
  s.suggestedTopics = filterSuggestedTopics(s, update.topics);
  s.activityStatus = 'ready';
  s.activityError = null;
  markDirty(sessionId);
  return entry;
}

/**
 * Drop topics the user has already researched, has a research call in flight for, or has
 * DISMISSED via the primary strip's "not useful" (eng review D18) — so a chip can't reappear
 * between the click and the result landing, and a rejected topic stays gone (case-insensitive).
 */
function filterSuggestedTopics(s: Session, topics: SuggestedTopic[]): SuggestedTopic[] {
  const researched = new Set(s.research.map((r) => topicKey(r.topic)));
  const dismissed = new Set(s.dismissedTopics ?? []);
  const inFlight = inFlightResearch.get(s.sessionId);
  return topics.filter((t) => {
    const k = topicKey(t.topic);
    return !researched.has(k) && !dismissed.has(k) && !(inFlight?.has(k) ?? false);
  });
}

export function setActivityError(sessionId: string, error: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.activityStatus = 'error';
  s.activityError = error;
  markDirty(sessionId);
  return true;
}

export function setWaiting(sessionId: string, reason: string | null): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.status === 'done' || s.status === 'interrupted') return true;
  s.status = 'waiting';
  s.waitingReason = reason;
  flushNow(sessionId); // lifecycle transition — persist immediately
  return true;
}

/** Clears 'waiting' back to 'working'. No-op if session is already working or done. */
export function clearWaiting(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.status === 'waiting') {
    s.status = 'working';
    s.waitingReason = null;
    markDirty(sessionId);
  }
  return true;
}

/**
 * Marks a known session as actively working again without starting a new turn.
 *
 * This is used when lifecycle inference got ahead of the agent (for example a
 * Stop/auto-close reached us before later tool hooks for the same live turn).
 * Unlike startSession(), this preserves the existing prompt arc and focus state.
 */
export function markWorking(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.status !== 'working' || s.waitingReason !== null || s.finishedAt !== null) {
    s.status = 'working';
    s.waitingReason = null;
    s.finishedAt = null;
    markDirty(sessionId);
  }
  return true;
}

/** Invoked when a session reaches a terminal state (done), so server-only side caches —
 *  research prefetch today — can free per-session state. Injected at boot to keep state.ts
 *  dependency-free: the import direction stays one-way (prefetch → state, never the reverse),
 *  so this is a function pointer, not an import. */
let sessionEndListener: ((sessionId: string) => void) | null = null;
export function setSessionEndListener(cb: ((sessionId: string) => void) | null): void {
  sessionEndListener = cb;
}

/** Invoked when a session is removed from the live in-memory window, so side modules with
 * long-lived per-session metadata can forget it too. */
let sessionDropListener: ((sessionId: string) => void) | null = null;
export function setSessionDropListener(cb: ((sessionId: string) => void) | null): void {
  sessionDropListener = cb;
}

export function finishSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.status = 'done';
  s.waitingReason = null;
  s.finishedAt = Date.now();
  flushNow(sessionId); // lifecycle transition — persist immediately
  // Free server-only side caches (prefetch). Without this the prefetch cache was freed only
  // on explicit /close, so done/stale/turn-end sessions leaked warmed entries for the life of
  // the daemon. A reopen (new prompt) re-warms via the /activity poll.
  sessionEndListener?.(sessionId);
  pruneLiveSessions();
  return true;
}

/** Marks a session closed (user dismissed the tab). Persisted so it stays hidden across
 *  restarts; the snapshot filters closed sessions out. Data is kept on disk, not deleted. */
export function closeSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.closed = true;
  flushNow(sessionId);
  return true;
}

/** Pin a session to the top of the sidebar (stamps pinnedAt = now). Sort is most-recent-pin-first,
 *  so re-pinning lifts a session above earlier pins. Lifecycle-ish state → flush immediately,
 *  mirroring closeSession. Returns false for unknown ids (idempotent caller side). */
export function pinSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.pinnedAt = Date.now();
  flushNow(sessionId);
  return true;
}

/** Unpin a session (clears pinnedAt → falls back to insertion order among unpinned). */
export function unpinSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.pinnedAt = null;
  flushNow(sessionId);
  return true;
}

/** Mark a research briefing as read (stamps readAt = now, once). Called when the user opens a
 *  briefing in the Research tab. User-intent state → flush immediately, matching pinSession so
 *  "read" survives a hard crash and amber doesn't re-light on restart. Idempotent: a second open
 *  leaves the original readAt untouched. Returns false for unknown session or ts. */
export function markResearchRead(sessionId: string, ts: number): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  const r = s.research.find((x) => x.ts === ts);
  if (!r) return false;
  if (r.readAt == null) {
    r.readAt = Date.now();
    // One read-state app-wide (eng review D8 / design DR10): opening the PRIMARY's briefing in
    // the Research tab is what flips the strip ready → read. Same write, same flush.
    if (s.primary?.status === 'ready' && topicKey(s.primary.topic) === topicKey(r.topic)) {
      s.primary = { ...s.primary, status: 'read', since: Date.now() };
    }
    flushNow(sessionId);
  }
  return true;
}

export function addResearch(sessionId: string, result: ResearchResult): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.research.unshift(result); // newest first
  // The topic is now researched: clear it from the in-flight guard and drop its chip
  // so the source-of-truth state (and reconnect snapshot) stays correct.
  removeResearchInFlight(sessionId, result.topic);
  const k = topicKey(result.topic);
  s.suggestedTopics = s.suggestedTopics.filter((t) => topicKey(t.topic) !== k);
  markDirty(sessionId);
  return true;
}

/** Record the session's working directory from hook payloads (grounds the repo doc scan and
 *  touched-area aggregation). First non-empty value wins; later hooks won't churn it. */
export function recordSessionCwd(sessionId: string, cwd: string | undefined): void {
  if (!cwd) return;
  const s = sessions.get(sessionId);
  if (!s || s.cwd) return;
  s.cwd = cwd;
  markDirty(sessionId);
}

// ---------------------------------------------------------------------------
// Primary briefing — designation lifecycle (Live Learning Briefing)
//
// The designation is a POINTER over existing structures (eng review D8): the briefing body
// lives in `research[]`, read-state is the shared `readAt`. These mutators only move the
// pointer through its state machine (see PrimaryBriefing in src/types.ts for the diagram).
// Scheduling (warming) lives in prefetch.ts; deciding (ranking) lives in ranking.ts.
// ---------------------------------------------------------------------------

/**
 * Designate a topic as the session's primary (status: warming). A read predecessor demotes to
 * its read row (design review DR7 — it is already in `research[]`, nothing else to do); a
 * ready-unread predecessor stays as an unread row (superseded); a warming predecessor is simply
 * replaced (its in-flight warm is discarded by the scheduler's designation check).
 */
export function designatePrimary(
  sessionId: string,
  pick: { topic: string; reason: string; docs?: DocRef[] },
): PrimaryBriefing | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if ((s.dismissedTopics ?? []).includes(topicKey(pick.topic))) return null;
  // If this topic's briefing already exists (e.g. the user researched it via a chip earlier),
  // the designation is born ready — no warm needed, the body is already in research[].
  const existing = s.research.find((r) => topicKey(r.topic) === topicKey(pick.topic));
  const now = Date.now();
  s.primary = {
    topic: pick.topic,
    reason: pick.reason,
    status: existing ? (existing.readAt != null ? 'read' : 'ready') : 'warming',
    since: now,
    readyMs: existing ? 0 : null,
    failures: 0,
    docs: pick.docs?.slice(0, 3),
  };
  markDirty(sessionId);
  return s.primary;
}

/** Flip the primary to ready (its briefing just landed in research[]). `readyMs` is the frozen
 *  queued→ready duration — the D17 time-to-ready metric, shown on the strip (DR11). */
export function setPrimaryReady(sessionId: string, topic: string, readyMs: number): boolean {
  const s = sessions.get(sessionId);
  if (!s?.primary || topicKey(s.primary.topic) !== topicKey(topic)) return false;
  if (s.primary.status !== 'warming') return false;
  s.primary = { ...s.primary, status: 'ready', since: Date.now(), readyMs, failures: 0 };
  flushNow(sessionId); // user-visible signal state — survive a crash, like readAt/pinnedAt
  return true;
}

/** Record a warm failure; flips to the error state at `maxFailures` (back-off, eng review D7). */
export function recordPrimaryFailure(sessionId: string, topic: string, maxFailures = 2): boolean {
  const s = sessions.get(sessionId);
  if (!s?.primary || topicKey(s.primary.topic) !== topicKey(topic)) return false;
  const failures = (s.primary.failures ?? 0) + 1;
  s.primary = {
    ...s.primary,
    failures,
    ...(failures >= maxFailures ? { status: 'error' as const, since: Date.now() } : {}),
  };
  markDirty(sessionId);
  return s.primary.status === 'error';
}

/** Manual retry from the strip's error readout: error → warming, failure count reset. */
export function retryPrimary(sessionId: string): PrimaryBriefing | null {
  const s = sessions.get(sessionId);
  if (!s?.primary || s.primary.status !== 'error') return null;
  s.primary = { ...s.primary, status: 'warming', since: Date.now(), failures: 0 };
  markDirty(sessionId);
  return s.primary;
}

/**
 * Dismiss the primary ("NOT USEFUL", eng review D18 / design DR8). Commits the exclusion:
 * the topicKey joins dismissedTopics (never suggested or designated again this session), its
 * unread briefing (if any) is marked read so it falls to the read rows, and the designation
 * clears. Returns the dismissed designation for logging, or null if there was none.
 * The 5s undo window is CLIENT-held — by the time this runs, the dismissal is final
 * (only committed dismissals are logged).
 */
export function dismissPrimary(sessionId: string): PrimaryBriefing | null {
  const s = sessions.get(sessionId);
  if (!s?.primary) return null;
  const dismissed = s.primary;
  const k = topicKey(dismissed.topic);
  s.dismissedTopics = [...(s.dismissedTopics ?? []), k];
  s.suggestedTopics = s.suggestedTopics.filter((t) => topicKey(t.topic) !== k);
  const r = s.research.find((x) => topicKey(x.topic) === k);
  if (r && r.readAt == null) r.readAt = Date.now();
  s.primary = null;
  flushNow(sessionId); // user-intent state — survive a crash
  return dismissed;
}

/** Demote a READ primary when the next pick arrives (design review DR7 — read is not terminal;
 *  the briefing already lives in the read rows, so this only clears the pointer). */
export function clearPrimary(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s?.primary) return false;
  s.primary = null;
  markDirty(sessionId);
  return true;
}
