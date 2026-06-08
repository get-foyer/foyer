import { describe, it, expect } from 'vitest';
import { reducer, initialState } from './App';
import { newSession } from './types';
import type { Session } from './types';

// Distinct startedAt (a<b<c<d) so unpinned ordering is by chronological start, like production.
const mk = (id: string, startedAt: number, pinnedAt: number | null = null): Session => ({
  ...newSession(id, id, startedAt),
  pinnedAt,
});

const withSessions = (sessions: Session[]) => ({ ...initialState, sessions });

describe('reducer — pin / unpin (optimistic re-sort)', () => {
  it('pin stamps pinnedAt and lifts the session to the top', () => {
    const next = reducer(withSessions([mk('a', 1), mk('b', 2), mk('c', 3)]), {
      type: 'pin',
      payload: { sessionId: 'b' },
    });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['b', 'a', 'c']);
    expect(next.sessions.find((s) => s.sessionId === 'b')!.pinnedAt).toEqual(expect.any(Number));
  });

  it('unpin clears pinnedAt and drops the session back to its chronological slot', () => {
    // b is pinned (at the top of the array); unpinning it should drop it between a and c.
    const next = reducer(withSessions([mk('b', 2, 100), mk('a', 1), mk('c', 3)]), {
      type: 'unpin',
      payload: { sessionId: 'b' },
    });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
    expect(next.sessions.find((s) => s.sessionId === 'b')!.pinnedAt).toBeNull();
  });

  it('a fresh pin sorts above an earlier pin (most-recently-pinned first)', () => {
    const next = reducer(withSessions([mk('a', 1, 100), mk('b', 2), mk('c', 3)]), {
      type: 'pin',
      payload: { sessionId: 'c' },
    });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['c', 'a', 'b']);
  });

  it('pin/unpin on an unknown id is a no-op (no throw, order unchanged)', () => {
    const state = withSessions([mk('a', 1), mk('b', 2)]);
    expect(
      reducer(state, { type: 'pin', payload: { sessionId: 'ghost' } }).sessions.map(
        (s) => s.sessionId,
      ),
    ).toEqual(['a', 'b']);
  });
});

describe('reducer — research warming (in-flight prefetch ring)', () => {
  it('research_warming{active:true} adds the lowercased topic key; idempotent on replay', () => {
    const s1 = reducer(initialState, {
      type: 'research_warming',
      payload: { sessionId: 's1', topic: 'React RSC', active: true },
    });
    expect(s1.warmingTopics.s1).toEqual(['react rsc']);
    // Re-delivery (reconnect replay) must not duplicate — same reference back.
    const s2 = reducer(s1, {
      type: 'research_warming',
      payload: { sessionId: 's1', topic: 'react rsc', active: true },
    });
    expect(s2).toBe(s1);
  });

  it('research_warming{active:false} removes the key', () => {
    const warmed = { ...initialState, warmingTopics: { s1: ['react rsc'] } };
    const next = reducer(warmed, {
      type: 'research_warming',
      payload: { sessionId: 's1', topic: 'React RSC', active: false },
    });
    expect(next.warmingTopics.s1).toEqual([]);
  });

  it('research_primed settles the ring into the dot (adds primed, removes warming)', () => {
    const warmed = { ...initialState, warmingTopics: { s1: ['react rsc'] } };
    const next = reducer(warmed, {
      type: 'research_primed',
      payload: { sessionId: 's1', topic: 'React RSC' },
    });
    expect(next.primedTopics.s1).toEqual(['react rsc']);
    expect(next.warmingTopics.s1).toEqual([]);
  });

  it('snapshot clears warmingTopics (replay is the source of truth)', () => {
    const warmed = { ...initialState, warmingTopics: { s1: ['react rsc'] } };
    const next = reducer(warmed, {
      type: 'snapshot',
      payload: { sessions: [], activeSessionId: null },
    });
    expect(next.warmingTopics).toEqual({});
  });

  it('activity prunes warming dots for topics no longer suggested', () => {
    const base = withSessions([mk('s1', 1)]);
    const warmed = { ...base, warmingTopics: { s1: ['gone', 'keep'] } };
    const next = reducer(warmed, {
      type: 'activity',
      payload: {
        sessionId: 's1',
        summary: 'x',
        topics: [{ topic: 'keep', reason: 'still relevant' }],
        entry: null,
      },
    });
    expect(next.warmingTopics.s1).toEqual(['keep']);
  });

  it('research_result clears the warming ring for the resolved topic', () => {
    const base = withSessions([mk('s1', 1)]);
    const warmed = { ...base, warmingTopics: { s1: ['react rsc'] } };
    const next = reducer(warmed, {
      type: 'research_result',
      payload: { sessionId: 's1', topic: 'React RSC', lede: 'b', sections: [], links: [], ts: 1 },
    });
    expect(next.warmingTopics.s1).toEqual([]);
  });

  it('close drops the warming dots for the closed session', () => {
    const base = withSessions([mk('s1', 1), mk('s2', 2)]);
    const warmed = { ...base, warmingTopics: { s1: ['a'], s2: ['b'] } };
    const next = reducer(warmed, { type: 'close', payload: { sessionId: 's1' } });
    expect(next.warmingTopics.s1).toBeUndefined();
    expect(next.warmingTopics.s2).toEqual(['b']);
  });
});

describe('reducer — mark_research_read (readAt optimistic mirror)', () => {
  const briefing = (ts: number, readAt: number | null = null) => ({
    topic: `T${ts}`,
    lede: '',
    sections: [],
    links: [],
    ts,
    readAt,
  });
  const withResearch = (research: ReturnType<typeof briefing>[]) => {
    const base = withSessions([mk('s1', 1)]);
    return { ...base, sessions: [{ ...base.sessions[0], research }] };
  };

  it('stamps readAt on the matching unread briefing', () => {
    const next = reducer(withResearch([briefing(10)]), {
      type: 'mark_research_read',
      payload: { sessionId: 's1', ts: 10 },
    });
    expect(next.sessions[0].research[0].readAt).toEqual(expect.any(Number));
  });

  it('is idempotent — leaves an already-read briefing untouched', () => {
    const start = withResearch([briefing(10, 5000)]);
    const next = reducer(start, {
      type: 'mark_research_read',
      payload: { sessionId: 's1', ts: 10 },
    });
    expect(next.sessions[0].research[0].readAt).toBe(5000);
    expect(next).toBe(start); // no-op short-circuits (referential identity preserved)
  });

  it('unknown session or ts is a no-op', () => {
    const start = withResearch([briefing(10)]);
    expect(
      reducer(start, { type: 'mark_research_read', payload: { sessionId: 'ghost', ts: 10 } }),
    ).toBe(start);
    expect(
      reducer(start, { type: 'mark_research_read', payload: { sessionId: 's1', ts: 999 } }),
    ).toBe(start);
  });
});
