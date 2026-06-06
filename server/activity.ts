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
 * Triggered three ways:
 *   1. scheduleSummarize(sessionId)  — from PostToolUse (debounced, any session)
 *   2. summarizeNow(sessionId)       — from Stop and POST /activity (no debounce)
 *   3. POST /activity {sessionId}    — client poll for the viewed session (30s)
 */
import { watch } from 'fs';
import type { FSWatcher } from 'fs';
import { getSession, finishSession } from './state.js';
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
    };
    meta.set(sessionId, m);
  }
  return m;
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

/** Clear all per-session state (test teardown only). */
export function _resetActivityForTest(): void {
  for (const m of meta.values()) {
    if (m.debounceTimer !== null) clearTimeout(m.debounceTimer);
    if (m.transcriptWatcher !== null) m.transcriptWatcher.close();
  }
  meta.clear();
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

export function startStaleSessionWatcher(): void {
  setInterval(async () => {
    for (const [sessionId, m] of meta.entries()) {
      const session = getSession(sessionId);
      // Only working sessions with a known transcript path
      if (!session || session.status !== 'working' || !m.transcriptPath) continue;
      // Grace period: don't fire on sessions younger than the threshold
      if (Date.now() - session.startedAt < STALE_THRESHOLD_MS) continue;

      const mtime = await getTranscriptMtime(m.transcriptPath);
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
  //    only reach here when it did, unless there's no transcript) OR a file was touched
  //    since the last entry. This stops the no-transcript 30s poll from flooding history
  //    with re-narrations of the same state.
  const turnSeq = session.turnSeq;
  const turnPrompt = session.prompt;
  const transcriptGrew = currentSize !== null;
  const lastEntryTs = session.focusHistory[0]?.ts ?? 0;
  const newestTouchTs = session.touchPoints[0]?.ts ?? 0;
  const allowAppend =
    session.focusHistory.length === 0 || transcriptGrew || newestTouchTs > lastEntryTs;

  // --- Run the LLM call ---

  setActivityGenerating(sessionId);
  broadcast('activity_generating', { sessionId });

  try {
    const transcriptTail = transcriptPath ? await readTranscriptTail(transcriptPath) : '';

    const ctx: ActivityContext = {
      prompt: session.prompt,
      prompts: session.prompts,
      recentTouchPoints: session.touchPoints.slice(0, 10),
      transcriptTail,
      // Feed the prior storyline back so the model extends it append-only,
      // keeping the session's silhouette stable across ticks.
      previousGraph: session.graph,
      // Feed prior topics back for the same anti-churn reason — stable chips.
      previousTopics: session.suggestedTopics,
      status: session.status,
      waitingReason: session.waitingReason,
    };

    // `topics` defaults to [] defensively — a provider that returns nothing must not crash.
    const { summary, graph, topics = [] } = await provider.summarizeActivity(ctx);

    // setActivity filters topics against already-researched + in-flight before storing,
    // so broadcast the stored (filtered) list, not the raw model output. It also returns
    // the focus-history entry it appended (or null) — broadcast it so the client appends
    // the same entry the server stored (de-dup logic lives ONLY on the server).
    const entry = setActivity(sessionId, {
      summary,
      graph,
      topics,
      turnSeq,
      turnPrompt,
      allowAppend,
    });
    const stored = getSession(sessionId);
    const suggestedTopics = stored?.suggestedTopics ?? [];
    broadcast('activity', { sessionId, summary, graph, topics: suggestedTopics, entry });
    if (currentSize !== null) {
      m.lastSummarizedSize = currentSize;
    }
    console.log(
      `[activity] Summarised ${sessionId} (${summary.length} chars, ${graph.length} chars graph, ${suggestedTopics.length} topics)`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setActivityError(sessionId, msg);
    broadcast('activity_error', { sessionId, error: msg });
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
