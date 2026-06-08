import { describe, it, expect } from 'vitest';
import type { Session, FocusEntry } from './types';
import { MAX_FOCUS } from './types';
import { reducer, initialState, isActiveSession } from './App';

/** Build a FocusEntry for reducer tests. */
function makeEntry(over: Partial<FocusEntry> = {}): FocusEntry {
  return { id: 'a-1', summary: 's', ts: 1, turnSeq: 1, turnPrompt: 'p', ...over };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-abc',
    status: 'working',
    prompt: 'test prompt',
    prompts: ['test prompt'],
    turnSeq: 1,
    summary: null,
    focusHistory: [],
    graph: null,
    workflowTurnSeq: null,
    activityStatus: 'idle',
    activityError: null,
    waitingReason: null,
    touchPoints: [],
    research: [],
    suggestedTopics: [],
    startedAt: 1000,
    finishedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// reducer — snapshot
// ---------------------------------------------------------------------------

describe('reducer — snapshot', () => {
  it('populates sessions from payload', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const next = reducer(initialState, {
      type: 'snapshot',
      payload: { sessions: [a, b], activeSessionId: 'a' },
    });
    expect(next.sessions).toHaveLength(2);
    expect(next.activeSessionId).toBe('a');
  });

  it('HELD mode preserves the current active tab on reconnect (no yank)', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'b',
      followMode: 'held' as const,
    };
    const next = reducer(state, {
      type: 'snapshot',
      payload: { sessions: [a, b], activeSessionId: 'a' },
    });
    // Held: keep 'b' even though the server says 'a' is live; track 'a' as the live pointer.
    expect(next.activeSessionId).toBe('b');
    expect(next.liveSessionId).toBe('a');
  });

  it('FOLLOW mode catches up to a visible live session on reconnect (D4)', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'b',
      followMode: 'follow' as const,
    };
    const next = reducer(state, {
      type: 'snapshot',
      payload: { sessions: [a, b], activeSessionId: 'a' },
    });
    // Follow: a reconnect may have missed `active` events → land on the live session.
    expect(next.activeSessionId).toBe('a');
    expect(next.liveSessionId).toBe('a');
  });

  it('does not track a non-visible payload active as the live pointer', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = {
      ...initialState,
      sessions: [a],
      activeSessionId: 'a',
      liveSessionId: 'a',
      followMode: 'follow' as const,
    };
    const next = reducer(state, {
      type: 'snapshot',
      // server names 'ghost' (a closed session lingering in its activeSessionId) — not in payload
      payload: { sessions: [a], activeSessionId: 'ghost' },
    });
    expect(next.liveSessionId).toBe('a'); // unchanged — never follow a non-visible id
    expect(next.activeSessionId).toBe('a');
  });

  it('falls back to payload activeSessionId when current is gone', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'gone' };
    const next = reducer(state, {
      type: 'snapshot',
      payload: { sessions: [a, b], activeSessionId: 'a' },
    });
    expect(next.activeSessionId).toBe('a');
  });

  it('falls back to last session when both active ids are absent', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'gone' };
    const next = reducer(state, {
      type: 'snapshot',
      payload: { sessions: [a, b], activeSessionId: null },
    });
    expect(next.activeSessionId).toBe('b');
  });

  it('sets activeSessionId to null when sessions is empty', () => {
    const next = reducer(initialState, {
      type: 'snapshot',
      payload: { sessions: [], activeSessionId: null },
    });
    expect(next.activeSessionId).toBeNull();
    expect(next.sessions).toHaveLength(0);
  });

  it('filters out closedSessionIds from snapshot', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, closedSessionIds: ['b'] };
    const next = reducer(state, {
      type: 'snapshot',
      payload: { sessions: [a, b], activeSessionId: 'a' },
    });
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0].sessionId).toBe('a');
  });

  it('drops unseenSessionIds that are no longer present after snapshot', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], unseenSessionIds: ['gone'] };
    const next = reducer(state, {
      type: 'snapshot',
      payload: { sessions: [a], activeSessionId: 'a' },
    });
    expect(next.unseenSessionIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reducer — task
// ---------------------------------------------------------------------------

describe('reducer — task', () => {
  it('first task: activates the session, not marked unseen', () => {
    const next = reducer(initialState, {
      type: 'task',
      payload: { sessionId: 'sess-1', prompt: 'do something', startedAt: 9999 },
    });
    expect(next.sessions).toHaveLength(1);
    expect(next.activeSessionId).toBe('sess-1');
    expect(next.unseenSessionIds).toHaveLength(0);
    expect(next.sessions[0]).toMatchObject({
      sessionId: 'sess-1',
      status: 'working',
      prompt: 'do something',
      startedAt: 9999,
      summary: null,
      graph: null,
      touchPoints: [],
      research: [],
    });
  });

  it('background task: appends tab, keeps current view, marks unseen', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'task',
      payload: { sessionId: 'b', prompt: 'second task', startedAt: 2000 },
    });
    expect(next.sessions).toHaveLength(2);
    expect(next.activeSessionId).toBe('a'); // focus stays on 'a'
    expect(next.unseenSessionIds).toContain('b');
  });

  it('dedupes: no-op when the same session is already working with the same latest prompt', () => {
    const a = makeSession({ sessionId: 'a' }); // prompt defaults to 'test prompt'
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'task',
      payload: { sessionId: 'a', prompt: 'test prompt', startedAt: 5000 },
    });
    // Identical latest prompt while working → referential equality (no re-render churn)
    expect(next).toBe(state);
  });

  it('task on a waiting session clears waiting → working', () => {
    const a = makeSession({
      sessionId: 'a',
      status: 'waiting',
      waitingReason: 'Permission requested',
    });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'task',
      payload: { sessionId: 'a', prompt: 'resumed', startedAt: 5000 },
    });
    expect(next.sessions[0].status).toBe('working');
    expect(next.sessions[0].waitingReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reducer — task continuation (multi-turn: persist the session, don't reset)
// ---------------------------------------------------------------------------

describe('reducer — task continuation', () => {
  it('reopens a done session in place: adopts server prompts, working, finishedAt cleared, PRESERVES summary/graph/touchPoints', () => {
    const a = makeSession({
      sessionId: 'a',
      status: 'done',
      finishedAt: 5000,
      prompt: 'build login',
      prompts: ['build login'],
      summary: 'Built the login form',
      graph: 'graph LR\n  G(["Build login"]):::goal',
      touchPoints: [{ path: '/src/login.ts', tool: 'Write', ts: 1 }],
    });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'task',
      payload: {
        sessionId: 'a',
        prompt: 'now add tests',
        prompts: ['build login', 'now add tests'],
        startedAt: 6000,
      },
    });
    const s = next.sessions[0];
    expect(s.status).toBe('working');
    expect(s.finishedAt).toBeNull();
    expect(s.prompt).toBe('now add tests');
    expect(s.prompts).toEqual(['build login', 'now add tests']);
    // Accumulated state preserved across the turn
    expect(s.summary).toBe('Built the login form');
    expect(s.graph).toBe('graph LR\n  G(["Build login"]):::goal');
    expect(s.touchPoints).toHaveLength(1);
  });

  it('continues a working session with a NEW prompt in place (not a no-op)', () => {
    const a = makeSession({
      sessionId: 'a',
      prompt: 'first',
      prompts: ['first'],
      summary: 'did first',
    });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'task',
      payload: { sessionId: 'a', prompt: 'second', prompts: ['first', 'second'], startedAt: 2000 },
    });
    expect(next).not.toBe(state);
    expect(next.sessions[0].prompt).toBe('second');
    expect(next.sessions[0].prompts).toEqual(['first', 'second']);
    expect(next.sessions[0].summary).toBe('did first'); // preserved
  });

  it('uses server prompts as source of truth: task then snapshot converge (no drift)', () => {
    const a = makeSession({ sessionId: 'a', prompt: 'first', prompts: ['first'] });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const afterTask = reducer(state, {
      type: 'task',
      payload: { sessionId: 'a', prompt: 'second', prompts: ['first', 'second'], startedAt: 2000 },
    });
    const server = makeSession({ sessionId: 'a', prompt: 'second', prompts: ['first', 'second'] });
    const afterSnapshot = reducer(afterTask, {
      type: 'snapshot',
      payload: { sessions: [server], activeSessionId: 'a' },
    });
    expect(afterSnapshot.sessions[0].prompts).toEqual(['first', 'second']);
  });

  it('a task arriving while generating adopts the server arc and keeps generating', () => {
    const a = makeSession({
      sessionId: 'a',
      prompt: 'first',
      prompts: ['first'],
      status: 'working',
      activityStatus: 'generating',
    });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'task',
      payload: { sessionId: 'a', prompt: 'second', prompts: ['first', 'second'], startedAt: 2000 },
    });
    expect(next.sessions[0].prompts).toEqual(['first', 'second']);
    expect(next.sessions[0].activityStatus).toBe('generating'); // preserved
  });
});

