import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createJsonStore,
  createNoopStore,
  normalizeSession,
  normalizeResearchItem,
  applyRetention,
  MAX_SESSIONS,
  DONE_TTL_MS,
} from './store.js';
import { newSession } from '../src/types.js';
import type { Session } from '../src/types.js';

// Default to a RECENT startedAt so sessions aren't pruned by the 14-day retention window.
// Tests that exercise retention pass explicit timestamps.
function mk(over: Partial<Session> = {}): Session {
  return {
    ...newSession(
      over.sessionId ?? 'sess-1',
      over.prompt ?? 'do the thing',
      over.startedAt ?? Date.now(),
    ),
    ...over,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foyer-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('createJsonStore — round-trip', () => {
  it('save then hydrate returns the session including focusHistory', () => {
    const store = createJsonStore(dir);
    const s = mk({
      sessionId: 'abc',
      status: 'done',
      finishedAt: Date.now(),
      focusHistory: [
        { id: 'abc-1', summary: 'first step', ts: 1500, turnSeq: 1, turnPrompt: 'do the thing' },
      ],
    });
    store.save(s);

    const loaded = createJsonStore(dir).hydrate();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].sessionId).toBe('abc');
    expect(loaded[0].focusHistory).toHaveLength(1);
    expect(loaded[0].focusHistory[0].summary).toBe('first step');
  });

  it('writes atomically — no .tmp file left behind, one .json present', () => {
    createJsonStore(dir).save(mk({ sessionId: 'abc', status: 'done', finishedAt: Date.now() }));
    const files = readdirSync(join(dir, 'sessions'));
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('uses a hashed filename so a path-traversal session id cannot escape', () => {
    const store = createJsonStore(dir);
    store.save(mk({ sessionId: '../../evil', status: 'done', finishedAt: Date.now() }));
    // Nothing escaped the sessions dir; exactly one hashed file inside it.
    expect(existsSync(join(dir, 'evil.json'))).toBe(false);
    expect(readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    // And it still round-trips by its real id.
    expect(createJsonStore(dir).hydrate()[0].sessionId).toBe('../../evil');
  });

  it('delete removes the session file', () => {
    const store = createJsonStore(dir);
    store.save(mk({ sessionId: 'abc', status: 'done', finishedAt: Date.now() }));
    store.delete('abc');
    expect(readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});

describe('hydrate — resilience + recovery', () => {
  it('skips a corrupt file without throwing and loads the rest', () => {
    const store = createJsonStore(dir);
    store.save(mk({ sessionId: 'good', status: 'done', finishedAt: Date.now() }));
    writeFileSync(join(dir, 'sessions', 'deadbeef.json'), '{ not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = createJsonStore(dir).hydrate();
    expect(loaded.map((s) => s.sessionId)).toEqual(['good']);
  });

  it('demotes a working session to interrupted and clears a stale spinner', () => {
    const store = createJsonStore(dir);
    store.save(
      mk({
        sessionId: 'live',
        status: 'working',
        activityStatus: 'generating',
        summary: 'mid-run',
      }),
    );

    const [loaded] = createJsonStore(dir).hydrate();
    expect(loaded.status).toBe('interrupted');
    expect(loaded.finishedAt).not.toBeNull();
    expect(loaded.activityStatus).toBe('ready'); // had a summary → ready, not a spinner
  });

  it('returns sessions sorted by startedAt ascending', () => {
    const now = Date.now();
    const store = createJsonStore(dir);
    store.save(mk({ sessionId: 'late', startedAt: now, status: 'done', finishedAt: now }));
    store.save(mk({ sessionId: 'early', startedAt: now - 5000, status: 'done', finishedAt: now }));
    expect(
      createJsonStore(dir)
        .hydrate()
        .map((s) => s.sessionId),
    ).toEqual(['early', 'late']);
  });
});

describe('normalizeSession — schema drift', () => {
  it('fills missing focusHistory/turnSeq from defaults on an old payload', () => {
    // A pre-PR1 bare session shape with no focusHistory/turnSeq.
    const old = {
      sessionId: 'old',
      prompt: 'x',
      status: 'done',
      startedAt: 1,
      finishedAt: 2,
      prompts: ['x'],
    };
    const s = normalizeSession(old)!;
    expect(s.turnSeq).toBe(1);
    expect(s.focusHistory).toEqual([]);
    expect(s.suggestedTopics).toEqual([]);
  });

  it('defaults workflowTurnSeq to null on a payload persisted before the field existed', () => {
    const old = { sessionId: 'old', prompt: 'x', status: 'done', startedAt: 1, finishedAt: 2 };
    expect(normalizeSession(old)!.workflowTurnSeq).toBeNull();
  });

  it('preserves a persisted workflowTurnSeq', () => {
    const s = normalizeSession({ sessionId: 'w', prompt: 'p', startedAt: 1, workflowTurnSeq: 3 })!;
    expect(s.workflowTurnSeq).toBe(3);
  });

  it('returns null for junk input', () => {
    expect(normalizeSession(null)).toBeNull();
    expect(normalizeSession({})).toBeNull();
    expect(normalizeSession({ prompt: 'no id' })).toBeNull();
  });

  it('reads both enveloped {v, session} and bare session shapes', () => {
    const enveloped = normalizeSession({
      v: 1,
      session: { sessionId: 'e', prompt: 'p', startedAt: 1 },
    });
    expect(enveloped?.sessionId).toBe('e');
  });
});

describe('applyRetention', () => {
  const now = 1_000_000_000_000;

  it('prunes terminal sessions older than the TTL but keeps fresh + non-terminal', () => {
    const kept = applyRetention(
      [
        mk({ sessionId: 'old-done', status: 'done', finishedAt: now - DONE_TTL_MS - 1 }),
        mk({ sessionId: 'fresh-done', status: 'done', finishedAt: now - 1000 }),
        // Non-terminal sessions are never pruned by age, even with an ancient startedAt.
        mk({ sessionId: 'working', status: 'working', startedAt: now - DONE_TTL_MS - 1 }),
      ],
      now,
    );
    expect(kept.map((s) => s.sessionId).sort()).toEqual(['fresh-done', 'working']);
  });

  it('caps total at MAX_SESSIONS, keeping the most recently started', () => {
    const many = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) =>
      mk({ sessionId: `s${i}`, startedAt: i, status: 'done', finishedAt: now }),
    );
    const kept = applyRetention(many, now);
    expect(kept).toHaveLength(MAX_SESSIONS);
    // newest startedAt survive; oldest (s0..s4) dropped
    expect(kept.some((s) => s.sessionId === 's0')).toBe(false);
    expect(kept.some((s) => s.sessionId === `s${MAX_SESSIONS + 4}`)).toBe(true);
  });

  it('exempts pinned sessions from the cap so a pin survives restart (ADR 0005)', () => {
    const many = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) =>
      mk({ sessionId: `s${i}`, startedAt: i, status: 'done', finishedAt: now }),
    );
    many[0].pinnedAt = now; // pin the oldest — it would otherwise be dropped by the newest-N cap
    const kept = applyRetention(many, now);
    expect(kept).toHaveLength(MAX_SESSIONS);
    expect(kept.some((s) => s.sessionId === 's0')).toBe(true); // pinned → retained
    expect(kept.some((s) => s.sessionId === `s${MAX_SESSIONS + 4}`)).toBe(true);
  });
});

describe('createJsonStore — unwritable dir falls back to noop', () => {
  it('returns a no-op store when the data dir cannot be created', () => {
    // Point the store at a path that is a FILE, so mkdir(<file>/sessions) fails.
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createJsonStore(filePath);
    expect(() => store.save(mk({ sessionId: 'a' }))).not.toThrow();
    expect(store.hydrate()).toEqual([]);
  });
});

describe('createNoopStore', () => {
  it('is inert', () => {
    const store = createNoopStore();
    expect(() => store.save(mk())).not.toThrow();
    expect(store.hydrate()).toEqual([]);
    expect(() => store.delete('x')).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// research back-compat — sessions persisted before the structured-briefing change
// carry a flat `summary`; they must load as a single section, not get dropped.
// ---------------------------------------------------------------------------

describe('normalizeResearchItem (research back-compat)', () => {
  it('adapts a legacy { summary } item to a single section', () => {
    const r = normalizeResearchItem({
      topic: 'RSC',
      summary: 'Server components stream UI.',
      links: [{ title: 'react.dev', url: 'https://react.dev' }],
      ts: 5,
    });
    expect(r).toEqual({
      topic: 'RSC',
      lede: '',
      sections: [{ heading: 'RSC', body: 'Server components stream UI.' }],
      links: [{ title: 'react.dev', url: 'https://react.dev' }],
      ts: 5,
    });
  });

  it('passes through a new { lede, sections } item unchanged', () => {
    const item = {
      topic: 'RSC',
      lede: 'gist',
      sections: [{ heading: 'Overview', body: 'b' }],
      links: [],
      ts: 9,
    };
    expect(normalizeResearchItem(item)).toEqual(item);
  });

  it('returns null for junk', () => {
    expect(normalizeResearchItem(null)).toBeNull();
    expect(normalizeResearchItem('nope')).toBeNull();
  });
});

describe('normalizeSession — legacy research array', () => {
  it('adapts an old-shape research array on load', () => {
    const raw = {
      sessionId: 's-legacy',
      prompt: 'task',
      startedAt: Date.now(),
      status: 'done',
      research: [{ topic: 'Old', summary: 'flat blob', links: [], ts: 1 }],
    };
    const s = normalizeSession(raw)!;
    expect(s.research).toHaveLength(1);
    expect(s.research[0].sections).toEqual([{ heading: 'Old', body: 'flat blob' }]);
    expect(s.research[0].lede).toBe('');
  });
});
