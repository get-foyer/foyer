import React, { useCallback, useReducer } from 'react';
import type { Session, TouchPoint, ResearchResult } from './types';
import { useSSE } from './hooks/useSSE';
import { TaskHeader } from './components/TaskHeader';
import { PlanPanel } from './components/PlanPanel';
import { GraphPanel } from './components/GraphPanel';
import { TouchPoints } from './components/TouchPoints';
import { ResearchPanel } from './components/ResearchPanel';

// ---------------------------------------------------------------------------
// State management — simple reducer so SSE events map cleanly to state updates
// ---------------------------------------------------------------------------

type State = {
  session: Session | null;
};

type Action =
  | { type: 'snapshot'; payload: Session | null }
  | { type: 'task'; payload: { sessionId: string; prompt: string; startedAt: number } }
  | { type: 'touch'; payload: { sessionId: string } & TouchPoint }
  | { type: 'plan'; payload: { sessionId: string; plan: string } }
  | { type: 'graph'; payload: { sessionId: string; graph: string } }
  | { type: 'graph_error'; payload: { sessionId: string; error: string } }
  | { type: 'graph_generating'; payload: { sessionId: string } }
  | { type: 'done'; payload: { sessionId: string; finishedAt: number } }
  | { type: 'research_result'; payload: ResearchResult & { sessionId: string; topic: string } };

function isActiveSession(state: State, sessionId: string): boolean {
  return state.session?.sessionId === sessionId;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot':
      return { session: action.payload };

    case 'task': {
      const { sessionId, prompt, startedAt } = action.payload;
      const next: Session = {
        sessionId,
        status: 'working',
        prompt,
        plan: null,
        graph: null,
        graphStatus: 'idle',
        graphError: null,
        touchPoints: [],
        research: [],
        startedAt,
        finishedAt: null,
      };
      return { session: next };
    }

    case 'touch': {
      if (!isActiveSession(state, action.payload.sessionId)) return state;
      const { path, tool, ts } = action.payload;
      const session = state.session!;
      return {
        session: {
          ...session,
          touchPoints: [{ path, tool, ts }, ...session.touchPoints],
        },
      };
    }

    case 'plan': {
      if (!isActiveSession(state, action.payload.sessionId)) return state;
      return {
        session: { ...state.session!, plan: action.payload.plan },
      };
    }

    case 'graph': {
      if (!isActiveSession(state, action.payload.sessionId)) return state;
      return {
        session: {
          ...state.session!,
          graph: action.payload.graph,
          graphStatus: 'ready',
          graphError: null,
        },
      };
    }

    case 'graph_error': {
      if (!isActiveSession(state, action.payload.sessionId)) return state;
      return {
        session: {
          ...state.session!,
          graphStatus: 'error',
          graphError: action.payload.error,
        },
      };
    }

    case 'graph_generating': {
      if (!isActiveSession(state, action.payload.sessionId)) return state;
      return {
        session: { ...state.session!, graphStatus: 'generating' },
      };
    }

    case 'done': {
      if (!isActiveSession(state, action.payload.sessionId)) return state;
      return {
        session: {
          ...state.session!,
          status: 'done',
          finishedAt: action.payload.finishedAt,
        },
      };
    }

    case 'research_result': {
      if (!state.session) return state;
      const { sessionId, topic, summary, links, ts } = action.payload;
      if (!isActiveSession(state, sessionId)) return state;
      const newResult: ResearchResult = { topic, summary, links, ts };
      return {
        session: {
          ...state.session,
          research: [newResult, ...state.session.research],
        },
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [state, dispatch] = useReducer(reducer, { session: null });

  // SSE data comes from an untyped external stream; we cast the payloads and let the
  // reducer's discriminated-union matching enforce correctness at runtime.
  type P<T extends Action['type']> = Extract<Action, { type: T }>['payload'];
  useSSE({
    snapshot: (data) => dispatch({ type: 'snapshot', payload: data as Session | null }),
    task: (data) => dispatch({ type: 'task', payload: data as P<'task'> }),
    touch: (data) => dispatch({ type: 'touch', payload: data as P<'touch'> }),
    plan: (data) => dispatch({ type: 'plan', payload: data as P<'plan'> }),
    graph: (data) => dispatch({ type: 'graph', payload: data as P<'graph'> }),
    graph_error: (data) => dispatch({ type: 'graph_error', payload: data as P<'graph_error'> }),
    graph_generating: (data) => dispatch({ type: 'graph_generating', payload: data as P<'graph_generating'> }),
    done: (data) => dispatch({ type: 'done', payload: data as P<'done'> }),
    research_result: (data) => dispatch({ type: 'research_result', payload: data as P<'research_result'> }),
  });

  const { session } = state;

  return (
    <div className="app">
      <TaskHeader session={session} />

      <main className="app__main">
        <div className="app__left">
          <PlanPanel plan={session?.plan ?? null} />
          <GraphPanel
            graph={session?.graph ?? null}
            graphStatus={session?.graphStatus ?? 'idle'}
            graphError={session?.graphError ?? null}
          />
        </div>

        <div className="app__right">
          <TouchPoints touchPoints={session?.touchPoints ?? []} />
          <ResearchPanel results={session?.research ?? []} />
        </div>
      </main>
    </div>
  );
}