// ---------------------------------------------------------------------------
// reducer — update actions on non-active sessions
// ---------------------------------------------------------------------------

describe('reducer — background session updates', () => {
  it('touch updates a non-active session', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'touch',
      payload: { sessionId: 'b', path: '/src/foo.ts', tool: 'Write', ts: 3000 },
    });
    const bNext = next.sessions.find((s) => s.sessionId === 'b')!;
    expect(bNext.touchPoints).toHaveLength(1);
    expect(bNext.touchPoints[0]).toEqual({ path: '/src/foo.ts', tool: 'Write', ts: 3000 });
    // Session 'a' untouched
    expect(next.sessions.find((s) => s.sessionId === 'a')!.touchPoints).toHaveLength(0);
  });

  it('activity updates a non-active session', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'activity',
      payload: {
        sessionId: 'b',
        summary: '# Plan B',
        graph: 'graph TD\n  A-->B',
        workflowTurnSeq: 1,
        topics: [],
      },
    });
    const bNext = next.sessions.find((s) => s.sessionId === 'b')!;
    expect(bNext.summary).toBe('# Plan B');
    expect(bNext.graph).toBe('graph TD\n  A-->B');
    expect(bNext.workflowTurnSeq).toBe(1);
    expect(bNext.activityStatus).toBe('ready');
    expect(next.sessions.find((s) => s.sessionId === 'a')!.summary).toBeNull();
  });

  it('unknown sessionId is a no-op (returns same state reference)', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const actions = [
      { type: 'touch' as const, payload: { sessionId: 'x', path: '/x', tool: 'Write', ts: 0 } },
      {
        type: 'activity' as const,
        payload: { sessionId: 'x', summary: 'S', graph: 'G', workflowTurnSeq: 1, topics: [] },
      },
      { type: 'activity_error' as const, payload: { sessionId: 'x', error: 'X' } },
      { type: 'activity_generating' as const, payload: { sessionId: 'x' } },
      { type: 'done' as const, payload: { sessionId: 'x', finishedAt: 0 } },
      { type: 'waiting' as const, payload: { sessionId: 'x', reason: 'X' } },
      {
        type: 'research_result' as const,
        payload: {
          sessionId: 'x',
          topic: 'T',
          lede: '',
          sections: [{ heading: '', body: 'S' }],
          links: [],
          ts: 0,
        },
      },
    ];
    for (const action of actions) {
      expect(reducer(state, action)).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// reducer — activity lifecycle
// ---------------------------------------------------------------------------

describe('reducer — activity lifecycle', () => {
  it('activity_generating / activity / activity_error status transitions', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };

    const generating = reducer(state, { type: 'activity_generating', payload: { sessionId: 'a' } });
    expect(generating.sessions[0].activityStatus).toBe('generating');

    // Anti-flicker: existing summary/graph preserved during regenerate
    const withSummary = makeSession({
      sessionId: 'a',
      summary: 'previous summary',
      graph: 'graph TD\n  A-->B',
      activityStatus: 'ready',
    });
    const stateWithSummary = { ...initialState, sessions: [withSummary], activeSessionId: 'a' };
    const regenerating = reducer(stateWithSummary, {
      type: 'activity_generating',
      payload: { sessionId: 'a' },
    });
    expect(regenerating.sessions[0].activityStatus).toBe('generating');
    // Old content preserved
    expect(regenerating.sessions[0].summary).toBe('previous summary');
    expect(regenerating.sessions[0].graph).toBe('graph TD\n  A-->B');

    const ready = reducer(generating, {
      type: 'activity',
      payload: {
        sessionId: 'a',
        summary: 'Agent refactoring',
        graph: 'graph TD; A-->B',
        workflowTurnSeq: 1,
        topics: [{ topic: 'React useTransition', reason: 'in App.tsx' }],
      },
    });
    expect(ready.sessions[0].activityStatus).toBe('ready');
    expect(ready.sessions[0].summary).toBe('Agent refactoring');
    expect(ready.sessions[0].graph).toBe('graph TD; A-->B');
    expect(ready.sessions[0].workflowTurnSeq).toBe(1);
    expect(ready.sessions[0].activityError).toBeNull();
    // activity carries the server-filtered suggested topics
    expect(ready.sessions[0].suggestedTopics.map((t) => t.topic)).toEqual(['React useTransition']);

    const errored = reducer(state, {
      type: 'activity_error',
      payload: { sessionId: 'a', error: 'LLM timeout' },
    });
    expect(errored.sessions[0].activityStatus).toBe('error');
    expect(errored.sessions[0].activityError).toBe('LLM timeout');
  });

  it('sets workflowTurnSeq and keeps the prior graph when the server reports a null graph (monotonic)', () => {
    const a = makeSession({
      sessionId: 'a',
      turnSeq: 1,
      graph: 'graph LR\n  A:::goal',
      workflowTurnSeq: 1,
    });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    // A quieter tick reports graph: null, but the server keeps the storyline (monotonic) and
    // workflowTurnSeq stays === turnSeq, so the fold-in remains visible with the prior graph.
    const next = reducer(state, {
      type: 'activity',
      payload: {
        sessionId: 'a',
        summary: 'still going',
        graph: null,
        workflowTurnSeq: 1,
        topics: [],
      },
    });
    expect(next.sessions[0].graph).toBe('graph LR\n  A:::goal'); // prior graph preserved
    expect(next.sessions[0].workflowTurnSeq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// reducer — activity focus history
// ---------------------------------------------------------------------------

describe('reducer — activity focus history', () => {
  it('prepends the server entry to focusHistory (newest first)', () => {
    const a = makeSession({
      sessionId: 'a',
      focusHistory: [makeEntry({ id: 'a-1', summary: 'old' })],
    });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'activity',
      payload: {
        sessionId: 'a',
        summary: 'new',
        graph: 'g',
        workflowTurnSeq: null,
        topics: [],
        entry: makeEntry({ id: 'a-2', summary: 'new' }),
      },
    });
    expect(next.sessions[0].focusHistory.map((e) => e.id)).toEqual(['a-2', 'a-1']);
  });

  it('de-dupes an entry already present by id (snapshot + in-flight SSE)', () => {
    const a = makeSession({ sessionId: 'a', focusHistory: [makeEntry({ id: 'a-1' })] });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'activity',
      payload: {
        sessionId: 'a',
        summary: 's',
        graph: 'g',
        workflowTurnSeq: null,
        topics: [],
        entry: makeEntry({ id: 'a-1' }),
      },
    });
    expect(next.sessions[0].focusHistory).toHaveLength(1);
  });

  it('leaves focusHistory untouched when no entry is present', () => {
    const a = makeSession({ sessionId: 'a', focusHistory: [makeEntry({ id: 'a-1' })] });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'activity',
      payload: { sessionId: 'a', summary: 'fresh', graph: 'g', workflowTurnSeq: null, topics: [] },
    });
    expect(next.sessions[0].focusHistory).toHaveLength(1);
    expect(next.sessions[0].summary).toBe('fresh'); // live summary still updates
  });

  it('caps focusHistory at MAX_FOCUS', () => {
    const full = Array.from({ length: MAX_FOCUS }, (_, i) => makeEntry({ id: `a-${i}` }));
    const a = makeSession({ sessionId: 'a', focusHistory: full });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'activity',
      payload: {
        sessionId: 'a',
        summary: 's',
        graph: 'g',
        workflowTurnSeq: null,
        topics: [],
        entry: makeEntry({ id: 'a-new' }),
      },
    });
    expect(next.sessions[0].focusHistory).toHaveLength(MAX_FOCUS);
    expect(next.sessions[0].focusHistory[0].id).toBe('a-new');
  });
});

