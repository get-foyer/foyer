/**
 * Background research prefetch — warm the cache before the tap.
 *
 * North star: "the briefing is already there." While the agent works and the user waits, we
 * speculatively run `provider.research()` for the top suggested topics of the VIEWED session
 * and stash the result in a server-only cache — WITHOUT touching `addResearch` or the
 * `inFlightResearch` guard, so the chip stays visible and the result stays hidden until the
 * user actually taps. On tap, `resolveAndStoreResearch` serves the warmed result instantly.
 *
 * Entry lifecycle (one global single-flight loop; at most one speculative research in flight):
 *
 *   schedulePrefetch ─► [queued] ──(loop; yields while summarizing)──► [running] ──ok──► [ready] ──tap/topic-unsuggested──► (evict)
 *                          │                                              │ error/stale-gen
 *                          │ tap (not started)                           └─► resolve(null) ─► (evict) ─► tap runs live
 *                          └── tap ─► drop + resolve(null) ─► tap runs live
 *
 *   A `ready` entry has NO expiry: it lives until the tap consumes it OR its topic leaves the
 *   session's suggested set (churn-prune drops it the moment the chip vanishes). The warmed
 *   briefing is a point-in-time answer, not mutable state, so holding it as long as the chip is
 *   shown keeps the amber "primed" dot honest by construction (the entry ⇔ the chip).
 *   2 consecutive errors ─► stop scheduling this session until a success / new topics
 *   clearPrefetch / supersede ─► bump generation ─► a late result is discarded, never stored/broadcast
 *
 * Design constraints (do not regress):
 *  - NEVER add to `inFlightResearch` (that Set drives chip removal via filterSuggestedTopics).
 *  - NEVER call `addResearch` / broadcast `research_result` from the warm-loop — that is the
 *    TAP's job (resolveAndStoreResearch). The loop only ever broadcasts `research_primed`.
 *  - Import direction stays one-way: prefetch → {state, activity(read-only), providers, sse,
 *    config}. `sse.ts` must NOT import this module (it gets `getPrimedTopics` injected at boot).
 */
import type { ResearchResult as ProviderResearchResult } from './providers/index.js';
import type {
  ResearchResult as StoredResearchResult,
  SuggestedTopic,
  Session,
} from '../src/types.js';
import { getActiveProvider } from './providers/index.js';
import { getSession, isResearchInFlight, addResearch, topicKey } from './state.js';
import { isSummarizing } from './activity.js';
import { broadcast } from './sse.js';
import { cfg } from './config.js';

/** After this many consecutive prefetch failures for a session, stop scheduling it (a down /
 *  misconfigured provider must not re-spawn failing subprocesses every poll). */
const MAX_CONSECUTIVE_FAILURES = 2;
/** Poll cadence for the yield-to-summarizer wait. Backoff, never a tight spin. */
const YIELD_MS = 750;

type EntryStatus = 'queued' | 'running' | 'ready';

interface Entry {
  status: EntryStatus;
  /** Generation the entry was created under; a late result whose gen no longer matches the
   *  session's generation is discarded (handles clear / reopen / supersede). */
  gen: number;
  /** Original topic text (used for the research call and the primed broadcast). */
  topic: string;
  /** Settles with the provider result, or `null` on error / drop / stale. Never rejects. */
  promise: Promise<ProviderResearchResult | null>;
  resolve: (v: ProviderResearchResult | null) => void;
  result?: ProviderResearchResult;
}

// sessionId -> topicKey -> Entry
const cache = new Map<string, Map<string, Entry>>();
// Per-session monotonic generation (bumped on clear).
const generation = new Map<string, number>();
// Per-session consecutive prefetch-failure count (back-off).
const failures = new Map<string, number>();

// Global single-flight: one warm-loop, one speculative research in flight server-wide.
let loopRunning = false;
// The session the loop currently serves (supersession target = the most-recently-viewed tab).
let activePrefetchSessionId: string | null = null;

// Lightweight instrumentation — visibility into speculative spend before trusting default-on.
const counters = { attempted: 0, hit: 0, consumed: 0, wasted: 0 };

function genOf(sessionId: string): number {
  return generation.get(sessionId) ?? 0;
}

function sessionMap(sessionId: string): Map<string, Entry> {
  let m = cache.get(sessionId);
  if (!m) {
    m = new Map();
    cache.set(sessionId, m);
  }
  return m;
}

