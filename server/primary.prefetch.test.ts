import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mirror prefetch.test.ts mocks; cfg additionally carries the primary-warm knob.
vi.mock('./activity.js', () => ({ isSummarizing: vi.fn(() => false) }));
vi.mock('./sse.js', () => ({ broadcast: vi.fn() }));
vi.mock('./config.js', () => ({ cfg: { prefetchTopics: 3, primaryWarmConcurrency: 2 } }));

import { isSummarizing } from './activity.js';
import { broadcast } from './sse.js';
import { cfg } from './config.js';
import { setActiveProvider, type LlmProvider, type ResearchResult } from './providers/index.js';
import { _resetStateForTest, startSession, getSession, designatePrimary } from './state.js';
import {
  schedulePrimaryWarm,
  schedulePrefetch,
  clearPrefetch,
  getPrimedTopics,
  _resetPrefetchForTest,
} from './prefetch.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function makeProvider() {
  type Pending = {
    topic: string;
    resolve: (r: ResearchResult) => void;
    reject: (e: unknown) => void;
  };
  const pending: Pending[] = [];
  const research = vi.fn(
    (topic: string) =>
      new Promise<ResearchResult>((resolve, reject) => {
        pending.push({ topic, resolve, reject });
      }),
  );
  const provider = {
    id: 'codex',
    isAvailable: async () => true,
    research,
    summarizeActivity: async () => ({ summary: '', topics: [], primary: null }),
  } as unknown as LlmProvider;
  setActiveProvider(provider);
  const take = (topic?: string): Pending => {
    const idx = topic ? pending.findIndex((p) => p.topic === topic) : 0;
    if (idx < 0) throw new Error(`no pending research for ${topic}`);
    return pending.splice(idx, 1)[0];
  };
  return {
    research,
    inFlight: () => pending.length,
    settle: (topic?: string) =>
      take(topic).resolve({ lede: '', sections: [{ heading: 'h', body: 'b' }], links: [] }),
    fail: (topic?: string) => take(topic).reject(new Error('boom')),
  };
}

beforeEach(() => {
  _resetStateForTest();
  _resetPrefetchForTest();
  vi.mocked(broadcast).mockClear();
  vi.mocked(isSummarizing).mockReturnValue(false);
  (cfg as unknown as { primaryWarmConcurrency: number }).primaryWarmConcurrency = 2;
});