// ---------------------------------------------------------------------------
// reducer — done (keep tab)
// ---------------------------------------------------------------------------

describe('reducer — done', () => {
  it('marks session done and keeps the tab', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, { type: 'done', payload: { sessionId: 'a', finishedAt: 5000 } });
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0].status).toBe('done');
    expect(next.sessions[0].finishedAt).toBe(5000);
    expect(next.activeSessionId).toBe('a'); // still active
  });
});

// ---------------------------------------------------------------------------
// reducer — waiting
// ---------------------------------------------------------------------------

describe('reducer — waiting', () => {
  it('sets status to waiting and stores the reason', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'waiting',
      payload: { sessionId: 'a', reason: 'Permission requested: run bash' },
    });
    expect(next.sessions[0].status).toBe('waiting');
    expect(next.sessions[0].waitingReason).toBe('Permission requested: run bash');
  });

  it('a subsequent touch clears waiting → working and nulls the reason', () => {
    const a = makeSession({
      sessionId: 'a',
      status: 'waiting',
      waitingReason: 'permission needed',
    });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'touch',
      payload: { sessionId: 'a', path: '/src/foo.ts', tool: 'Write', ts: 2000 },
    });
    expect(next.sessions[0].status).toBe('working');
    expect(next.sessions[0].waitingReason).toBeNull();
  });

  it('a subsequent task clears waiting → working', () => {
    const a = makeSession({ sessionId: 'a', status: 'waiting', waitingReason: 'idle' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'task',
      payload: { sessionId: 'a', prompt: 'resumed task', startedAt: 1000 },
    });
    expect(next.sessions[0].status).toBe('working');
    expect(next.sessions[0].waitingReason).toBeNull();
  });

  it('done over a waiting session sets status done and clears reason', () => {
    const a = makeSession({ sessionId: 'a', status: 'waiting', waitingReason: 'permission' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'done',
      payload: { sessionId: 'a', finishedAt: 5000 },
    });
    expect(next.sessions[0].status).toBe('done');
    expect(next.sessions[0].waitingReason).toBeNull();
  });

  it('unknown sessionId is a no-op', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'waiting',
      payload: { sessionId: 'x', reason: 'some reason' },
    });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// reducer — research_result
