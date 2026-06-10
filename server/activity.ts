/**
 * Live activity orchestration.
 *
 * Owns all summariseActivity() scheduling and the cost guards:
 *   - Single-flight per session (at most one LLM call in-flight at a time)
 *   - Trailing debounce on touch events (coalesces edit storms)
 *   - Skip-if-unchanged: if transcript byte size hasn't grown since the last
 *     run, no LLM call is made — an idle browser poll costs nothing
 *   - Rerun-on-growth: if transcript grew while a call was in-flight, one
 *     follow-up run fires immediately after the in-flight call resolves
 *
 * Triggered four ways:
 *   1. scheduleSummarize(sessionId)  — from PostToolUse (debounced, any session)
 *   2. summarizeNow(sessionId)       — from Stop and POST /activity (no debounce)
 *   3. POST /activity {sessionId}    — client poll for the viewed session (30s)
 *   4. startLiveSummaryPoll()        — server-side 5s poll over ALL working sessions;
 *      re-summarises on transcript growth. The primary path for assistant-text-only turns:
 *      Claude Code fires no hook when the agent emits text without a tool call, so without
 *      this the Current Focus panel freezes until the next tool hook or the viewed-tab poll.
 */
import { watch } from 'fs';
import type { FSWatcher } from 'fs';
import { getSession, finishSession, markWorking } from './state.js';
import { setActivityGenerating, setActivity, setActivityError } from './state.js';
import { broadcast } from './sse.js';
import {
  readTranscriptTail,
  getTranscriptSize,
  getTranscriptMtime,
  readTranscriptFrom,
} from './transcript.js';
import { getActiveProvider } from './providers/index.js';
import type { ActivityContext } from './providers/index.js';

/** Trailing debounce for touch-triggered summarisation. */
const TOUCH_DEBOUNCE_MS = 8_000;

interface SessionMeta {
  transcriptPath: string | null;
  lastSummarizedSize: number | null;
  inFlight: boolean;
  rerunRequested: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  // Transcript turn-end watcher — detects ESC interrupts via fs.watch
  transcriptWatcher: FSWatcher | null;
  lastWatchedOffset: number;
  seenAssistantInTurn: boolean;
  /** Transcript size when the session entered `waiting`. Growth past this means the agent
   *  resumed — load-bearing for text-only resumes (e.g. a denied permission answered with
   *  prose), which fire NO tool hook, so nothing else would ever clear the wait. */
  waitingSize: number | null;
}

const meta = new Map<string, SessionMeta>();

function getMeta(sessionId: string): SessionMeta {
  let m = meta.get(sessionId);
  if (!m) {
    m = {
      transcriptPath: null,
      lastSummarizedSize: null,
      inFlight: false,
      rerunRequested: false,
      debounceTimer: null,
      transcriptWatcher: null,
      lastWatchedOffset: 0,
      seenAssistantInTurn: false,
      waitingSize: null,
    };
    meta.set(sessionId, m);
  }
  return m;
}

/**
 * Stamp the transcript size at the moment a session enters `waiting`. The live size-poll
 * compares against this baseline: growth means the agent resumed (the text-only resume path
 * fires no tool hook, so this is the ONLY signal that clears such a wait). Fire-and-forget
 * from the Notification hook; a missing transcript leaves the baseline null (undetectable —
 * the wait then clears via the usual hook paths).
 */
export async function recordWaitingBaseline(sessionId: string): Promise<void> {
  const m = getMeta(sessionId);
  if (!m.transcriptPath) return;
  m.waitingSize = await getTranscriptSize(m.transcriptPath);
}

/**
 * Whether a summarisation LLM call is currently in flight for a session. Read-only; the
 * prefetch worker uses this to YIELD — it won't start a speculative research while the live
 * activity summary (the latency-critical primary signal) is holding the provider.
 */
export function isSummarizing(sessionId: string): boolean {
  return meta.get(sessionId)?.inFlight ?? false;
}

/** Record the transcript path from hook payloads and start watching for turn completion. */
export function recordTranscriptPath(sessionId: string, path: string | undefined): void {
  if (!path) return;
  const m = getMeta(sessionId);
  m.transcriptPath = path;
  void startTranscriptTurnWatcher(sessionId, path);
}

/**
 * Schedule a summarisation after TOUCH_DEBOUNCE_MS.
 * Resets the timer if called again before it fires (trailing debounce).
 */
export function scheduleSummarize(sessionId: string): void {
  const m = getMeta(sessionId);
  if (m.debounceTimer !== null) {
    clearTimeout(m.debounceTimer);
  }
  m.debounceTimer = setTimeout(() => {
    m.debounceTimer = null;
    void run(sessionId);
  }, TOUCH_DEBOUNCE_MS);
}

