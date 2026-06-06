// Shared types between the server (SSE payloads) and the React frontend.

export interface TouchPoint {
  path: string;
  tool: string;
  ts: number;
}

export interface ResearchLink {
  title: string;
  url: string;
}

export interface ResearchResult {
  topic: string;
  summary: string;
  links: ResearchLink[];
  ts: number;
}

/** Max focus-history entries retained per session (shared by the server cap and the
 *  client-side prepend cap so the two can never drift). */
export const MAX_FOCUS = 50;

/**
 * One narrated "Current Focus" snapshot, retained so the panel can show the agent's
 * trajectory instead of only the latest line.
 *
 *   turn 3  "add the export button"   ← turnPrompt (divider); turnSeq groups entries
 *     ├─ 14:02  "Wiring the click handler…"   ← FocusEntry (newest first)
 *     └─ 14:01  "Adding the button markup…"
 *   turn 2  "fix the header spacing"
 *     └─ 13:55  "Tweaking the flex gap…"
 */
export interface FocusEntry {
  /** Stable id (`${sessionId}-${ts}`) so the reducer can de-dupe an entry that arrives
   *  both in a reconnect `snapshot` and an in-flight `activity` SSE event. */
  id: string;
  /** The narrated focus markdown captured at this tick. */
  summary: string;
  /** Capture time (ms). */
  ts: number;
  /** Monotonic turn counter at capture. STABLE — unlike `prompts.length`, which is capped
   *  and drops middle turns, so it would mislabel old entries. */
  turnSeq: number;
  /** Copy of the turn's prompt text — the divider is self-contained and survives `prompts` pruning. */
  turnPrompt: string;
}

/**
 * A research topic auto-derived from the agent's current work (prompt + file edits +
 * transcript) during activity summarization. Presented as a clickable chip; clicking
 * runs the existing research pipeline. `reason` is the "why this topic" provenance line.
 */
export interface SuggestedTopic {
  topic: string;
  reason: string;
}

/** Lifecycle state of a session.
 *  working = agent is running; waiting = blocked on user input; done = stopped cleanly;
 *  interrupted = was live when the server died, recovered from disk on the next boot (terminal). */
export type SessionStatus = 'working' | 'waiting' | 'done' | 'interrupted';

export interface Session {
  sessionId: string;
  status: SessionStatus;
  /** Reason the agent is blocked, e.g. a permission request. Null when not waiting. */
  waitingReason: string | null;
  prompt: string;
  /** Full ordered prompt history for this session; `prompt` is always the latest (`prompts.at(-1)`). */
  prompts: string[];
  /** Monotonic turn counter — incremented when a genuinely new prompt is pushed. Stamped onto each
   *  FocusEntry so focus history groups by turn even after `prompts` is pruned. Starts at 1. */
  turnSeq: number;
  /** Live markdown summary of what the agent is doing right now (latest of `focusHistory`). */
  summary: string | null;
  /** Retained narrated focus snapshots, newest-first, capped at MAX_FOCUS. `summary` is `focusHistory[0]`. */
  focusHistory: FocusEntry[];
  /** Mermaid `graph LR` milestone storyline, populated asynchronously after activity summarization. */
  graph: string | null;
  activityStatus: 'idle' | 'generating' | 'ready' | 'error';
  activityError: string | null;
  touchPoints: TouchPoint[];
  research: ResearchResult[];
  /**
   * Research topics auto-derived from the agent's work, refreshed each activity tick.
   * Excludes topics already researched or with research in flight (server-filtered).
   */
  suggestedTopics: SuggestedTopic[];
  startedAt: number;
  finishedAt: number | null;
  /** User dismissed this tab. Persisted so a closed session stays hidden across restarts
   *  (the snapshot filters these out) without destroying its history on disk. */
  closed?: boolean;
}

/** Payload for the `snapshot` SSE event. Carries all known sessions + the server-designated active session. */
export interface SnapshotPayload {
  sessions: Session[];
  activeSessionId: string | null;
}

/** Factory that builds a fresh working Session with all default fields. */
export function newSession(sessionId: string, prompt: string, startedAt: number): Session {
  return {
    sessionId,
    status: 'working',
    waitingReason: null,
    prompt,
    prompts: [prompt],
    turnSeq: 1,
    summary: null,
    focusHistory: [],
    graph: null,
    activityStatus: 'idle',
    activityError: null,
    touchPoints: [],
    research: [],
    suggestedTopics: [],
    startedAt,
    finishedAt: null,
  };
}

// SSE event types the server pushes to the browser
export type SseType =
  | 'snapshot'
  | 'task'
  | 'touch'
  | 'activity'
  | 'activity_generating'
  | 'activity_error'
  | 'waiting'
  | 'done'
  | 'research_result'
  | 'heartbeat';