// ---------------------------------------------------------------------------

describe('reducer — research_result', () => {
  it('prepends result to the target session', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'research_result',
      payload: {
        sessionId: 'a',
        topic: 'React hooks',
        lede: '',
        sections: [{ heading: '', body: 'Summary.' }],
        links: [],
        ts: 3000,
      },
    });
    expect(next.sessions[0].research).toHaveLength(1);
    expect(next.sessions[0].research[0].topic).toBe('React hooks');
  });

  it('removes the matching suggested topic chip (case-insensitive)', () => {
    const a = makeSession({
      sessionId: 'a',
      suggestedTopics: [
        { topic: 'React hooks', reason: 'x' },
        { topic: 'Mermaid graph LR', reason: 'y' },
      ],
    });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'research_result',
      payload: {
        sessionId: 'a',
        topic: 'react HOOKS',
        lede: '',
        sections: [{ heading: '', body: 'S' }],
        links: [],
        ts: 3000,
      },
    });
    expect(next.sessions[0].suggestedTopics.map((t) => t.topic)).toEqual(['Mermaid graph LR']);
  });

  it('badges the Research tab unseen when you are NOT viewing it', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' }; // view defaults to focus
    const next = reducer(state, {
      type: 'research_result',
      payload: {
        sessionId: 'a',
        topic: 'T',
        lede: '',
        sections: [{ heading: '', body: 'S' }],
        links: [],
        ts: 3000,
      },
    });
    expect(next.researchUnseen).toContain('a');
  });

  it('does NOT badge when you are already viewing that session’s Research tab', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = {
      ...initialState,
      sessions: [a],
      activeSessionId: 'a',
      viewBySession: { a: 'research' as const },
    };
    const next = reducer(state, {
      type: 'research_result',
      payload: {
        sessionId: 'a',
        topic: 'T',
        lede: '',
        sections: [{ heading: '', body: 'S' }],
        links: [],
        ts: 3000,
      },
    });
    expect(next.researchUnseen).not.toContain('a');
  });

  it('badges a background session even though you are not looking at it', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'research_result',
      payload: {
        sessionId: 'b',
        topic: 'T',
        lede: '',
        sections: [{ heading: '', body: 'S' }],
        links: [],
        ts: 3000,
      },
    });
    expect(next.researchUnseen).toContain('b');
  });
});