/**
 * Trigger summarisation immediately, bypassing the debounce.
 * Used by the Stop handler and the POST /activity route (viewed-session poll).
 */
export function summarizeNow(sessionId: string): void {
  const m = getMeta(sessionId);
  // Cancel any pending debounce — this run supersedes it
  if (m.debounceTimer !== null) {
    clearTimeout(m.debounceTimer);
    m.debounceTimer = null;
  }
  void run(sessionId);
}

/**
 * Force the next run() to summarise even if the transcript byte size is unchanged.
 *
 * Called when a session is reopened by a follow-up prompt: the new prompt may not have
 * grown the transcript yet, so without this the skip-if-unchanged guard could suppress
 * the summary that should reflect the new focus.
 */
export function resetSummarizeBaseline(sessionId: string): void {
  const m = meta.get(sessionId);
  if (m) m.lastSummarizedSize = null;
}

/** Stop the transcript watcher for a session (called when Stop hook fires to clean up). */
export function stopTranscriptWatcher(sessionId: string): void {
  const m = meta.get(sessionId);
  if (!m?.transcriptWatcher) return;
  m.transcriptWatcher.close();
  m.transcriptWatcher = null;
}

/** Drop all scheduler/watch state for a session that left the live in-memory window. */
export function forgetActivitySession(sessionId: string): void {
  const m = meta.get(sessionId);
  if (!m) return;
  if (m.debounceTimer !== null) clearTimeout(m.debounceTimer);
  if (m.transcriptWatcher !== null) m.transcriptWatcher.close();
  meta.delete(sessionId);
}

/** Clear all per-session state (test teardown only). */
export function _resetActivityForTest(): void {
  for (const m of meta.values()) {
    if (m.debounceTimer !== null) clearTimeout(m.debounceTimer);
    if (m.transcriptWatcher !== null) m.transcriptWatcher.close();
  }
  meta.clear();
  livePollInFlight = false;
}

// ---------------------------------------------------------------------------
// Transcript turn-end watcher
// ---------------------------------------------------------------------------

/**
 * Watch the transcript file for the `last-prompt` entry that Claude Code writes
 * at the end of every turn (including interrupted ones). When detected, mark the
 * session done if Stop hook didn't fire — this covers ESC interrupts where the
 * hook either fires late or not at all.
 *
 * Uses `seenAssistantInTurn` to skip `last-prompt` entries from previous turns
 * that may appear in the initial read window.
 */
async function startTranscriptTurnWatcher(
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  const m = getMeta(sessionId);

  if (m.transcriptWatcher) {
    m.transcriptWatcher.close();
    m.transcriptWatcher = null;
  }

  // Start from the current end of file so we only process new entries
  m.lastWatchedOffset = (await getTranscriptSize(transcriptPath)) ?? 0;
  m.seenAssistantInTurn = false;

  let watcher: FSWatcher;
  try {
    watcher = watch(transcriptPath, (eventType) => {
      if (eventType !== 'change') return;
      void handleTranscriptChange(sessionId, transcriptPath, watcher);
    });
  } catch {
    return; // file may not exist yet; stale watcher is the fallback
  }

  m.transcriptWatcher = watcher;
  watcher.on('error', () => {
    if (m.transcriptWatcher === watcher) m.transcriptWatcher = null;
  });
}

async function handleTranscriptChange(
  sessionId: string,
  transcriptPath: string,
  watcher: FSWatcher,
): Promise<void> {
  const m = getMeta(sessionId);

  const session = getSession(sessionId);
  if (!session || session.status !== 'working') {
    watcher.close();
    if (m.transcriptWatcher === watcher) m.transcriptWatcher = null;
    return;
  }

  const currentSize = await getTranscriptSize(transcriptPath);
  if (currentSize === null || currentSize <= m.lastWatchedOffset) return;

  const newContent = await readTranscriptFrom(transcriptPath, m.lastWatchedOffset);
  m.lastWatchedOffset = currentSize;

  for (const line of newContent.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === 'assistant') {
        m.seenAssistantInTurn = true;
      } else if (obj.type === 'last-prompt' && m.seenAssistantInTurn) {
        // Turn ended — fire done if Stop hook hasn't already
        const sess = getSession(sessionId);
        if (sess?.status === 'working') {
          if (m.debounceTimer !== null) {
            clearTimeout(m.debounceTimer);
            m.debounceTimer = null;
          }
          finishSession(sessionId);
          broadcast('done', { sessionId, finishedAt: Date.now() });
          console.log(`[transcript] Session ${sessionId} auto-closed — turn ended`);
        }
        watcher.close();
        if (m.transcriptWatcher === watcher) m.transcriptWatcher = null;
        return;
      }
    } catch {
      continue;
    }
  }
}

