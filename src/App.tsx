import React, { useEffect, useReducer, useState } from 'react';
import type {
  Session,
  TouchPoint,
  ResearchResult,
  SuggestedTopic,
  FocusEntry,
  SnapshotPayload,
} from './types';
import { newSession, MAX_FOCUS } from './types';
import { useSSE } from './hooks/useSSE';
import type { ConnectionStatus } from './hooks/useSSE';
import { TaskHeader } from './components/TaskHeader';
import { SummaryPanel } from './components/SummaryPanel';
import { GraphPanel } from './components/GraphPanel';
import { TouchPoints } from './components/TouchPoints';
import { ResearchPanel } from './components/ResearchPanel';
import { SessionTabs } from './components/SessionTabs';
import { ErrorBoundary } from './components/ErrorBoundary';

// ---------------------------------------------------------------------------
// State management — simple reducer so SSE events map cleanly to state updates
// ---------------------------------------------------------------------------

type State = {
  sessions: Session[]; // working + done, in start order
  activeSessionId: string | null;
  unseenSessionIds: string[]; // tabs added in the background, not yet viewed
  closedSessionIds: string[]; // tabs the user dismissed (filtered from snapshots)
};

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
        graph: string;
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
  | { type: 'select'; payload: { sessionId: string } }
  | { type: 'close'; payload: { sessionId: string } };

export const initialState: State = {
  sessions: [],
  activeSessionId: null,
  unseenSessionIds: [],
  closedSessionIds: [],
};

export function isActiveSession(state: State, sessionId: string): boolean {
  return state.activeSessionId === sessionId;
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
      // Preserve current active tab if still present; else use server's hint; else last; else null
      const activeSessionId = ids.has(state.activeSessionId ?? '')
        ? state.activeSessionId
        : ids.has(payloadActive ?? '')
          ? payloadActive
          : sessions.length > 0
            ? sessions[sessions.length - 1].sessionId
            : null;
      // Drop unseen ids that are no longer present or are now the active tab
      const unseenSessionIds = state.unseenSessionIds.filter(
        (id) => ids.has(id) && id !== activeSessionId,
      );
      return { ...state, sessions, activeSessionId, unseenSessionIds };
    }

    case 'task': {
      const { sessionId, prompt, prompts, startedAt } = action.payload;
      const existing = state.sessions.find((s) => s.sessionId === sessionId);
      if (existing) {
        // Same session_id, new turn (or a waiting→working resume, or a snapshot/task race).
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
      const session = newSession(sessionId, prompt, startedAt);
      if (prompts) session.prompts = prompts;
      const sessions = [...state.sessions, session];
      // First session → activate (seen). Otherwise keep current view + mark unseen.
      if (state.activeSessionId === null) {
        return { ...state, sessions, activeSessionId: sessionId };
      }
      return {
        ...state,
        sessions,
        unseenSessionIds: [...state.unseenSessionIds, sessionId],
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
      return updateSession(state, action.payload.sessionId, (s) => {
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
          graph: action.payload.graph,
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
      const { sessionId, topic, summary, links, ts } = action.payload;
      const key = topic.trim().toLowerCase();
      return updateSession(state, sessionId, (s) => ({
        ...s,
        research: [{ topic, summary, links, ts }, ...s.research],
        // Mirror the server: drop the chip for the topic that just resolved.
        suggestedTopics: s.suggestedTopics.filter((t) => t.topic.trim().toLowerCase() !== key),
      }));
    }

    case 'select': {
      const { sessionId } = action.payload;
      return {
        ...state,
        activeSessionId: sessionId,
        unseenSessionIds: state.unseenSessionIds.filter((id) => id !== sessionId),
      };
    }

    case 'close': {
      const { sessionId } = action.payload;
      const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
      const closedSessionIds = [...state.closedSessionIds, sessionId];
      const unseenSessionIds = state.unseenSessionIds.filter((id) => id !== sessionId);
      // Reassign active if the closed tab was active
      let activeSessionId = state.activeSessionId;
      if (activeSessionId === sessionId) {
        activeSessionId = sessions.length > 0 ? sessions[sessions.length - 1].sessionId : null;
      }
      return { sessions, activeSessionId, unseenSessionIds, closedSessionIds };
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
  // reducer's discriminated-union matching enforce correctness at runtime.
  type P<T extends Action['type']> = Extract<Action, { type: T }>['payload'];
  const connectionStatus: ConnectionStatus = useSSE({
    snapshot: (data) => dispatch({ type: 'snapshot', payload: data as SnapshotPayload }),
    task: (data) => dispatch({ type: 'task', payload: data as P<'task'> }),
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
  });

  const activeSession = state.sessions.find((s) => s.sessionId === state.activeSessionId) ?? null;
  const showNoBanner =
    !bannerDismissed && providerStatus !== null && providerStatus.provider === null;

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
          unseenSessionIds={state.unseenSessionIds}
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
          <div className="app__left">
            <ErrorBoundary>
              <SummaryPanel
                summary={activeSession?.summary ?? null}
                focusHistory={activeSession?.focusHistory ?? []}
                status={activeSession?.activityStatus ?? 'idle'}
                error={activeSession?.activityError ?? null}
                sessionStatus={activeSession?.status ?? null}
              />
            </ErrorBoundary>
            <ErrorBoundary>
              <GraphPanel
                graph={activeSession?.graph ?? null}
                activityStatus={activeSession?.activityStatus ?? 'idle'}
                activityError={activeSession?.activityError ?? null}
                sessionStatus={activeSession?.status ?? null}
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
                activityStatus={activeSession?.activityStatus ?? 'idle'}
                sessionId={activeSession?.sessionId ?? null}
              />
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