// ---------------------------------------------------------------------------
// reducer — set_view / select_research (the Focus ⇄ Research tab)
// ---------------------------------------------------------------------------

describe('reducer — set_view', () => {
  it('records the per-session view', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'set_view',
      payload: { sessionId: 'a', view: 'research' },
    });
    expect(next.viewBySession.a).toBe('research');
  });

  it('opening Research clears that session’s unseen badge', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a', researchUnseen: ['a'] };
    const next = reducer(state, {
      type: 'set_view',
      payload: { sessionId: 'a', view: 'research' },
    });
    expect(next.researchUnseen).not.toContain('a');
  });

  it('view is per-session — setting one does not affect another', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'a',
      viewBySession: { a: 'research' as const },
    };
    const next = reducer(state, {
      type: 'set_view',
      payload: { sessionId: 'b', view: 'research' },
    });
    expect(next.viewBySession).toEqual({ a: 'research', b: 'research' });
  });
});

describe('reducer — select_research', () => {
  it('records which briefing the session’s Research tab shows', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, {
      type: 'select_research',
      payload: { sessionId: 'a', ts: 1234 },
    });
    expect(next.selectedResearchBySession.a).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// reducer — select
// ---------------------------------------------------------------------------

describe('reducer — select', () => {
  it('sets activeSessionId and clears the unseen flag for that session', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'a',
      unseenSessionIds: ['b'],
    };
    const next = reducer(state, { type: 'select', payload: { sessionId: 'b' } });
    expect(next.activeSessionId).toBe('b');
    expect(next.unseenSessionIds).not.toContain('b');
  });
});