/**
 * Start the background stale-session watcher.
 *
 * Runs every 30 seconds. For any working session whose transcript file has not
 * been modified in STALE_THRESHOLD_MS, the session is auto-closed as "done".
 *
 * Rationale: while Claude Code is running it continuously writes to its
 * transcript (streaming tokens, tool calls, tool results). If the file goes
 * quiet, Claude has exited — either normally (Stop hook should have fired) or
 * via Ctrl-C / hard kill where the hook never reached us.
 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const STALE_CHECK_INTERVAL_MS = 30_000; // check every 30 s
/** How often the live size-poll checks every working session for transcript growth. */
const LIVE_POLL_MS = 5_000;
/** Re-entrancy guard: skip a poll tick if the prior pass is still running (a slow `stat` must not
 *  let passes pile up and fan out duplicate work). */
let livePollInFlight = false;

/** A working session that has a known transcript path — the unit both background loops act on. */
type LiveSession = NonNullable<ReturnType<typeof getSession>>;
interface LiveSessionEntry {
  sessionId: string;
  m: SessionMeta;
  session: LiveSession;
  transcriptPath: string;
}

/**
 * Yield every working session that has a recorded transcript path. Shared by the stale-session
 * watcher and the live size-poll so the "is this session live and watchable?" guard lives once.
 */
function* eachWorkingSessionWithTranscript(): Generator<LiveSessionEntry> {
  for (const [sessionId, m] of meta.entries()) {
    const session = getSession(sessionId);
    if (!session || session.status !== 'working' || !m.transcriptPath) continue;
    yield { sessionId, m, session, transcriptPath: m.transcriptPath };
  }
}

export function startStaleSessionWatcher(): void {
  setInterval(async () => {
    for (const { sessionId, m, session, transcriptPath } of eachWorkingSessionWithTranscript()) {
      // Grace period: don't fire on sessions younger than the threshold
      if (Date.now() - session.startedAt < STALE_THRESHOLD_MS) continue;

      const mtime = await getTranscriptMtime(transcriptPath);
      if (mtime === null) continue;

      if (Date.now() - mtime > STALE_THRESHOLD_MS) {
        // Cancel any pending debounce so it doesn't fire after we close the session
        if (m.debounceTimer !== null) {
          clearTimeout(m.debounceTimer);
          m.debounceTimer = null;
        }
        finishSession(sessionId);
        broadcast('done', { sessionId, finishedAt: Date.now() });
        console.log(
          `[stale] Session ${sessionId} auto-closed — transcript unchanged for ${STALE_THRESHOLD_MS / 60_000}m`,
        );
      }
    }
  }, STALE_CHECK_INTERVAL_MS);
}

/**
 * One pass of the live size-poll: for every working session, re-summarise if its transcript grew
 * since the last summary. This is the primary trigger for assistant-text-only turns — Claude Code
 * fires no hook when the agent emits text without a tool call, so without this the Current Focus
 * panel would freeze until the next tool hook or the viewed-tab 30s poll.
 *
 * The byte-size growth pre-check is deliberate: run() does NOT skip when the transcript is absent
 * (no-transcript sessions summarise by design — see index.ts), so calling it unconditionally on a
 * session whose file briefly doesn't exist would fire empty-context LLM calls every tick. run()'s
 * own skip-if-unchanged + single-flight remain the authoritative cost guards once we do call it.
 *
 * Exported for unit tests.
 */
export async function runLiveSummaryPass(): Promise<void> {
  if (livePollInFlight) return; // a prior pass is still running — don't overlap/pile up
  livePollInFlight = true;
  try {
    for (const { sessionId, m, transcriptPath } of eachWorkingSessionWithTranscript()) {
      const size = await getTranscriptSize(transcriptPath);
      if (size === null) continue; // file not present yet — nothing to summarise
      // Exact-equality skip (matches run()'s own guard). Using `<=` would permanently stall the poll
      // for a session whose transcript ever shrank (rotation/truncation); `===` re-summarises on any change.
      if (m.lastSummarizedSize !== null && size === m.lastSummarizedSize) continue; // unchanged
      void run(sessionId);
    }

    // Waiting sessions whose transcript grew past the baseline stamped at setWaiting time:
    // the agent resumed without firing a tool hook (e.g. a denied permission answered with
    // prose). Nothing else clears that wait — the dot would stick at "Needs you" until Stop.
    for (const [sessionId, m] of meta.entries()) {
      const session = getSession(sessionId);
      if (!session || session.status !== 'waiting') continue;
      if (!m.transcriptPath || m.waitingSize === null) continue;
      const size = await getTranscriptSize(m.transcriptPath);
      if (size === null || size <= m.waitingSize) continue;
      m.waitingSize = null;
      markWorking(sessionId);
      // Same revive broadcast as the PostToolUse path — the client flips the session back
      // to working in place, preserving its prompt arc and focus state.
      const live = getSession(sessionId) ?? session;
      broadcast('task', {
        sessionId,
        prompt: live.prompt,
        prompts: live.prompts,
        startedAt: live.startedAt,
      });
      console.log(`[live] Cleared stuck waiting for ${sessionId} — transcript resumed growing`);
      void run(sessionId);
    }
  } finally {
    livePollInFlight = false;
  }
}

