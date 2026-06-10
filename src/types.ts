// Shared types between the server (SSE payloads) and the React frontend.

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
  /** ms timestamp when the user first opened this briefing; null/undefined = unread.
   *  Server-owned, mirroring `pinnedAt` (ADR 0004). Drives the rail's "ready to read" (unread,
   *  amber) vs "read" (dimmed, no amber) split so amber stays a rare live/ready signal. */
  readAt?: number | null;
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

/** Canonical research-topic key: trimmed + lowercased. The single source of truth for topic
 *  identity across the in-flight guard, the suggested-topic filter, the prefetch cache, the
 *  primary-briefing designation, and the client's chip/strip composition — shared here (not in
 *  state.ts) so the pure ranking module and the client can use it without importing server state. */
export const topicKey = (topic: string): string => topic.trim().toLowerCase();

/** A doc the primary briefing is grounded in (citation readout on the strip) or that matched the
 *  session's context (the extractive WATCHING/MATCHED state). Path is display-relative; never an
 *  interactive control in v1 (design review DR14). */
export interface DocRef {
  path: string;
  title: string;
}

/**
 * Lifecycle of a session's PRIMARY briefing — the one recommended read (Live Learning Briefing).
 *
 *             (no candidates / null pick)
 *    ┌──────────── (none) ◀──────────────────────┐
 *    │              │ ranking proposes pick       │ session close
 *    │              ▼                             │
 *    │           warming ──fails ×2──▶ error ──retry──▶ warming
 *    │              │ research resolves
 *    │              ▼
 *    │            ready ──user opens──▶ read ──next pick──▶ demoted to read row (DR7)
 *    │              │ meaningful shift (unread only)
 *    │              ▼
 *    └────────── superseded (old briefing stays as an unread row / chip)
 *        (user dismiss: any non-read state → logged + excluded; next-ranked promoted)
 */
export type PrimaryStatus = 'warming' | 'ready' | 'read' | 'error';

export interface PrimaryBriefing {
  /** Original topic text — identity is topicKey(topic); the briefing body lives in `research[]`
   *  under the same topic (designation-over-data, eng review D8: one source of truth). */
  topic: string;
  /** The LLM's one-line "why read this now" (≤80 chars, server-capped — design review DR12). */
  reason: string;
  status: PrimaryStatus;
  /** ms timestamp when the current status was entered. */
  since: number;
  /** Time-to-ready in ms (queued→ready), frozen at ready time. The D17 starvation metric,
   *  surfaced as the strip's "ready · mm:ss" readout (DR11). Null until ready. */
  readyMs?: number | null;
  /** Consecutive warm failures (the "failed ×N" readout; 2 → error state). */
  failures?: number;
  /** Docs the briefing prompt was grounded in (strip citation readout, ≤3). */
  docs?: DocRef[];
}

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
  activityStatus: 'idle' | 'generating' | 'ready' | 'error';
  activityError: string | null;
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
  /** ms timestamp when the user pinned this session; null/absent = not pinned. Pinned sessions
   *  sort to the top of the sidebar, most-recently-pinned first (sortPinnedFirst). Server-owned
   *  and persisted, mirroring `closed` (ADR 0004). */
  pinnedAt?: number | null;
  /** Working directory of the agent (from hook payloads). Grounds the repo doc-source scan and
   *  the touched-area dir aggregation. Null until a hook carries one. */
  cwd?: string | null;
  /** Directory areas the agent's tool calls have touched (dir-aggregated, most-active first,
   *  capped). Accumulated in memory per tool call, persisted only on the summarize tick (eng
   *  review D14 — no per-tool-call write amplification). Feeds ranking + the extractive strip. */
  touchedAreas?: string[];
  /** Top indexed docs matching the session's context (the extractive MATCHED readout, capped). */
  contextDocs?: DocRef[];
  /** The session's primary briefing designation, or null/absent when no confident pick exists
   *  (null-primary is a first-class outcome — eng review D7). Rides the snapshot, so reconnect
   *  replay needs no extra machinery. */
  primary?: PrimaryBriefing | null;
  /** topicKeys the user dismissed via "NOT USEFUL" — excluded from suggestions and from primary
   *  selection for the rest of the session (eng review D18). */
  dismissedTopics?: string[];
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
    activityStatus: 'idle',
    activityError: null,
    research: [],
    suggestedTopics: [],
    startedAt,
    finishedAt: null,
    pinnedAt: null,
  };
}

/**
 * Sidebar ordering: pinned sessions first (most-recently-pinned first), then unpinned sessions
 * in chronological start order (startedAt asc). Pure — returns a new array.
 *
 *   pinnedAt: 1030 ┐ pinned, newest pin first
 *   pinnedAt: 1010 ┘
 *   ─────────────── (unpinned below, by startedAt)
 *   startedAt: 100  (started 1st)
 *   startedAt: 200  (started 2nd)
 *
 * Unpinned are ordered by `startedAt`, NOT input position. On the server this matches Map
 * insertion order (sessions are inserted in startedAt order), so getAllSessions is unchanged.
 * On the CLIENT it's what makes an optimistic UNPIN correct: the array has been reshuffled by
 * earlier pins, so a position-based tiebreak would strand a just-unpinned row at the top until
 * the next snapshot — startedAt drops it straight back to its chronological slot. A captured
 * index is the final tiebreak so equal-startedAt sessions stay stable across engines. Shared by
 * server + client so the two orderings can never drift.
 */
export function sortPinnedFirst(sessions: Session[]): Session[] {
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ap = a.s.pinnedAt ?? null;
      const bp = b.s.pinnedAt ?? null;
      if (ap !== null && bp !== null) return bp - ap; // both pinned → newest pin first
      if (ap !== null) return -1; // a pinned, b not
      if (bp !== null) return 1; // b pinned, a not
      if (a.s.startedAt !== b.s.startedAt) return a.s.startedAt - b.s.startedAt; // both unpinned
      return a.i - b.i; // equal startedAt → stable tiebreak
    })
    .map(({ s }) => s);
}

// SSE event types the server pushes to the browser
export type SseType =
  | 'snapshot'
  | 'task'
  /** Focus signal: a session just received a genuine user prompt (the most-recently-interacted
   *  session). Emitted ONLY from onUserPrompt — never on agent-driven task broadcasts — so the
   *  client can "follow the live channel" without being yanked by autonomous agent activity. */
  | 'active'
  | 'activity'
  | 'activity_generating'
  | 'activity_error'
  | 'waiting'
  | 'done'
  | 'research_result'
  /** A speculative prefetch for a suggested topic just finished warming — the result is cached
   *  server-side (hidden until tapped). Lets the client light a "primed" dot on that chip. */
  | 'research_primed'
  /** A speculative prefetch is actively in flight (`active: true`) or just left flight
   *  (`active: false`). Drives the pulsing "warming" ring that settles into the primed dot. */
  | 'research_warming'
  /** The session's primary-briefing designation changed (designated / ready / read / error /
   *  dismissed / demoted). Payload: { sessionId, primary: PrimaryBriefing | null }. Reconnect
   *  replay is free: `primary` lives on Session and rides the snapshot. */
  | 'primary'
  | 'heartbeat';
