import React, { useEffect, useReducer, useState } from 'react';
import type {
  Session,
  TouchPoint,
  ResearchResult,
  SuggestedTopic,
  FocusEntry,
  SnapshotPayload,
} from './types';
import { newSession, MAX_FOCUS, isWorkflowVisible } from './types';
import { useSSE } from './hooks/useSSE';
import type { ConnectionStatus } from './hooks/useSSE';
import { TaskHeader } from './components/TaskHeader';
import { SummaryPanel } from './components/SummaryPanel';
import { TouchPoints } from './components/TouchPoints';
import { ResearchPanel } from './components/ResearchPanel';
import { ResearchTab } from './components/ResearchTab';
import { ViewTabs } from './components/ViewTabs';
import type { SessionView } from './components/ViewTabs';
import { SessionTabs } from './components/SessionTabs';
import { ErrorBoundary } from './components/ErrorBoundary';

// ---------------------------------------------------------------------------
// State management — simple reducer so SSE events map cleanly to state updates
// ---------------------------------------------------------------------------

type State = {
  sessions: Session[]; // working + done, in start order
  activeSessionId: string | null;
  /** 'follow' (default): the view auto-tracks the session you most recently prompted.
   *  'held': you clicked a tab; the view stays put until you click FOLLOW (hard-hold model). */
  followMode: 'follow' | 'held';
  /** The server's most-recently-prompted session — the FOLLOW catch-up target. May lag the
   *  viewed tab while held. Always validated against visible sessions before any focus jump. */
  liveSessionId: string | null;
  unseenSessionIds: string[]; // tabs added in the background, not yet viewed
  closedSessionIds: string[]; // tabs the user dismissed (filtered from snapshots)
  /** Which view (focus | research) is showing per session. Absent → 'focus'. The view is
   *  per-session so the shipped follow/select auto-switch never shows one session's research
   *  while you're on another — switching sessions lands on that session's view (Focus default). */
  viewBySession: Record<string, SessionView>;
  /** Sessions with a briefing that landed while you weren't on their Research tab → amber
   *  "ready" dot on the tab. Cleared when you open that session's Research view. */
  researchUnseen: string[];
  /** Which briefing (by ts) is open in each session's Research tab. Absent → newest. */
  selectedResearchBySession: Record<string, number>;
  /** Per-session set of topic keys whose research is PRIMED (prefetched + ready server-side) →
   *  amber "ready" dot on the chip. Kept separate from the persisted Session (ephemeral, derived
   *  from `research_primed` SSE events). Reset on every snapshot and rebuilt from the replay, so
   *  a dot can never outlive a server restart / TTL expiry it no longer reflects. */
  primedTopics: Record<string, string[]>;
};

/** Canonical topic key — must match the server's `topicKey` (trim + lowercase) so primed dots
 *  line up with the chips and with `research`/`suggestedTopics` filtering. */
const topicKey = (t: string): string => t.trim().toLowerCase();

type Action =
  | { type: 'snapshot'; payload: SnapshotPayload }
  | {
      type: 'task';
      payload: { sessionId: string; prompt: string; prompts?: string[]; startedAt: number };
    }
  | { type: 'touch'; payload: { sessionId: string } & TouchPoint }
  | {
      type: 'activity';
      payload: {
        sessionId: string;
        summary: string;
        /** null = no workflow warranted (trivial work); the server keeps any prior storyline. */
        graph: string | null;
        /** Turn the workflow is shown for — drives isWorkflowVisible() in the fold-in render. */
        workflowTurnSeq: number | null;
        topics: SuggestedTopic[];
        /** The focus-history entry the server appended this tick, or null if it was a
         *  non-meaningful repeat. Present → prepend to focusHistory (de-duped by id). */
        entry?: FocusEntry | null;
      };
    }
  | { type: 'activity_generating'; payload: { sessionId: string } }
  | { type: 'activity_error'; payload: { sessionId: string; error: string } }
  | { type: 'done'; payload: { sessionId: string; finishedAt: number } }
  | { type: 'waiting'; payload: { sessionId: string; reason: string } }
  | { type: 'research_result'; payload: ResearchResult & { sessionId: string; topic: string } }
  /** Switch the active session's view (Focus ⇄ Research). */
  | { type: 'set_view'; payload: { sessionId: string; view: SessionView } }
  /** Choose which briefing the session's Research tab shows. */
  | { type: 'select_research'; payload: { sessionId: string; ts: number } }
  /** A suggested topic's research finished warming server-side → light its primed dot. */
  | { type: 'research_primed'; payload: { sessionId: string; topic: string } }
  /** Focus signal from the server: this session just got a genuine user prompt. */
  | { type: 'active'; payload: { sessionId: string } }
  /** User clicked the FOLLOW control: resume following + jump to the live session. */
  | { type: 'follow' }
  | { type: 'select'; payload: { sessionId: string } }
  | { type: 'close'; payload: { sessionId: string } };

