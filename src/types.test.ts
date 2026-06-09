import { describe, it, expect } from 'vitest';
import { newSession, sortPinnedFirst } from './types';
import type { Session } from './types';

/** Minimal session with a chosen pinnedAt (defaults to unpinned). */
function s(id: string, pinnedAt: number | null = null): Session {
  return { ...newSession(id, id, 0), pinnedAt };
}

describe('sortPinnedFirst', () => {
  it('keeps all-unpinned sessions in insertion order', () => {
    const out = sortPinnedFirst([s('a'), s('b'), s('c')]);
    expect(out.map((x) => x.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('lifts a pinned session above the unpinned ones', () => {
    const out = sortPinnedFirst([s('a'), s('b', 100), s('c')]);
    expect(out.map((x) => x.sessionId)).toEqual(['b', 'a', 'c']);
  });

  it('orders multiple pinned sessions most-recently-pinned first', () => {
    const out = sortPinnedFirst([s('a', 100), s('b', 300), s('c', 200)]);
    expect(out.map((x) => x.sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('puts the pinned group on top and keeps unpinned in insertion order below', () => {
    const out = sortPinnedFirst([s('a'), s('b', 100), s('c'), s('d', 200)]);
    expect(out.map((x) => x.sessionId)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('treats undefined pinnedAt (a legacy session) as unpinned', () => {
    const legacy = { ...newSession('x', 'x', 0) } as Partial<Session>;
    delete legacy.pinnedAt;
    const out = sortPinnedFirst([legacy as Session, s('p', 100)]);
    expect(out.map((x) => x.sessionId)).toEqual(['p', 'x']);
  });

  it('does not mutate the input array', () => {
    const input = [s('a'), s('b', 100)];
    const copy = [...input];
    sortPinnedFirst(input);
    expect(input).toEqual(copy);
  });
});