// ---------------------------------------------------------------------------
// reducer — close
// ---------------------------------------------------------------------------

describe('reducer — close', () => {
  it('removes the session and records its id as closed', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'a' };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'b' } });
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0].sessionId).toBe('a');
    expect(next.closedSessionIds).toContain('b');
  });

  it('closing the active tab reassigns active to the last remaining session', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'b' };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'b' } });
    expect(next.activeSessionId).toBe('a');
  });

  it('closing the only tab sets active to null', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'a' } });
    expect(next.sessions).toHaveLength(0);
    expect(next.activeSessionId).toBeNull();
  });

  it('closing a non-active tab does not change activeSessionId', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'a' };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'b' } });
    expect(next.activeSessionId).toBe('a');
  });

  it('drops the closed id from unseenSessionIds', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'a',
      unseenSessionIds: ['b'],
    };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'b' } });
    expect(next.unseenSessionIds).not.toContain('b');
  });

  it('closed session does not reappear in a subsequent snapshot', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'a' };
    const afterClose = reducer(state, { type: 'close', payload: { sessionId: 'b' } });
    // Snapshot includes 'b' again (e.g. EventSource reconnect)
    const afterSnapshot = reducer(afterClose, {
      type: 'snapshot',
      payload: { sessions: [a, b], activeSessionId: 'a' },
    });
    expect(afterSnapshot.sessions.map((s) => s.sessionId)).not.toContain('b');
  });
});

// ---------------------------------------------------------------------------
// reducer — active (focus signal) + follow control
// ---------------------------------------------------------------------------

