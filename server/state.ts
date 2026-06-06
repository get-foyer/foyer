import type {
  Session,
  TouchPoint,
  ResearchResult,
  SuggestedTopic,
  FocusEntry,
} from '../src/types.js';
import { newSession, MAX_FOCUS } from '../src/types.js';
import { normalizeWhitespace } from './providers/text.js';

export type { Session };

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;

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

const topicKey = (topic: string): string => topic.trim().toLowerCase();

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

/** Returns all sessions in insertion (start) order — working and done. */
export function getAllSessions(): Session[] {
  return [...sessions.values()];
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
}

/** Max prompts retained per session. Beyond this, the goal (prompts[0]) and the most
 *  recent entries are kept; the oldest middle turns are dropped. */
const MAX_PROMPTS = 100;

/**
 * Start a NEW session, or CONTINUE an existing one (same Claude Code session_id, next turn).
 *
 * Claude Code reuses one stable session_id across every turn of a session, so a follow-up
 * prompt must NOT wipe the card. On continue we reopen to `working` and preserve the
 * accumulated `touchPoints`/`summary`/`graph`/`research`/`startedAt`, appending the new
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
    return { session: existing, continued: true };
  }
  const session = newSession(sessionId, prompt, Date.now());
  sessions.set(sessionId, session);
  activeSessionId = sessionId;
  return { session, continued: false };
}

export function addTouchPoint(sessionId: string, tp: TouchPoint): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.touchPoints.unshift(tp); // newest first
  return true;
}

// ---------------------------------------------------------------------------
// Activity state — live summary + graph produced by summarizeActivity()
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
 * repeat). Either way the live `summary`/`graph`/`suggestedTopics` are refreshed.
 *
 * Append gate (two layers, both must pass):
 *   1. `allowAppend` — the caller (activity.ts) only sets this when real progress happened
 *      (transcript grew OR a new touchpoint since the last entry). Kills the no-transcript
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
    graph: string;
    topics: SuggestedTopic[];
    turnSeq: number;
    turnPrompt: string;
    allowAppend: boolean;
  },
): FocusEntry | null {
  const s = sessions.get(sessionId);
  if (!s) return null;

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
  s.graph = update.graph;
  s.suggestedTopics = filterSuggestedTopics(s, update.topics);
  s.activityStatus = 'ready';
  s.activityError = null;
  return entry;
}

/**
 * Drop topics the user has already researched OR has a research call in flight for,
 * so a chip can't reappear between the click and the result landing (case-insensitive).
 */
function filterSuggestedTopics(s: Session, topics: SuggestedTopic[]): SuggestedTopic[] {
  const researched = new Set(s.research.map((r) => topicKey(r.topic)));
  const inFlight = inFlightResearch.get(s.sessionId);
  return topics.filter((t) => {
    const k = topicKey(t.topic);
    return !researched.has(k) && !(inFlight?.has(k) ?? false);
  });
}

export function setActivityError(sessionId: string, error: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.activityStatus = 'error';
  s.activityError = error;
  return true;
}

export function setWaiting(sessionId: string, reason: string | null): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.status === 'done') return true;
  s.status = 'waiting';
  s.waitingReason = reason;
  return true;
}

/** Clears 'waiting' back to 'working'. No-op if session is already working or done. */
export function clearWaiting(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.status === 'waiting') {
    s.status = 'working';
    s.waitingReason = null;
  }
  return true;
}

export function finishSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.status = 'done';
  s.waitingReason = null;
  s.finishedAt = Date.now();
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
  return true;
}