/** Start the live size-poll (every LIVE_POLL_MS). Call once at server startup. */
export function startLiveSummaryPoll(): void {
  // unref so the poll interval never keeps the process alive on its own (the HTTP server does).
  setInterval(() => void runLiveSummaryPass(), LIVE_POLL_MS).unref?.();
}

// ---------------------------------------------------------------------------
// Internal run loop
// ---------------------------------------------------------------------------

async function run(sessionId: string): Promise<void> {
  const m = getMeta(sessionId);
  const provider = getActiveProvider();

  // No provider configured — skip silently
  if (!provider) return;

  const session = getSession(sessionId);
  // Never summarise a done session (Stop already triggered a final run)
  // This guard is best-effort; the Stop handler's summarizeNow is the final call
  if (!session) return;

  // Single-flight guard: if a call is already in-flight, mark rerun and return.
  // Set inFlight BEFORE any await so concurrent synchronous calls see the flag.
  if (m.inFlight) {
    m.rerunRequested = true;
    return;
  }
  m.inFlight = true;
  m.rerunRequested = false;

  // Skip-if-unchanged: compare transcript size to last summarised size.
  // Must check after setting inFlight so the flag is visible to other callers.
  const transcriptPath = m.transcriptPath;
  const currentSize = transcriptPath ? await getTranscriptSize(transcriptPath) : null;

  if (currentSize !== null && currentSize === m.lastSummarizedSize) {
    // Transcript hasn't grown — no new information, skip the LLM call
    m.inFlight = false;
    return;
  }

  // Capture turn identity + focus-append eligibility BEFORE the LLM await:
  //  - turnSeq/turnPrompt pin the summary to the turn it's about, even if a new prompt
  //    arrives during the (multi-second) LLM call.
  //  - allowAppend gates focus-history growth on real progress: the transcript grew (we
  //    only reach here when it did, unless there's no transcript). This stops the
  //    no-transcript 30s poll from flooding history with re-narrations of the same state.
  const turnSeq = session.turnSeq;
  const turnPrompt = session.prompt;
  const transcriptGrew = currentSize !== null;
  const allowAppend = session.focusHistory.length === 0 || transcriptGrew;

  // --- Run the LLM call ---

  setActivityGenerating(sessionId);
  broadcast('activity_generating', { sessionId });

  try {
    const transcriptTail = transcriptPath ? await readTranscriptTail(transcriptPath) : '';

    const ctx: ActivityContext = {
      prompt: session.prompt,
      prompts: session.prompts,
      transcriptTail,
      // Feed prior topics back for anti-churn — stable chips.
      previousTopics: session.suggestedTopics,
      status: session.status,
      waitingReason: session.waitingReason,
    };

    // `topics` defaults to [] defensively — a provider that returns nothing must not crash.
    const { summary, topics = [] } = await provider.summarizeActivity(ctx);

    // setActivity filters topics against already-researched + in-flight before storing,
    // so broadcast the stored (filtered) list, not the raw model output. It also returns
    // the focus-history entry it appended (or null) — broadcast it so the client appends
    // the same entry the server stored (de-dup logic lives ONLY on the server).
    const entry = setActivity(sessionId, {
      summary,
      topics,
      turnSeq,
      turnPrompt,
      allowAppend,
    });
    const stored = getSession(sessionId);
    const suggestedTopics = stored?.suggestedTopics ?? [];
    broadcast('activity', {
      sessionId,
      summary,
      topics: suggestedTopics,
      entry,
    });
    if (currentSize !== null) {
      m.lastSummarizedSize = currentSize;
    }
    console.log(
      `[activity] Summarised ${sessionId} (${summary.length} chars, ${suggestedTopics.length} topics)`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Full detail stays in the server log — provider errors can embed CLI stderr,
    // paths, or key fragments that must not reach the browser.
    const generic = 'Summarisation failed — see the foyer server logs.';
    setActivityError(sessionId, generic);
    broadcast('activity_error', { sessionId, error: generic });
    console.error(`[activity] Summarisation failed for ${sessionId}:`, msg);
  } finally {
    m.inFlight = false;

    // If transcript grew while we were in-flight, do one follow-up run
    if (m.rerunRequested) {
      m.rerunRequested = false;
      const newSize = transcriptPath ? await getTranscriptSize(transcriptPath) : null;
      if (newSize !== null && newSize !== m.lastSummarizedSize) {
        void run(sessionId);
      }
    }
  }
}