function logStats(event: string, topic: string): void {
  console.log(
    `[prefetch] ${event} "${topic.slice(0, 48)}" — ` +
      `attempted=${counters.attempted} hit=${counters.hit} consumed=${counters.consumed} wasted=${counters.wasted}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Queue the top-N suggested topics of the viewed session for background warming, and make this
 * session the loop's priority (supersede). Skips topics already cached, already researched, or
 * with a live research in flight. No-op when prefetch is disabled or the session is in back-off.
 */
export function schedulePrefetch(sessionId: string, topics: SuggestedTopic[]): void {
  if (cfg.prefetchTopics <= 0) return;
  if ((failures.get(sessionId) ?? 0) >= MAX_CONSECUTIVE_FAILURES) return;
  const s = getSession(sessionId);
  if (!s) return;

  const m = sessionMap(sessionId);
  const wanted = topics.slice(0, cfg.prefetchTopics);
  // Prune keys off the FULL suggested set (every visible chip), NOT the top-N prefetch budget — so
  // a warmed `ready` entry lives exactly as long as its chip is suggested, keeping the amber dot
  // honest by construction. (`wanted` below still gates what gets newly *queued*, so the top-N
  // speculative-spend bound at queue-time is unchanged.) Mirrors the client's `pruneVanished`.
  const suggestedKeys = new Set(topics.map((t) => topicKey(t.topic)));

  // Churn-prune: drop ready AND queued entries whose topic is no longer suggested (not running).
  for (const [k, e] of m) {
    if (!suggestedKeys.has(k) && e.status !== 'running') {
      if (e.status === 'queued') e.resolve(null);
      m.delete(k);
      counters.wasted++;
    }
  }

  const researched = new Set(s.research.map((r) => topicKey(r.topic)));
  const gen = genOf(sessionId);
  for (const t of wanted) {
    const k = topicKey(t.topic);
    if (m.has(k)) continue; // already cached / queued / running
    if (researched.has(k)) continue;
    if (isResearchInFlight(sessionId, t.topic)) continue; // user is researching this live
    let resolve!: (v: ProviderResearchResult | null) => void;
    const promise = new Promise<ProviderResearchResult | null>((r) => {
      resolve = r;
    });
    m.set(k, { status: 'queued', gen, topic: t.topic, promise, resolve });
  }

  // Supersede: the viewed session is now the loop's priority. Drop OTHER sessions' not-yet-
  // started entries so a tab switch doesn't leave a stale session burning credits.
  activePrefetchSessionId = sessionId;
  for (const [sid, mm] of cache) {
    if (sid === sessionId) continue;
    for (const [k, e] of mm) {
      if (e.status === 'queued') {
        e.resolve(null);
        mm.delete(k);
        counters.wasted++;
      }
    }
  }

  if (!loopRunning) void runLoop();
}

/**
 * Consume a warmed result for a tap. `ready` → instant + evict; `running` → attach (wait only
 * the remainder); `queued` → drop it and return null so the caller runs it live (no waiting
 * behind the speculative loop). miss / errored → null.
 */
export async function takePrefetched(
  sessionId: string,
  topic: string,
): Promise<ProviderResearchResult | null> {
  const m = cache.get(sessionId);
  if (!m) return null;
  const k = topicKey(topic);
  const e = m.get(k);
  if (!e) return null;

  if (e.status === 'ready') {
    m.delete(k);
    if (e.result) {
      counters.hit++;
      counters.consumed++;
      logStats('hit', topic);
      return e.result;
    }
    counters.wasted++; // ready with no result (defensive — runLoop only sets ready WITH a result)
    return null;
  }

  if (e.status === 'running') {
    const v = await e.promise; // already in flight — wait only the remainder
    m.delete(k);
    if (v) {
      counters.consumed++;
      return v;
    }
    return null; // errored → caller runs live
  }

  // queued — not started yet: drop it so the loop skips it; caller runs live now.
  e.resolve(null);
  m.delete(k);
  return null;
}

/** Reset a session's failure back-off. Called by the tap path on success, since prefetch can't
 *  otherwise observe that a live tap succeeded (the provider is evidently working again). */
export function notifyResearchSuccess(sessionId: string): void {
  failures.set(sessionId, 0);
}

/** Drop a session's prefetch cache and bump its generation so any in-flight research for it is
 *  discarded on completion (never stored or broadcast). Called when a session is closed. */
export function clearPrefetch(sessionId: string): void {
  generation.set(sessionId, genOf(sessionId) + 1); // invalidate in-flight results
  const m = cache.get(sessionId);
  if (m) {
    for (const e of m.values()) {
      if (e.status !== 'ready') e.resolve(null);
    }
    cache.delete(sessionId);
  }
  failures.delete(sessionId);
  if (activePrefetchSessionId === sessionId) activePrefetchSessionId = null;
}

/** Currently-`ready` topics for a session (original text). Used by the SSE reconnect replay
 *  (injected into sse.ts, so sse.ts never imports this module). A `ready` entry lives exactly as
 *  long as its topic stays suggested (churn-prune evicts it the moment the chip vanishes), so this
 *  never reports a primed dot the cache can't actually serve. */
export function getPrimedTopics(sessionId: string): string[] {
  const m = cache.get(sessionId);
  if (!m) return [];
  const out: string[] = [];
  for (const e of m.values()) {
    if (e.status === 'ready') out.push(e.topic);
  }
  return out;
}

/** Currently-`running` topics for a session (original text) — the speculative research actually
 *  in flight. Used by the SSE reconnect replay to re-light the warming ring, mirroring
 *  {@link getPrimedTopics} (injected into sse.ts so sse.ts never imports this module). */
export function getWarmingTopics(sessionId: string): string[] {
  const m = cache.get(sessionId);
  if (!m) return [];
  const out: string[] = [];
  for (const e of m.values()) {
    if (e.status === 'running') out.push(e.topic);
  }
  return out;
}

/**
 * The global single-flight warm-loop. Serves the active (viewed) session's queue, one research
 * at a time, yielding while a live summary holds the provider.
 */
async function runLoop(): Promise<void> {
  loopRunning = true;
  try {
    for (;;) {
      const sid = activePrefetchSessionId;
      if (!sid) break;
      const m = cache.get(sid);
      if (!m) break;

      const nextEntry = [...m.entries()].find(([, e]) => e.status === 'queued');
      if (!nextEntry) break;
      const [k, entry] = nextEntry;

      // Yield to the latency-critical live summary: never START a research while summarizing.
      while (isSummarizing(sid)) {
        await sleep(YIELD_MS);
        if (activePrefetchSessionId !== sid) break; // superseded while waiting
      }
      // Re-validate after the (possible) wait: session still active, entry still queued & present.
      if (activePrefetchSessionId !== sid) continue;
      if (m.get(k) !== entry || entry.status !== 'queued') continue;
      if (entry.gen !== genOf(sid)) {
        entry.resolve(null);
        m.delete(k);
        counters.wasted++;
        continue;
      }

      entry.status = 'running';
      // Surface the in-progress warm to the client (the pulsing "warming" ring). Single-flight
      // means at most one topic is `running` server-wide, so this signal stays rare.
      broadcast('research_warming', { sessionId: sid, topic: entry.topic, active: true });
      counters.attempted++;
      const provider = getActiveProvider();
      let result: ProviderResearchResult | null = null;
      try {
        result = provider ? await provider.research(entry.topic) : null;
      } catch {
        result = null; // resolve-to-null: an awaiting tap falls through to a live call
      }

      const current = genOf(sid) === entry.gen && cache.get(sid)?.get(k) === entry;
      if (result && current) {
        entry.status = 'ready';
        entry.result = result;
        entry.resolve(result);
        failures.set(sid, 0);
        broadcast('research_primed', { sessionId: sid, topic: entry.topic });
        logStats('ready', entry.topic);
      } else {
        entry.resolve(result);
        if (cache.get(sid)?.get(k) === entry) m.delete(k);
        if (!result) {
          failures.set(sid, (failures.get(sid) ?? 0) + 1);
        }
        counters.wasted++; // failed, or a stale success we must discard
      }
      // Always end the warming signal when leaving `running` (success OR failure/stale/drop) so
      // the ring can never get stuck lit. On success the client also got `research_primed`; the
      // two touch independent client sets, so order is irrelevant.
      broadcast('research_warming', { sessionId: sid, topic: entry.topic, active: false });
    }
  } finally {
    loopRunning = false;
  }
}

/**
 * Resolve a tapped research request: serve a warmed result if available (instant), else run it
 * live, then store + broadcast exactly as the legacy path did. Extracted from the `/research`
 * route so it is unit-testable without an HTTP harness. Express-pure.
 */
export async function resolveAndStoreResearch(
  session: Session,
  topic: string,
): Promise<ProviderResearchResult> {
  const provider = getActiveProvider();
  if (!provider) throw new Error('No LLM provider configured.');
  const cached = cfg.prefetchTopics > 0 ? await takePrefetched(session.sessionId, topic) : null;
  const result = cached ?? (await provider.research(topic));
  const stored: StoredResearchResult = { ...result, topic, ts: Date.now() };
  addResearch(session.sessionId, stored);
  broadcast('research_result', { sessionId: session.sessionId, ...stored });
  notifyResearchSuccess(session.sessionId);
  return result;
}

/** Snapshot of instrumentation counters (tests + ad-hoc inspection). */
export function getPrefetchStats(): Readonly<typeof counters> {
  return { ...counters };
}

/** Clear ALL module state. Tests only. */
export function _resetPrefetchForTest(): void {
  cache.clear();
  generation.clear();
  failures.clear();
  loopRunning = false;
  activePrefetchSessionId = null;
  counters.attempted = 0;
  counters.hit = 0;
  counters.consumed = 0;
  counters.wasted = 0;
}
