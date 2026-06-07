import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetStateForTest,
  startSession,
  addTouchPoint,
  setWaiting,
  clearWaiting,
  setActivityGenerating,
  setActivity,
  setActivityError,
  finishSession,
  getAllSessions,
  getSession,
  resolveResearchSession,
  addResearch,
  addResearchInFlight,
  removeResearchInFlight,
  isResearchInFlight,
  initPersistence,
  hydrateSessions,
  closeSession,
  flushAll,
  markPlanned,
} from './state.js';
import { MAX_FOCUS, newSession, isWorkflowVisible } from '../src/types.js';
import type { Session } from '../src/types.js';
import type { SessionStore } from './store.js';

const topic = (t: string, reason = 'because') => ({ topic: t, reason });

/** Build a setActivity update with focus-append defaults; override per test. */
const act = (over: Partial<Parameters<typeof setActivity>[1]> = {}) => ({
  summary: 'doing work',
  graph: 'graph LR\n  A',
  topics: [],
  turnSeq: 1,
  turnPrompt: 'task',
  allowAppend: true,
  ...over,
});

beforeEach(() => {
  _resetStateForTest();
});

// ---------------------------------------------------------------------------
// getAllSessions
// ---------------------------------------------------------------------------

describe('getAllSessions', () => {
  it('returns [] when no sessions have been started', () => {
    expect(getAllSessions()).toEqual([]);
  });

  it('returns sessions in insertion (start) order', () => {
    startSession('a', 'First');
    startSession('b', 'Second');
    startSession('c', 'Third');
    const ids = getAllSessions().map((s) => s.sessionId);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('includes both working and done sessions', () => {
    startSession('a', 'Working session');
    startSession('b', 'Finished session');
    finishSession('b');

    const all = getAllSessions();
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.sessionId === 'a')?.status).toBe('working');
    expect(all.find((s) => s.sessionId === 'b')?.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// startSession — new vs continue (multi-turn persistence)
// ---------------------------------------------------------------------------

describe('startSession — new vs continue', () => {
  it('new id creates a fresh session with prompts:[prompt] and continued:false', () => {
    const { session, continued } = startSession('s1', 'first');
    expect(continued).toBe(false);
    expect(session.prompts).toEqual(['first']);
    expect(session.prompt).toBe('first');
    expect(session.status).toBe('working');
  });

  it('continuing an existing id appends the arc, reopens to working, and PRESERVES accumulated state', () => {
    startSession('s1', 'goal');
    addTouchPoint('s1', { path: '/a.ts', tool: 'Write', ts: 1 });
    setActivity('s1', act({ summary: 'did the goal', graph: 'graph LR\n  G:::goal' }));
    finishSession('s1');
    const startedAt = getAllSessions()[0].startedAt;

    const { session, continued } = startSession('s1', 'follow-up');
    expect(continued).toBe(true);
    expect(getAllSessions()).toHaveLength(1); // continued, not a new session
    expect(session.prompts).toEqual(['goal', 'follow-up']);
    expect(session.prompt).toBe('follow-up');
    expect(session.status).toBe('working');
    expect(session.finishedAt).toBeNull();
    // Accumulated state preserved across the turn
    expect(session.summary).toBe('did the goal');
    expect(session.graph).toBe('graph LR\n  G:::goal');
    expect(session.touchPoints).toHaveLength(1);
    expect(session.startedAt).toBe(startedAt);
  });

  it('dedupes an identical consecutive prompt (no double-append)', () => {
    startSession('s1', 'same');
    const { session, continued } = startSession('s1', 'same');
    expect(continued).toBe(true);
    expect(session.prompts).toEqual(['same']);
  });

  it('caps the arc at 100, preserving the goal (prompts[0]) and the most recent turns', () => {
    startSession('s1', 'goal');
    for (let i = 1; i <= 120; i++) startSession('s1', `turn-${i}`);
    const { session } = startSession('s1', 'latest');
    expect(session.prompts).toHaveLength(100);
    expect(session.prompts[0]).toBe('goal'); // goal preserved
    expect(session.prompts.at(-1)).toBe('latest'); // newest preserved
  });
});

// ---------------------------------------------------------------------------
// resolveResearchSession
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// setWaiting / clearWaiting
// ---------------------------------------------------------------------------

describe('setWaiting / clearWaiting', () => {
  it('setWaiting sets status to waiting and stores the reason', () => {
    startSession('sess', 'do something');
    const ok = setWaiting('sess', 'Permission requested: run bash');
    expect(ok).toBe(true);

    const sessions = getAllSessions();
    expect(sessions[0].status).toBe('waiting');
    expect(sessions[0].waitingReason).toBe('Permission requested: run bash');
  });

  it('setWaiting returns false for an unknown session id', () => {
    const ok = setWaiting('ghost', 'reason');
    expect(ok).toBe(false);
  });

  it('setWaiting accepts null reason', () => {
    startSession('sess', 'task');
    setWaiting('sess', null);
    expect(getAllSessions()[0].waitingReason).toBeNull();
  });

  it('clearWaiting flips waiting → working and nulls the reason', () => {
    startSession('sess', 'task');
    setWaiting('sess', 'some reason');
    clearWaiting('sess');

    const s = getAllSessions()[0];
    expect(s.status).toBe('working');
    expect(s.waitingReason).toBeNull();
  });

  it('clearWaiting is a no-op on a working session', () => {
    startSession('sess', 'task');
    clearWaiting('sess'); // already working — should not throw
    expect(getAllSessions()[0].status).toBe('working');
  });

  it('clearWaiting is a no-op on a done session (never resurrects it)', () => {
    startSession('sess', 'task');
    finishSession('sess');
    clearWaiting('sess');
    expect(getAllSessions()[0].status).toBe('done');
  });

  it('finishSession over a waiting session → done and clears reason', () => {
    startSession('sess', 'task');
    setWaiting('sess', 'permission needed');
    finishSession('sess');

    const s = getAllSessions()[0];
    expect(s.status).toBe('done');
    expect(s.waitingReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setActivityGenerating / setActivity / setActivityError
// ---------------------------------------------------------------------------

describe('setActivityGenerating / setActivity / setActivityError', () => {
  it('setActivityGenerating sets activityStatus to generating', () => {
    startSession('sess', 'task');
    const ok = setActivityGenerating('sess');
    expect(ok).toBe(true);
    expect(getAllSessions()[0].activityStatus).toBe('generating');
  });

  it('setActivityGenerating returns false for an unknown session', () => {
    expect(setActivityGenerating('ghost')).toBe(false);
  });

  it('setActivity sets summary, graph, activityStatus=ready, activityError=null', () => {
    startSession('sess', 'task');
    setActivityGenerating('sess');
    const entry = setActivity('sess', {
      summary: 'Working on auth.',
      graph: 'graph TD\n  A-->B',
      topics: [],
      turnSeq: 1,
      turnPrompt: 'task',
      allowAppend: true,
    });
    expect(entry).not.toBeNull();
    const s = getAllSessions()[0];
    expect(s.summary).toBe('Working on auth.');
    expect(s.graph).toBe('graph TD\n  A-->B');
    expect(s.activityStatus).toBe('ready');
    expect(s.activityError).toBeNull();
  });

  it('setActivity returns null for an unknown session', () => {
    expect(setActivity('ghost', act())).toBeNull();
  });

  it('setActivityError sets activityStatus=error and stores the message', () => {
    startSession('sess', 'task');
    const ok = setActivityError('sess', 'LLM timeout after 90s');
    expect(ok).toBe(true);
    const s = getAllSessions()[0];
    expect(s.activityStatus).toBe('error');
    expect(s.activityError).toBe('LLM timeout after 90s');
  });

  it('setActivityError returns false for an unknown session', () => {
    expect(setActivityError('ghost', 'oops')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Focus history — turnSeq + setActivity append/de-dup/cap
// ---------------------------------------------------------------------------

describe('focus history', () => {
  it('newSession starts at turnSeq 1 with empty focusHistory', () => {
    const { session } = startSession('s1', 'goal');
    expect(session.turnSeq).toBe(1);
    expect(session.focusHistory).toEqual([]);
  });

  it('continuing with a new prompt bumps turnSeq; a duplicate prompt does not', () => {
    startSession('s1', 'goal'); // turnSeq 1
    expect(startSession('s1', 'next').session.turnSeq).toBe(2); // new prompt → bump
    expect(startSession('s1', 'next').session.turnSeq).toBe(2); // dup prompt → no bump
    expect(startSession('s1', 'third').session.turnSeq).toBe(3);
  });

  it('setActivity appends a FocusEntry (newest first) stamped with turn identity', () => {
    startSession('s1', 'goal');
    const entry = setActivity('s1', act({ summary: 'first step', turnSeq: 1, turnPrompt: 'goal' }));
    expect(entry).not.toBeNull();
    const s = getSession('s1')!;
    expect(s.focusHistory).toHaveLength(1);
    expect(s.focusHistory[0]).toMatchObject({
      summary: 'first step',
      turnSeq: 1,
      turnPrompt: 'goal',
    });
    expect(s.focusHistory[0].id).toContain('s1-');
    expect(typeof s.focusHistory[0].ts).toBe('number');
  });

  it('de-dupes a consecutive summary that differs only in whitespace/case', () => {
    startSession('s1', 'goal');
    expect(setActivity('s1', act({ summary: 'Working  on\nAuth' }))).not.toBeNull();
    expect(setActivity('s1', act({ summary: 'working on auth' }))).toBeNull();
    expect(getSession('s1')!.focusHistory).toHaveLength(1);
  });

  it('does not append when allowAppend is false, even if the text changed', () => {
    startSession('s1', 'goal');
    expect(setActivity('s1', act({ summary: 'a' }))).not.toBeNull();
    expect(setActivity('s1', act({ summary: 'totally different', allowAppend: false }))).toBeNull();
    const s = getSession('s1')!;
    expect(s.focusHistory).toHaveLength(1);
    // live summary still refreshes even when no history entry is appended
    expect(s.summary).toBe('totally different');
  });

  it('caps focusHistory at MAX_FOCUS, keeping the newest', () => {
    startSession('s1', 'goal');
    for (let i = 0; i < MAX_FOCUS + 10; i++) {
      setActivity('s1', act({ summary: `step ${i}` }));
    }
    const s = getSession('s1')!;
    expect(s.focusHistory).toHaveLength(MAX_FOCUS);
    expect(s.focusHistory[0].summary).toBe(`step ${MAX_FOCUS + 9}`); // newest first
  });
});

// ---------------------------------------------------------------------------
// Workflow visibility — setActivity sticky decision + ephemeral plan-mode floor
// ---------------------------------------------------------------------------

describe('workflow visibility — setActivity sticky + planned floor', () => {
  it('a non-null graph shows the workflow for that turn', () => {
    startSession('s', 'goal');
    setActivity('s', act({ graph: 'graph LR\n  G:::goal', turnSeq: 1 }));
    const s = getSession('s')!;
    expect(s.workflowTurnSeq).toBe(1);
    expect(isWorkflowVisible(s)).toBe(true);
    expect(s.graph).toBe('graph LR\n  G:::goal');
  });

  it('a null graph on a non-planned turn does NOT show the workflow', () => {
    startSession('s', 'goal');
    setActivity('s', act({ graph: null, turnSeq: 1 }));
    const s = getSession('s')!;
    expect(s.workflowTurnSeq).toBeNull();
    expect(isWorkflowVisible(s)).toBe(false);
    expect(s.graph).toBeNull();
  });

  it('markPlanned floors visibility ON even when the model returns a null graph', () => {
    startSession('s', 'goal');
    markPlanned('s'); // ExitPlanMode fired on turn 1
    setActivity('s', act({ graph: null, turnSeq: 1 }));
    const s = getSession('s')!;
    expect(s.workflowTurnSeq).toBe(1); // shown via the plan-mode floor
    expect(isWorkflowVisible(s)).toBe(true);
    expect(s.graph).toBeNull(); // ...but no storyline yet → SummaryPanel shows "Sketching…"
  });

  it('is sticky within a turn: a later null tick keeps both the graph and the visibility', () => {
    startSession('s', 'goal');
    setActivity('s', act({ graph: 'graph LR\n  A:::goal', turnSeq: 1 }));
    setActivity('s', act({ graph: null, turnSeq: 1 })); // a quieter tick, same turn
    const s = getSession('s')!;
    expect(s.workflowTurnSeq).toBe(1);
    expect(isWorkflowVisible(s)).toBe(true);
    expect(s.graph).toBe('graph LR\n  A:::goal'); // never overwritten with null (monotonic)
  });

  it('re-decides fresh on a new turn: a trivial turn-2 hides the turn-1 workflow', () => {
    startSession('s', 'goal'); // turn 1
    setActivity('s', act({ graph: 'graph LR\n  A:::goal', turnSeq: 1 }));
    startSession('s', 'tiny follow-up'); // bump → turn 2
    setActivity('s', act({ graph: null, turnSeq: 2 }));
    const s = getSession('s')!;
    expect(s.turnSeq).toBe(2);
    expect(s.workflowTurnSeq).toBe(1); // stamp is now stale
    expect(isWorkflowVisible(s)).toBe(false); // hidden on turn 2
    expect(s.graph).toBe('graph LR\n  A:::goal'); // storyline content survives the hidden turn
  });

  it('re-shows on a later multi-phase turn with the extended storyline', () => {
    startSession('s', 'goal'); // turn 1
    setActivity('s', act({ graph: 'graph LR\n  A:::goal', turnSeq: 1 }));
    startSession('s', 'trivial'); // turn 2
    setActivity('s', act({ graph: null, turnSeq: 2 }));
    startSession('s', 'big follow-up'); // turn 3
    setActivity('s', act({ graph: 'graph LR\n  A-->B:::active', turnSeq: 3 }));
    const s = getSession('s')!;
    expect(s.turnSeq).toBe(3);
    expect(s.workflowTurnSeq).toBe(3);
    expect(isWorkflowVisible(s)).toBe(true);
    expect(s.graph).toBe('graph LR\n  A-->B:::active');
  });

  it('a non-null pivot graph overwrites the previous storyline (content is not frozen)', () => {
    startSession('s', 'goal');
    setActivity('s', act({ graph: 'graph LR\n  A:::goal', turnSeq: 1 }));
    setActivity('s', act({ graph: 'graph LR\n  PIVOT:::goal', turnSeq: 1 }));
    expect(getSession('s')!.graph).toBe('graph LR\n  PIVOT:::goal');
  });

  it('drops the plan-mode marker on finish so it cannot leak into a reopened turn', () => {
    startSession('s', 'goal');
    markPlanned('s');
    finishSession('s'); // clears the ephemeral marker
    startSession('s', 'reopened'); // turn 2, NOT planned
    setActivity('s', act({ graph: null, turnSeq: 2 }));
    expect(isWorkflowVisible(getSession('s')!)).toBe(false); // no stale plan floor
  });
});

describe('isWorkflowVisible', () => {
  it('false when workflowTurnSeq is null', () => {
    expect(isWorkflowVisible(newSession('s', 'g', 1))).toBe(false);
  });
  it('true when workflowTurnSeq === turnSeq', () => {
    expect(isWorkflowVisible({ ...newSession('s', 'g', 1), turnSeq: 4, workflowTurnSeq: 4 })).toBe(
      true,
    );
  });
  it('false when workflowTurnSeq is stale (!== turnSeq)', () => {
    expect(isWorkflowVisible({ ...newSession('s', 'g', 1), turnSeq: 5, workflowTurnSeq: 3 })).toBe(
      false,
    );
  });
});

describe('resolveResearchSession', () => {
  it('returns the session matching the provided id', () => {
    startSession('a', 'Task A');
    startSession('b', 'Task B');
    const result = resolveResearchSession('a');
    expect(result?.sessionId).toBe('a');
  });

  it('falls back to the active session when id is null', () => {
    startSession('a', 'Task A');
    startSession('b', 'Task B'); // 'b' becomes active (last started)
    const result = resolveResearchSession(null);
    expect(result?.sessionId).toBe('b');
  });

  it('falls back to the active session when id is undefined', () => {
    startSession('a', 'Task A');
    const result = resolveResearchSession(undefined);
    expect(result?.sessionId).toBe('a');
  });

  it('falls back to the active session when id is unknown', () => {
    startSession('a', 'Task A');
    const result = resolveResearchSession('nonexistent-id');
    expect(result?.sessionId).toBe('a');
  });

  it('returns null when id is absent and there is no active session', () => {
    // No sessions started — no active session
    expect(resolveResearchSession(null)).toBeNull();
    expect(resolveResearchSession(undefined)).toBeNull();
    expect(resolveResearchSession('unknown')).toBeNull();
  });

  it('returns null when provided id is unknown and no active session exists', () => {
    // resetStateForTest cleared everything
    expect(resolveResearchSession('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suggested topics — storage + filter (F1/F2 race guard)
// ---------------------------------------------------------------------------

describe('setActivity — suggested topics', () => {
  it('stores the suggested topics on the session', () => {
    startSession('s', 'task');
    setActivity('s', act({ topics: [topic('React useTransition'), topic('Mermaid graph LR')] }));
    const s = getSession('s')!;
    expect(s.suggestedTopics.map((t) => t.topic)).toEqual([
      'React useTransition',
      'Mermaid graph LR',
    ]);
  });

  it('excludes topics already researched (case-insensitive)', () => {
    startSession('s', 'task');
    addResearch('s', { topic: 'React useTransition', summary: 'x', links: [], ts: 1 });
    setActivity('s', act({ topics: [topic('react USEtransition'), topic('Mermaid graph LR')] }));
    const s = getSession('s')!;
    expect(s.suggestedTopics.map((t) => t.topic)).toEqual(['Mermaid graph LR']);
  });

  it('excludes topics with research in flight (the race guard)', () => {
    startSession('s', 'task');
    addResearchInFlight('s', 'React useTransition');
    setActivity('s', act({ topics: [topic('React useTransition'), topic('Mermaid graph LR')] }));
    const s = getSession('s')!;
    // A tick during in-flight research must NOT re-surface the clicked topic.
    expect(s.suggestedTopics.map((t) => t.topic)).toEqual(['Mermaid graph LR']);
  });
});

describe('in-flight research guard', () => {
  it('add / is / remove round-trips, case-insensitively', () => {
    startSession('s', 'task');
    expect(isResearchInFlight('s', 'Topic A')).toBe(false);
    addResearchInFlight('s', 'Topic A');
    expect(isResearchInFlight('s', 'topic a')).toBe(true);
    removeResearchInFlight('s', 'TOPIC A');
    expect(isResearchInFlight('s', 'Topic A')).toBe(false);
  });
});

describe('addResearch — chip removal', () => {
  it('removes the matching suggested topic and clears the in-flight flag', () => {
    startSession('s', 'task');
    setActivity('s', act({ topics: [topic('React useTransition'), topic('Mermaid graph LR')] }));
    addResearchInFlight('s', 'React useTransition');

    addResearch('s', { topic: 'React useTransition', summary: 'x', links: [], ts: 1 });

    const s = getSession('s')!;
    expect(s.research).toHaveLength(1);
    expect(s.suggestedTopics.map((t) => t.topic)).toEqual(['Mermaid graph LR']);
    expect(isResearchInFlight('s', 'React useTransition')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persistence wiring — write-through, hydrate, close
// ---------------------------------------------------------------------------

function recordingStore() {
  const saved: Session[] = [];
  const deleted: string[] = [];
  const store: SessionStore = {
    hydrate: () => [],
    save: (s) => saved.push(s),
    delete: (id) => deleted.push(id),
    close: () => {},
  };
  return { store, saved, deleted };
}

describe('persistence wiring', () => {
  it('finishSession flushes the session immediately (lifecycle transition)', () => {
    const rec = recordingStore();
    initPersistence(rec.store);
    startSession('s', 'task');
    finishSession('s');
    expect(rec.saved.some((s) => s.sessionId === 's' && s.status === 'done')).toBe(true);
  });

  it('a touch marks dirty; flushAll writes it through', () => {
    const rec = recordingStore();
    initPersistence(rec.store);
    startSession('s', 'task');
    rec.saved.length = 0; // ignore the startSession write
    addTouchPoint('s', { path: '/a.ts', tool: 'Write', ts: 1 });
    expect(rec.saved).toHaveLength(0); // debounced — not written yet
    flushAll();
    expect(rec.saved.some((s) => s.sessionId === 's')).toBe(true);
  });

  it('closeSession persists a closed flag immediately and hides it from getAllSessions', () => {
    const rec = recordingStore();
    initPersistence(rec.store);
    startSession('s', 'task');
    expect(closeSession('s')).toBe(true);

    expect(getSession('s')?.closed).toBe(true); // still in the Map
    expect(getAllSessions().some((x) => x.sessionId === 's')).toBe(false); // hidden from UI
    expect(rec.saved.some((x) => x.sessionId === 's' && x.closed)).toBe(true); // durable
  });

  it('re-prompting a closed session re-opens it (closed=false) and flushes immediately (D5)', () => {
    const rec = recordingStore();
    initPersistence(rec.store);
    startSession('s', 'task');
    closeSession('s');
    expect(getSession('s')?.closed).toBe(true);
    rec.saved.length = 0; // ignore the close write
    // A fresh prompt un-dismisses the session.
    startSession('s', 'back to work');
    expect(getSession('s')?.closed).toBe(false);
    expect(getAllSessions().some((x) => x.sessionId === 's')).toBe(true); // visible again
    // The closed→open transition flushes immediately (durable across a crash).
    expect(rec.saved.some((x) => x.sessionId === 's')).toBe(true);
  });

  it('a normal continue of an open session does not flush eagerly (no write amplification, 2nd-pass D2)', () => {
    const rec = recordingStore();
    initPersistence(rec.store);
    startSession('s', 'task'); // new session — debounced markDirty
    rec.saved.length = 0; // ignore the create write
    startSession('s', 'turn 2'); // continue of an OPEN session
    expect(getSession('s')?.closed).toBeFalsy();
    // No closed→open transition → no flushNow; the write stays debounced (nothing saved yet).
    expect(rec.saved).toHaveLength(0);
  });

  it('closeSession returns false for an unknown session', () => {
    expect(closeSession('ghost')).toBe(false);
  });

  it('hydrateSessions loads sessions into the Map; closed ones stay hidden', () => {
    const open = { ...newSession('open', 'a', 1), status: 'done' as const, finishedAt: 2 };
    const closed = {
      ...newSession('closed', 'b', 1),
      status: 'done' as const,
      finishedAt: 2,
      closed: true,
    };
    hydrateSessions([open, closed]);
    expect(getSession('open')?.sessionId).toBe('open');
    expect(getSession('closed')?.closed).toBe(true); // present in the Map
    expect(getAllSessions().map((s) => s.sessionId)).toEqual(['open']); // closed filtered out
  });
});