export const initialState: State = {
  sessions: [],
  activeSessionId: null,
  followMode: 'follow',
  liveSessionId: null,
  unseenSessionIds: [],
  closedSessionIds: [],
  viewBySession: {},
  researchUnseen: [],
  selectedResearchBySession: {},
  primedTopics: {},
};

export function isActiveSession(state: State, sessionId: string): boolean {
  return state.activeSessionId === sessionId;
}

/**
 * A session id is "visible" iff it's currently a tab the user can see (present in
 * `state.sessions`, which already excludes closed sessions). Focus is NEVER assigned to a
 * non-visible id — the server keeps closed sessions in its `activeSessionId`, so the live
 * pointer can name a session that's been filtered out of the snapshot; jumping to it would
 * blank the main panel.
 */
function isVisible(state: State, sessionId: string | null | undefined): boolean {
  return !!sessionId && state.sessions.some((s) => s.sessionId === sessionId);
}

/**
 * Immutably patches the session with the given id.
 * Returns state unchanged if the id is not found — so background-session events
 * accumulate state without requiring an `isActiveSession` guard.
 */
function updateSession(state: State, sessionId: string, patch: (s: Session) => Session): State {
  const idx = state.sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx === -1) return state;
  const sessions = state.sessions.slice();
  sessions[idx] = patch(sessions[idx]);
  return { ...state, sessions };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot': {
      const { sessions: incoming, activeSessionId: payloadActive } = action.payload;
      // Filter out sessions the user has closed
      const sessions = incoming.filter((s) => !state.closedSessionIds.includes(s.sessionId));
      const ids = new Set(sessions.map((s) => s.sessionId));
      // Track the live pointer only when the server names a VISIBLE session; otherwise keep the
      // prior value (a closed session lingers in the server's activeSessionId — never follow it).
      const liveVisible = ids.has(payloadActive ?? '');
      const liveSessionId = liveVisible ? payloadActive : state.liveSessionId;
      // activeSessionId resolution (D4 — branch on followMode):
      //  - follow: catch up to the live session if the server names a visible one (reconnect may
      //    have missed `active` events while disconnected), else fall back;
      //  - held: preserve the user's current tab (no reconnect yank), else fall back.
      let activeSessionId: string | null;
      if (state.followMode === 'follow' && liveVisible) {
        activeSessionId = payloadActive;
      } else if (ids.has(state.activeSessionId ?? '')) {
        activeSessionId = state.activeSessionId;
      } else if (liveVisible) {
        activeSessionId = payloadActive;
      } else {
        activeSessionId = sessions.length > 0 ? sessions[sessions.length - 1].sessionId : null;
      }
      // Drop unseen ids that are no longer present or are now the active tab
      const unseenSessionIds = state.unseenSessionIds.filter(
        (id) => ids.has(id) && id !== activeSessionId,
      );
      // Reset primed dots — the server replays `research_primed` for currently-ready topics
      // right after this snapshot, so the replay is the single source of truth (no stale dots
      // surviving a restart / TTL expiry, and closed sessions drop out of the map).
      return {
        ...state,
        sessions,
        activeSessionId,
        liveSessionId,
        unseenSessionIds,
        primedTopics: {},
      };
    }

    case 'task': {
      const { sessionId, prompt, prompts, startedAt } = action.payload;
      const existing = state.sessions.find((s) => s.sessionId === sessionId);
      if (existing) {
        // An existing (visible) session can't also be in closedSessionIds — close removes it
        // from state.sessions. So the re-open drop below only matters in the new-session branch.
        // Dedupe: identical latest prompt while already working → no-op (referential
        // stability; avoids re-render churn from snapshot/task races).
        if (existing.status === 'working' && existing.prompt === prompt) {
          return state;
        }
        // Continue/reopen IN PLACE: adopt the server's prompt arc (source of truth — never
        // append locally, which would drift on reconnect/out-of-order), flip to working, and
        // PRESERVE summary/graph/touchPoints/research.
        return updateSession(state, sessionId, (s) => ({
          ...s,
          status: 'working' as const,
          waitingReason: null,
          finishedAt: null,
          prompts: prompts ?? s.prompts,
          prompt,
        }));
      }
      // New OR re-opened (previously closed) session. Drop it from closedSessionIds so the
      // snapshot stops hiding it — the server cleared `closed` on this prompt (D5 re-open).
      // Note (2nd-pass D1): a re-opened tab starts blank (empty touchPoints/research); the
      // server-retained history reappears on the next reconnect snapshot.
      const closedSessionIds = state.closedSessionIds.filter((id) => id !== sessionId);
      const session = newSession(sessionId, prompt, startedAt);
      if (prompts) session.prompts = prompts;
      const sessions = [...state.sessions, session];
      // First session → activate (seen). Otherwise keep current view + mark unseen.
      // Badge ownership (2nd-pass D3): `task` owns the badge for a brand-new BACKGROUND session;
      // the `active` event owns badging for prompts to already-present background sessions in
      // held mode. The two never overlap (a brand-new session isn't already present).
      if (state.activeSessionId === null) {
        return { ...state, sessions, closedSessionIds, activeSessionId: sessionId };
      }
      return {
        ...state,
        sessions,
        closedSessionIds,
        unseenSessionIds: [...state.unseenSessionIds, sessionId],
      };
    }

    case 'active': {
      const { sessionId } = action.payload;
      // Common no-op: a follow-up prompt to the session you're already following. Nothing
      // changes — keep referential stability (avoids a re-render per prompt).
      if (
        state.liveSessionId === sessionId &&
        state.activeSessionId === sessionId &&
        !state.unseenSessionIds.includes(sessionId)
      ) {
        return state;
      }
      // The server names the live (most-recently-prompted) session. Track it as the FOLLOW
      // catch-up target regardless of mode.
      const next: State = { ...state, liveSessionId: sessionId };
      // Only ever focus a VISIBLE session (the preceding `task` added it; guard defensively
      // against event loss / a race where it isn't present yet).
      if (!isVisible(state, sessionId)) return next;
      // Follow mode (or first-session bootstrap) → jump the view to the live session.
      if (state.followMode === 'follow' || state.activeSessionId === null) {
        return {
          ...next,
          activeSessionId: sessionId,
          unseenSessionIds: state.unseenSessionIds.filter((id) => id !== sessionId),
        };
      }
      // Held mode → don't move the view; badge it if it's a background session (deduped).
      if (sessionId === state.activeSessionId || state.unseenSessionIds.includes(sessionId)) {
        return next;
      }
      return { ...next, unseenSessionIds: [...state.unseenSessionIds, sessionId] };
    }

    case 'follow': {
      // Resume following and catch up to the live session — but only if it's still visible
      // (it may have been closed/pruned). Never jump to a non-visible id (blank view).
      if (!isVisible(state, state.liveSessionId)) {
        return state.followMode === 'follow' ? state : { ...state, followMode: 'follow' };
      }
      const live = state.liveSessionId as string;
      return {
        ...state,
        followMode: 'follow',
        activeSessionId: live,
        unseenSessionIds: state.unseenSessionIds.filter((id) => id !== live),
      };
    }

    case 'touch': {
      const { sessionId, path, tool, ts } = action.payload;
      return updateSession(state, sessionId, (s) => ({
        ...s,
        // Any tool activity clears the waiting state
        status: s.status === 'waiting' ? 'working' : s.status,
        waitingReason: s.status === 'waiting' ? null : s.waitingReason,
        touchPoints: [{ path, tool, ts }, ...s.touchPoints],
      }));
    }

    case 'activity': {
      const { entry } = action.payload;
      const sessionId = action.payload.sessionId;
      // Prune primed dots for topics no longer suggested (the chip is gone), mirroring the
      // server's churn-prune so a dot never points at a vanished chip.
      const stillSuggested = new Set(action.payload.topics.map((t) => topicKey(t.topic)));
      const priorPrimed = state.primedTopics[sessionId];
      const nextState =
        priorPrimed && priorPrimed.length > 0
          ? {
              ...state,
              primedTopics: {
                ...state.primedTopics,
                [sessionId]: priorPrimed.filter((k) => stillSuggested.has(k)),
              },
            }
          : state;
      return updateSession(nextState, sessionId, (s) => {
        // Prepend the server-appended focus entry, de-duped by id (a reconnect snapshot
        // may already carry it, then an in-flight `activity` event re-delivers it). The
        // server owns the dedup/append decision; the client only obeys + caps.
        const focusHistory =
          entry && !s.focusHistory.some((e) => e.id === entry.id)
            ? [entry, ...s.focusHistory].slice(0, MAX_FOCUS)
            : s.focusHistory;
        return {
          ...s,
          summary: action.payload.summary,
          // Mirror the server's monotonic rule: a null graph keeps the existing storyline;
          // visibility is governed by workflowTurnSeq, not by nulling the content.
          graph: action.payload.graph ?? s.graph,
          workflowTurnSeq: action.payload.workflowTurnSeq,
          focusHistory,
          // Server already filtered out researched + in-flight topics before broadcasting.
          suggestedTopics: action.payload.topics,
          activityStatus: 'ready',
          activityError: null,
        };
      });
    }

    case 'activity_generating': {
      // Do NOT clear existing summary/graph — anti-flicker: old content stays
      // visible while a refresh is in-flight; only the badge changes.
      return updateSession(state, action.payload.sessionId, (s) => ({
        ...s,
        activityStatus: 'generating',
      }));
    }

    case 'activity_error': {
      return updateSession(state, action.payload.sessionId, (s) => ({
        ...s,
        activityStatus: 'error',
        activityError: action.payload.error,
      }));
    }

    case 'done': {
      // Keep the tab (persist done sessions); just mark it finished
      return updateSession(state, action.payload.sessionId, (s) => ({
        ...s,
        status: 'done',
        waitingReason: null,
        finishedAt: action.payload.finishedAt,
      }));
    }

    case 'waiting': {
      return updateSession(state, action.payload.sessionId, (s) => ({
        ...s,
        status: 'waiting',
        waitingReason: action.payload.reason,
      }));
    }

    case 'research_result': {
      const { sessionId, topic, lede, sections, links, ts } = action.payload;
      const key = topicKey(topic);
      let patched = updateSession(state, sessionId, (s) => ({
        ...s,
        research: [{ topic, lede, sections, links, ts }, ...s.research],
        // Mirror the server: drop the chip for the topic that just resolved.
        suggestedTopics: s.suggestedTopics.filter((t) => topicKey(t.topic) !== key),
      }));
      // Session not found → no-op (updateSession returned state unchanged).
      if (patched === state) return state;
      // The chip is gone — clear its primed dot too (it's about to render as a result card).
      const primedForSession = patched.primedTopics[sessionId];
      if (primedForSession?.includes(key)) {
        patched = {
          ...patched,
          primedTopics: {
            ...patched.primedTopics,
            [sessionId]: primedForSession.filter((k) => k !== key),
          },
        };
      }
      // Badge the Research tab unless you're already looking at it for this session. Results
      // only enter `research` on a user tap (prefetch warms a hidden cache, never auto-delivers
      // here), so a landed result always means "the briefing you asked for is ready."
      const viewingResearch =
        state.activeSessionId === sessionId && state.viewBySession[sessionId] === 'research';
      if (viewingResearch || patched.researchUnseen.includes(sessionId)) return patched;
      return { ...patched, researchUnseen: [...patched.researchUnseen, sessionId] };
    }

    case 'set_view': {
      const { sessionId, view } = action.payload;
      const viewBySession = { ...state.viewBySession, [sessionId]: view };
      // Opening Research marks its briefings seen.
      const researchUnseen =
        view === 'research'
          ? state.researchUnseen.filter((id) => id !== sessionId)
          : state.researchUnseen;
      return { ...state, viewBySession, researchUnseen };
    }

    case 'select_research': {
      const { sessionId, ts } = action.payload;
      return {
        ...state,
        selectedResearchBySession: { ...state.selectedResearchBySession, [sessionId]: ts },
      };
    }

    case 'research_primed': {
      const { sessionId, topic } = action.payload;
      const key = topicKey(topic);
      const cur = state.primedTopics[sessionId] ?? [];
      if (cur.includes(key)) return state; // idempotent (replay may re-deliver)
      return {
        ...state,
        primedTopics: { ...state.primedTopics, [sessionId]: [...cur, key] },
      };
    }

    case 'select': {
      const { sessionId } = action.payload;
      // Clicking a tab HOLDS the view — the dashboard stops following live prompts until you
      // click FOLLOW again (hard-hold model).
      return {
        ...state,
        followMode: 'held',
        activeSessionId: sessionId,
        unseenSessionIds: state.unseenSessionIds.filter((id) => id !== sessionId),
      };
    }

    case 'close': {
      const { sessionId } = action.payload;
      const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
      const closedSessionIds = [...state.closedSessionIds, sessionId];
      const unseenSessionIds = state.unseenSessionIds.filter((id) => id !== sessionId);
      const fallback = sessions.length > 0 ? sessions[sessions.length - 1].sessionId : null;
      // Never let activeSessionId or liveSessionId point at the removed tab — that would blank
      // the view / strand FOLLOW on a non-visible id (D6). Repoint both off the closed id.
      const activeWasClosed = state.activeSessionId === sessionId;
      const activeSessionId = activeWasClosed ? fallback : state.activeSessionId;
      const liveSessionId = state.liveSessionId === sessionId ? fallback : state.liveSessionId;
      // Closing the tab you were holding resumes follow — you're done holding it.
      const followMode = activeWasClosed ? 'follow' : state.followMode;
      // Drop the closed session's primed dots (server also clears its prefetch cache).
      const primedTopics = { ...state.primedTopics };
      delete primedTopics[sessionId];
      // Spread ...state (D2): a bare literal would silently drop followMode/liveSessionId.
      return {
        ...state,
        sessions,
        activeSessionId,
        liveSessionId,
        followMode,
        unseenSessionIds,
        closedSessionIds,
        primedTopics,
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

interface ProviderStatus {
  provider: string | null;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Fetch provider status once on mount
  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then((d: { provider?: string | null }) =>
        setProviderStatus({ provider: d.provider ?? null }),
      )
      .catch(() => setProviderStatus({ provider: null }));
  }, []);

  // SSE data comes from an untyped external stream; we cast the payloads and let the
  // reducer's discriminated-union matching enforce correctness at runtime. Constrained to
  // payload-bearing actions ('follow' carries no payload and is dispatched directly).
  type WithPayload = Extract<Action, { payload: unknown }>;
  type P<T extends WithPayload['type']> = Extract<WithPayload, { type: T }>['payload'];
  const connectionStatus: ConnectionStatus = useSSE({
    snapshot: (data) => dispatch({ type: 'snapshot', payload: data as SnapshotPayload }),
    task: (data) => dispatch({ type: 'task', payload: data as P<'task'> }),
    active: (data) => dispatch({ type: 'active', payload: data as P<'active'> }),
    touch: (data) => dispatch({ type: 'touch', payload: data as P<'touch'> }),
    activity: (data) => dispatch({ type: 'activity', payload: data as P<'activity'> }),
    activity_generating: (data) =>
      dispatch({ type: 'activity_generating', payload: data as P<'activity_generating'> }),
    activity_error: (data) =>
      dispatch({ type: 'activity_error', payload: data as P<'activity_error'> }),
    done: (data) => dispatch({ type: 'done', payload: data as P<'done'> }),
    waiting: (data) => dispatch({ type: 'waiting', payload: data as P<'waiting'> }),
    research_result: (data) =>
      dispatch({ type: 'research_result', payload: data as P<'research_result'> }),
    research_primed: (data) =>
      dispatch({ type: 'research_primed', payload: data as P<'research_primed'> }),
  });

  const activeSession = state.sessions.find((s) => s.sessionId === state.activeSessionId) ?? null;
  const showNoBanner =
    !bannerDismissed && providerStatus !== null && providerStatus.provider === null;

  // View switching (Focus ⇄ Research). The strip appears only once the active session has a
  // briefing (D5); before that, today's plain Focus layout is unchanged. View is read
  // per-session and falls back to Focus, so switching/auto-following sessions never strands you
  // on another session's research (D6).
  const activeId = activeSession?.sessionId ?? null;
  const showViewTabs = (activeSession?.research.length ?? 0) > 0;
  const view: SessionView =
    showViewTabs && activeId && state.viewBySession[activeId] === 'research' ? 'research' : 'focus';
  const hasUnseenResearch = !!activeId && state.researchUnseen.includes(activeId);
  const focusPanelProps: React.HTMLAttributes<HTMLDivElement> = showViewTabs
    ? { role: 'tabpanel', id: 'view-panel-focus', 'aria-labelledby': 'view-tab-focus' }
    : {};

  // D6: viewed-session 30s poll — only for the tab the user is looking at.
  // Fires immediately on tab switch (catches up after a background session becomes active),
  // then every 30s while the session is still working. Stops when done/waiting.
  useEffect(() => {
    if (!activeSession || activeSession.status !== 'working') return;
    const sessionId = activeSession.sessionId;

    const poll = () => {
      void fetch('/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    };

    // Immediate fire on mount / tab-switch
    poll();
    const timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  }, [activeSession?.sessionId, activeSession?.status]);

  return (
    <div className="app">
      <TaskHeader
        session={activeSession}
        connectionStatus={connectionStatus}
        provider={providerStatus?.provider ?? null}
      />

      {showNoBanner && (
        <div className="provider-banner" role="alert">
          <span>
            No LLM provider configured — activity summary and research are disabled.{' '}
            <code>npm run setup</code>
          </span>
          <button
            className="provider-banner__dismiss"
            onClick={() => setBannerDismissed(true)}
            aria-label="Dismiss provider warning"
            type="button"
          >
            ×
          </button>
        </div>
      )}

      <div className="app__body">
        <SessionTabs
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          liveSessionId={state.liveSessionId}
          followMode={state.followMode}
          unseenSessionIds={state.unseenSessionIds}
          onFollow={() => dispatch({ type: 'follow' })}
          onSelect={(id) => dispatch({ type: 'select', payload: { sessionId: id } })}
          onClose={(id) => {
            // Local: drop the tab now. Server: persist a `closed` flag so it stays
            // dismissed across reloads/restarts (snapshot filters closed sessions out).
            dispatch({ type: 'close', payload: { sessionId: id } });
            void fetch('/close', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: id }),
            });
          }}
        />

        <main className="app__main">
          {showViewTabs && (
            <ViewTabs
              view={view}
              hasUnseenResearch={hasUnseenResearch}
              onSelect={(v) =>
                activeId &&
                dispatch({ type: 'set_view', payload: { sessionId: activeId, view: v } })
              }
            />
          )}

          {view === 'research' && activeSession ? (
            <ErrorBoundary>
              <ResearchTab
                key={activeId ?? 'none'}
                results={activeSession.research}
                selectedTs={
                  (activeId ? state.selectedResearchBySession[activeId] : undefined) ??
                  activeSession.research[0]?.ts ??
                  null
                }
                onSelect={(ts) =>
                  activeId &&
                  dispatch({ type: 'select_research', payload: { sessionId: activeId, ts } })
                }
              />
            </ErrorBoundary>
          ) : (
            <div className="app__focus-grid" {...focusPanelProps}>
              <div className="app__left">
                <ErrorBoundary>
                  <SummaryPanel
                    summary={activeSession?.summary ?? null}
                    focusHistory={activeSession?.focusHistory ?? []}
                    status={activeSession?.activityStatus ?? 'idle'}
                    error={activeSession?.activityError ?? null}
                    sessionStatus={activeSession?.status ?? null}
                    graph={activeSession?.graph ?? null}
                    showWorkflow={activeSession ? isWorkflowVisible(activeSession) : false}
                  />
                </ErrorBoundary>
              </div>

              <div className="app__right">
                <ErrorBoundary>
                  <TouchPoints touchPoints={activeSession?.touchPoints ?? []} />
                </ErrorBoundary>
                <ErrorBoundary>
                  <ResearchPanel
                    results={activeSession?.research ?? []}
                    suggestedTopics={activeSession?.suggestedTopics ?? []}
                    primedTopics={(activeId && state.primedTopics[activeId]) || []}
                    activityStatus={activeSession?.activityStatus ?? 'idle'}
                    sessionId={activeSession?.sessionId ?? null}
                    onOpenResearch={(ts) => {
                      if (!activeId) return;
                      dispatch({ type: 'select_research', payload: { sessionId: activeId, ts } });
                      dispatch({
                        type: 'set_view',
                        payload: { sessionId: activeId, view: 'research' },
                      });
                    }}
                  />
                </ErrorBoundary>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