describe('reducer — active (focus signal)', () => {
  it('follow mode: switches the view to the live background session and clears its unseen flag', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'a',
      followMode: 'follow' as const,
      unseenSessionIds: ['b'],
    };
    const next = reducer(state, { type: 'active', payload: { sessionId: 'b' } });
    expect(next.activeSessionId).toBe('b');
    expect(next.liveSessionId).toBe('b');
    expect(next.unseenSessionIds).not.toContain('b');
  });

  it('held mode: keeps the view, badges the background session (deduped on repeat)', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'a',
      followMode: 'held' as const,
    };
    const once = reducer(state, { type: 'active', payload: { sessionId: 'b' } });
    expect(once.activeSessionId).toBe('a'); // view unmoved
    expect(once.liveSessionId).toBe('b');
    expect(once.unseenSessionIds).toEqual(['b']);
    // A duplicate active for the same session must not double-badge.
    const twice = reducer(once, { type: 'active', payload: { sessionId: 'b' } });
    expect(twice.unseenSessionIds).toEqual(['b']);
  });

  it('follow mode: same id is idempotent (no badge, stays active)', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, { type: 'active', payload: { sessionId: 'a' } });
    expect(next.activeSessionId).toBe('a');
    expect(next.unseenSessionIds).toEqual([]);
  });

  it('first-session bootstrap: activeSessionId null → activates regardless of mode', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: null };
    const next = reducer(state, { type: 'active', payload: { sessionId: 'a' } });
    expect(next.activeSessionId).toBe('a');
  });

  it('id not in sessions: tracks liveSessionId but never moves focus to a non-visible id', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], activeSessionId: 'a' };
    const next = reducer(state, { type: 'active', payload: { sessionId: 'ghost' } });
    expect(next.liveSessionId).toBe('ghost');
    expect(next.activeSessionId).toBe('a'); // unchanged — no blank view
  });
});

describe('reducer — follow (resume following)', () => {
  it('held → follow: jumps to the visible live session and clears its unseen flag', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'a',
      liveSessionId: 'b',
      followMode: 'held' as const,
      unseenSessionIds: ['b'],
    };
    const next = reducer(state, { type: 'follow' });
    expect(next.followMode).toBe('follow');
    expect(next.activeSessionId).toBe('b');
    expect(next.unseenSessionIds).not.toContain('b');
  });

  it('non-visible live session: flips to follow but does not jump (no blank view)', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = {
      ...initialState,
      sessions: [a],
      activeSessionId: 'a',
      liveSessionId: 'ghost',
      followMode: 'held' as const,
    };
    const next = reducer(state, { type: 'follow' });
    expect(next.followMode).toBe('follow');
    expect(next.activeSessionId).toBe('a');
  });
});

describe('reducer — select sets held; close repoints + resumes follow', () => {
  it('select holds the view (followMode → held)', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = { ...initialState, sessions: [a, b], activeSessionId: 'a' };
    const next = reducer(state, { type: 'select', payload: { sessionId: 'b' } });
    expect(next.activeSessionId).toBe('b');
    expect(next.followMode).toBe('held');
  });

  it('close repoints liveSessionId off the removed tab (no stranded FOLLOW)', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'a',
      liveSessionId: 'b',
      followMode: 'held' as const,
    };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'b' } });
    expect(next.liveSessionId).not.toBe('b');
    expect(next.liveSessionId).toBe('a'); // fell back to last visible
  });

  it('closing the held/active tab resumes follow', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'b',
      liveSessionId: 'b',
      followMode: 'held' as const,
    };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'b' } });
    expect(next.followMode).toBe('follow');
    expect(next.activeSessionId).toBe('a');
    expect(next.liveSessionId).toBe('a');
  });

  it('close still carries followMode/liveSessionId (spread, not bare literal — D2)', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      activeSessionId: 'a',
      liveSessionId: 'a',
      followMode: 'held' as const,
    };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'b' } });
    // closing a non-active tab leaves these intact (would be undefined under a bare literal)
    expect(next.followMode).toBe('held');
    expect(next.liveSessionId).toBe('a');
  });
});

