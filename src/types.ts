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

/**
 * One section of a documentation-style research briefing. `body` is GitHub-flavored
 * markdown (prose, lists, tables); `diagram` is optional raw Mermaid source rendered as a
 * figure under the body. A trivial topic comes back as a single section (no manufactured
 * structure) — see the adaptive rule in the research prompt.
 */
export interface ResearchSection {
  heading: string;
  body: string;
  diagram?: string;
}

export interface ResearchResult {
  topic: string;
  /** 1-2 sentence TL;DR shown above the sections so the glance-reader gets the gist first. */
  lede: string;
  /** Ordered doc sections; always >= 1. */
  sections: ResearchSection[];
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
  /** Mermaid `graph LR` milestone storyline, populated asynchronously after activity summarization.
   *  Content is session-spanning and monotonic — a later trivial tick never nulls a real storyline. */
  graph: string | null;
  /**
   * turnSeq for which a workflow graph should be SHOWN (folded into Current Focus). Visibility is
   * `workflowTurnSeq === turnSeq` (see {@link isWorkflowVisible}): it goes stale automatically on a
   * new turn, so the workflow is re-decided fresh each prompt yet stays sticky within a turn. Null
   * until the first tick where the work warrants a graph (multi-phase) or the agent exited plan mode.
   */
  workflowTurnSeq: number | null;
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
    workflowTurnSeq: null,
    activityStatus: 'idle',
    activityError: null,
    touchPoints: [],
    research: [],
    suggestedTopics: [],
    startedAt,
    finishedAt: null,
  };
}

/**
 * Whether the workflow graph should be shown for this session right now.
 *
 * Visibility is turn-scoped: the server stamps `workflowTurnSeq` with the turn for which a
 * workflow was warranted (multi-phase work, or the agent exited plan mode). Comparing it to the
 * live `turnSeq` makes the graph sticky WITHIN a turn (later trivial ticks don't hide it) but
 * re-decided fresh on the NEXT prompt (the bump makes the stamp stale). Graph CONTENT
 * (`session.graph`) is independent and session-spanning — this only governs the readout.
 */
export function isWorkflowVisible(s: Session): boolean {
  return s.workflowTurnSeq != null && s.workflowTurnSeq === s.turnSeq;
}

// SSE event types the server pushes to the browser
export type SseType =
  | 'snapshot'
  | 'task'
  /** Focus signal: a session just received a genuine user prompt (the most-recently-interacted
   *  session). Emitted ONLY from onUserPrompt — never on agent-driven task broadcasts — so the
   *  client can "follow the live channel" without being yanked by autonomous agent activity. */
  | 'active'
  | 'touch'
  | 'activity'
  | 'activity_generating'
  | 'activity_error'
  | 'waiting'
  | 'done'
  | 'research_result'
  /** A speculative prefetch for a suggested topic just finished warming — the result is cached
   *  server-side (hidden until tapped). Lets the client light a "primed" dot on that chip. */
  | 'research_primed'
  | 'heartbeat';