describe('schedulePrimaryWarm', () => {
  it('warms the designation, stores the briefing, flips ready with time-to-ready, broadcasts', async () => {
    const p = makeProvider();
    startSession('s1', 'task');
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    schedulePrimaryWarm('s1');
    await flush();
    expect(p.research).toHaveBeenCalledWith('T');
    p.settle('T');
    await flush();
    const s = getSession('s1')!;
    expect(s.primary?.status).toBe('ready');
    expect(typeof s.primary?.readyMs).toBe('number');
    expect(s.research.map((r) => r.topic)).toEqual(['T']); // one source of truth (D8)
    expect(broadcast).toHaveBeenCalledWith(
      'research_result',
      expect.objectContaining({ topic: 'T' }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      'primary',
      expect.objectContaining({
        sessionId: 's1',
        primary: expect.objectContaining({ status: 'ready' }),
      }),
    );
  });

  it('is idempotent for the same designation (no duplicate research calls)', async () => {
    const p = makeProvider();
    startSession('s1', 'task');
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    schedulePrimaryWarm('s1');
    schedulePrimaryWarm('s1');
    await flush();
    expect(p.research).toHaveBeenCalledTimes(1);
    p.settle('T');
    await flush();
  });

  it('enforces the global cap of 2 concurrent primary warms across sessions (D3)', async () => {
    const p = makeProvider();
    for (const sid of ['s1', 's2', 's3']) {
      startSession(sid, 'task');
      designatePrimary(sid, { topic: `T-${sid}`, reason: 'r' });
      schedulePrimaryWarm(sid);
    }
    await flush();
    expect(p.inFlight()).toBe(2); // third queues behind the cap
    p.settle();
    await flush();
    expect(p.inFlight()).toBe(2); // slot freed → third started
    p.settle();
    p.settle();
    await flush();
    expect(getSession('s3')?.primary?.status).toBe('ready');
  });

  it('a superseded designation discards the in-flight result for primary state (stored as a row only)', async () => {
    const p = makeProvider();
    startSession('s1', 'task');
    designatePrimary('s1', { topic: 'Old', reason: 'r' });
    schedulePrimaryWarm('s1');
    await flush();
    // Task shifted: a new designation replaces Old while its warm is in flight.
    designatePrimary('s1', { topic: 'New', reason: 'shift' });
    schedulePrimaryWarm('s1');
    p.settle('Old');
    await flush();
    const s = getSession('s1')!;
    expect(s.primary?.topic).toBe('New'); // pointer untouched by the stale result
    expect(s.primary?.status).toBe('warming');
    expect(s.research.map((r) => r.topic)).toContain('Old'); // the call wasn't wasted — unread row
    p.settle('New');
    await flush();
    expect(getSession('s1')?.primary?.status).toBe('ready');
  });

  it('first failure auto-retries; second flips to the error state (never an eternal ring)', async () => {
    const p = makeProvider();
    startSession('s1', 'task');
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    schedulePrimaryWarm('s1');
    await flush();
    p.fail('T');
    await flush();
    expect(getSession('s1')?.primary?.status).toBe('warming'); // ×1 → auto-requeued
    expect(p.research).toHaveBeenCalledTimes(2);
    p.fail('T');
    await flush();
    expect(getSession('s1')?.primary?.status).toBe('error'); // ×2 → error readout
    expect(p.research).toHaveBeenCalledTimes(2); // no further automatic attempts
    expect(broadcast).toHaveBeenCalledWith(
      'primary',
      expect.objectContaining({ primary: expect.objectContaining({ status: 'error' }) }),
    );
  });

  it('yields to a live summary before starting (the ADR 0003 latency rule)', async () => {
    const p = makeProvider();
    vi.mocked(isSummarizing).mockReturnValue(true);
    startSession('s1', 'task');
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    schedulePrimaryWarm('s1');
    await flush();
    expect(p.research).not.toHaveBeenCalled(); // parked behind the summary
    vi.mocked(isSummarizing).mockReturnValue(false);
    await vi.waitFor(() => expect(p.research).toHaveBeenCalledWith('T'), { timeout: 3000 });
    p.settle('T');
    await flush();
  });

  it('clearPrefetch invalidates an in-flight primary warm (generation bump)', async () => {
    const p = makeProvider();
    startSession('s1', 'task');
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    schedulePrimaryWarm('s1');
    await flush();
    clearPrefetch('s1');
    p.settle('T');
    await flush();
    const s = getSession('s1')!;
    expect(s.primary?.status).toBe('warming'); // stale result never flipped it
    expect(s.research).toHaveLength(0); // and was never stored
  });

  it('no-ops when disabled (primaryWarmConcurrency=0) or with no warming designation', async () => {
    const p = makeProvider();
    startSession('s1', 'task');
    (cfg as unknown as { primaryWarmConcurrency: number }).primaryWarmConcurrency = 0;
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    schedulePrimaryWarm('s1');
    await flush();
    expect(p.research).not.toHaveBeenCalled();
    (cfg as unknown as { primaryWarmConcurrency: number }).primaryWarmConcurrency = 2;
    schedulePrimaryWarm('unknown-session');
    await flush();
    expect(p.research).not.toHaveBeenCalled();
  });
});

describe('CRITICAL regression — viewed-session chip warming unchanged under the new scheduler', () => {
  it('schedulePrefetch still warms chips single-flight and primes them', async () => {
    const p = makeProvider();
    startSession('s1', 'task');
    schedulePrefetch('s1', [
      { topic: 'chip A', reason: 'ra' },
      { topic: 'chip B', reason: 'rb' },
    ]);
    await flush();
    expect(p.inFlight()).toBe(1); // chip loop is still single-flight
    p.settle('chip A');
    await flush();
    expect(getPrimedTopics('s1')).toEqual(['chip A']);
    p.settle('chip B');
    await flush();
    expect(getPrimedTopics('s1').sort()).toEqual(['chip A', 'chip B']);
  });

  it('chip warming and primary warming coexist without stealing each other’s entries', async () => {
    const p = makeProvider();
    startSession('s1', 'task');
    designatePrimary('s1', { topic: 'Primary T', reason: 'r' });
    schedulePrimaryWarm('s1');
    schedulePrefetch('s1', [{ topic: 'chip A', reason: 'ra' }]);
    await flush();
    p.settle('Primary T');
    p.settle('chip A');
    await flush();
    expect(getSession('s1')?.primary?.status).toBe('ready');
    expect(getPrimedTopics('s1')).toEqual(['chip A']);
  });
});