describe('reducer — task re-opens a closed session (D5)', () => {
  it('a task for a closed session drops it from closedSessionIds and shows it again', () => {
    const state = { ...initialState, sessions: [], activeSessionId: null, closedSessionIds: ['a'] };
    const next = reducer(state, {
      type: 'task',
      payload: { sessionId: 'a', prompt: 'back to work', startedAt: 1 },
    });
    expect(next.closedSessionIds).not.toContain('a');
    expect(next.sessions.map((s) => s.sessionId)).toContain('a');
    expect(next.activeSessionId).toBe('a');
  });

  it('a re-opened tab is functional (present, fresh history until snapshot — accepted 2nd-pass D1)', () => {
    const state = { ...initialState, sessions: [], activeSessionId: null, closedSessionIds: ['a'] };
    const next = reducer(state, {
      type: 'task',
      payload: { sessionId: 'a', prompt: 'back', startedAt: 1 },
    });
    const reopened = next.sessions.find((s) => s.sessionId === 'a')!;
    expect(reopened).toBeTruthy();
    expect(reopened.touchPoints).toEqual([]); // history empty until reconnect snapshot
  });
});

// ---------------------------------------------------------------------------
// isActiveSession
// ---------------------------------------------------------------------------

describe('isActiveSession', () => {
  it('returns true when sessionId matches the active session', () => {
    const state = { ...initialState, activeSessionId: 'abc' };
    expect(isActiveSession(state, 'abc')).toBe(true);
  });

  it('returns false on mismatch', () => {
    const state = { ...initialState, activeSessionId: 'abc' };
    expect(isActiveSession(state, 'xyz')).toBe(false);
  });

  it('returns false when no session is active', () => {
    expect(isActiveSession(initialState, 'abc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reducer — primedTopics (prefetch "ready" dots)
// ---------------------------------------------------------------------------

describe('reducer — primedTopics (prefetch dots)', () => {
  it('#19 research_primed adds the topic key (idempotent on replay)', () => {
    const next = reducer(initialState, {
      type: 'research_primed',
      payload: { sessionId: 's1', topic: 'React Server Components' },
    });
    expect(next.primedTopics).toEqual({ s1: ['react server components'] });
    // Replaying the same event is a no-op (and referentially stable).
    const again = reducer(next, {
      type: 'research_primed',
      payload: { sessionId: 's1', topic: 'react server components' },
    });
    expect(again).toBe(next);
  });

  it('#18d snapshot resets primedTopics (replay becomes the source of truth)', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], primedTopics: { a: ['stale'] } };
    const next = reducer(state, {
      type: 'snapshot',
      payload: { sessions: [a], activeSessionId: 'a' },
    });
    expect(next.primedTopics).toEqual({});
  });

  it('#20 research_result clears the resolved topic’s primed dot', () => {
    const a = makeSession({
      sessionId: 'a',
      suggestedTopics: [{ topic: 'RSC', reason: 'r' }],
    });
    const state = { ...initialState, sessions: [a], primedTopics: { a: ['rsc'] } };
    const next = reducer(state, {
      type: 'research_result',
      payload: {
        sessionId: 'a',
        topic: 'RSC',
        lede: '',
        sections: [{ heading: '', body: 's' }],
        links: [],
        ts: 1,
      },
    });
    expect(next.primedTopics.a).toEqual([]);
  });

  it('#21 activity intersects primed dots with the new suggested topics', () => {
    const a = makeSession({ sessionId: 'a' });
    const state = { ...initialState, sessions: [a], primedTopics: { a: ['keep', 'drop'] } };
    const next = reducer(state, {
      type: 'activity',
      payload: {
        sessionId: 'a',
        summary: 's',
        graph: 'g',
        workflowTurnSeq: null,
        topics: [{ topic: 'Keep', reason: 'r' }],
        entry: null,
      },
    });
    expect(next.primedTopics.a).toEqual(['keep']); // 'drop' no longer suggested
  });

  it('#22 close deletes the session’s primed dots', () => {
    const a = makeSession({ sessionId: 'a' });
    const b = makeSession({ sessionId: 'b' });
    const state = {
      ...initialState,
      sessions: [a, b],
      primedTopics: { a: ['x'], b: ['y'] },
    };
    const next = reducer(state, { type: 'close', payload: { sessionId: 'a' } });
    expect(next.primedTopics).toEqual({ b: ['y'] });
  });
});
