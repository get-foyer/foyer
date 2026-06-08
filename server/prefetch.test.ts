import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// isSummarizing is controllable per test (default: not summarizing → loop runs freely).
vi.mock('./activity.js', () => ({ isSummarizing: vi.fn(() => false) }));
// broadcast is a spy so we can assert research_primed / research_result.
vi.mock('./sse.js', () => ({ broadcast: vi.fn() }));
// Only prefetchTopics is read by prefetch.ts; keep it mutable so tests can flip the knob.
vi.mock('./config.js', () => ({ cfg: { prefetchTopics: 3 } }));

import { isSummarizing } from './activity.js';
import { broadcast } from './sse.js';
import { cfg } from './config.js';
import { setActiveProvider, type LlmProvider, type ResearchResult } from './providers/index.js';
import {
  _resetStateForTest,
  startSession,
  setActivity,
  addResearch,
  addResearchInFlight,
  getSession,
} from './state.js';
import type { SuggestedTopic } from '../src/types.js';
import {
  schedulePrefetch,
  takePrefetched,
  clearPrefetch,
  notifyResearchSuccess,
  getPrimedTopics,
  resolveAndStoreResearch,
  getPrefetchStats,
  _resetPrefetchForTest,
} from './prefetch.js';

// --- helpers ---------------------------------------------------------------

const topics = (...names: string[]): SuggestedTopic[] =>
  names.map((t) => ({ topic: t, reason: `because ${t}` }));

const setTopics = (n: number): void => {
  (cfg as unknown as { prefetchTopics: number }).prefetchTopics = n;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** A fake provider whose research() is manually settleable, so we can drive the warm-loop
 *  deterministically and assert one-research-at-a-time. */
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
    generateGraph: async () => '',
    research,
    summarizeActivity: async () => ({ summary: '', graph: '', topics: [] }),
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
    settle: (topic?: string, over: Partial<ResearchResult> = {}) =>
      take(topic).resolve({
        lede: '',
        sections: [{ heading: 'briefing', body: 'briefing' }],
        links: [],
        ...over,
      }),
    fail: (topic?: string) => take(topic).reject(new Error('research failed')),
  };
}

beforeEach(() => {
  _resetStateForTest();
  _resetPrefetchForTest();
  vi.mocked(broadcast).mockClear();
  vi.mocked(isSummarizing).mockReturnValue(false);
  setTopics(3);
});

afterEach(() => {
  vi.useRealTimers();
});

// --- tests -----------------------------------------------------------------

describe('schedulePrefetch + warm-loop', () => {
  it('#1 the win: a cache hit serves the result with research called exactly once', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('rsc'));
    p.settle('rsc');
    await flush();

    const session = getSession('s1')!;
    const result = await resolveAndStoreResearch(session, 'rsc');
    expect(result.sections[0].body).toBe('briefing');
    expect(p.research).toHaveBeenCalledTimes(1); // the prefetch, NOT a second live call
    expect(session.research[0].topic).toBe('rsc');
  });

  it('#2 the chip stays visible: prefetch does not touch suggestedTopics', () => {
    startSession('s1', 'goal');
    makeProvider();
    setActivity('s1', {
      summary: 's',
      graph: 'g',
      topics: topics('rsc', 'vite'),
      turnSeq: 1,
      turnPrompt: 'goal',
      allowAppend: true,
    });
    schedulePrefetch('s1', topics('rsc', 'vite'));
    const keys = getSession('s1')!.suggestedTopics.map((t) => t.topic);
    expect(keys).toEqual(['rsc', 'vite']);
  });

  it('#5 research throws → resolve-null, no primed broadcast, failure counted', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('rsc'));
    p.fail('rsc');
    await flush();

    expect(await takePrefetched('s1', 'rsc')).toBeNull();
    expect(vi.mocked(broadcast)).not.toHaveBeenCalledWith('research_primed', expect.anything());
  });

  it('#6 queued tap bypass: tapping a not-started topic drops it and returns null', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a', 'b')); // a runs, b queued
    await flush();
    expect(p.inFlight()).toBe(1); // only a is running

    expect(await takePrefetched('s1', 'b')).toBeNull(); // b not started → null
    p.settle('a');
    await flush();
    expect(p.research).toHaveBeenCalledTimes(1); // b was never researched
  });

  it('#7 top-N bound: only cfg.prefetchTopics are warmed', async () => {
    setTopics(3);
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a', 'b', 'c', 'd', 'e', 'f'));
    // drain sequentially
    for (const t of ['a', 'b', 'c']) {
      await flush();
      p.settle(t);
    }
    await flush();
    expect(p.research).toHaveBeenCalledTimes(3);
  });

  it('#8 skips already-researched and in-flight topics', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    addResearch('s1', {
      topic: 'done',
      lede: '',
      sections: [{ heading: 'done', body: 'x' }],
      links: [],
      ts: Date.now(),
    });
    addResearchInFlight('s1', 'live');
    schedulePrefetch('s1', topics('done', 'live', 'fresh'));
    await flush();
    expect(p.research).toHaveBeenCalledTimes(1);
    expect(p.research).toHaveBeenCalledWith('fresh');
  });

  it('#11 clearPrefetch empties the session cache', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a'));
    p.settle('a');
    await flush();
    expect(getPrimedTopics('s1')).toEqual(['a']);
    clearPrefetch('s1');
    expect(getPrimedTopics('s1')).toEqual([]);
    expect(await takePrefetched('s1', 'a')).toBeNull();
  });

  it('#12 disabled: FOYER_PREFETCH_TOPICS=0 → no research at all', async () => {
    setTopics(0);
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a', 'b'));
    await flush();
    expect(p.research).not.toHaveBeenCalled();
  });

  it('#13 sequential: only one research in flight at any instant', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a', 'b', 'c'));
    await flush();
    expect(p.inFlight()).toBe(1);
    p.settle('a');
    await flush();
    expect(p.inFlight()).toBe(1); // b started only after a finished
    p.settle('b');
    await flush();
    expect(p.inFlight()).toBe(1);
  });

  it('#14 yields to summarizer: no research starts while isSummarizing is true', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    vi.mocked(isSummarizing).mockReturnValue(true);
    schedulePrefetch('s1', topics('a'));
    await flush();
    expect(p.research).not.toHaveBeenCalled(); // loop is parked in the yield wait
    vi.mocked(isSummarizing).mockReturnValue(false);
    await new Promise((r) => setTimeout(r, 900)); // let the ~750ms backoff elapse
    expect(p.research).toHaveBeenCalledTimes(1);
  });

  it('#15 no second loop: two quick schedules do not double-start research', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a', 'b'));
    schedulePrefetch('s1', topics('a', 'b')); // second poll, same topics
    await flush();
    expect(p.inFlight()).toBe(1); // still single-flight
  });

  it('#16 cache-hit consume path: addResearch + research_result broadcast', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('rsc'));
    p.settle('rsc');
    await flush();

    await resolveAndStoreResearch(getSession('s1')!, 'rsc');
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith(
      'research_result',
      expect.objectContaining({ sessionId: 's1', topic: 'rsc' }),
    );
    expect(getSession('s1')!.research[0].topic).toBe('rsc');
  });

  it('#17 back-off: stops scheduling after 2 consecutive failures; notify resets', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a', 'b')); // a runs
    await flush();
    p.fail('a'); // failure 1
    await flush();
    p.fail('b'); // failure 2 → back-off armed
    await flush();

    schedulePrefetch('s1', topics('c')); // suppressed by back-off
    await flush();
    expect(p.research).toHaveBeenCalledTimes(2);

    notifyResearchSuccess('s1'); // resets
    schedulePrefetch('s1', topics('c'));
    await flush();
    expect(p.research).toHaveBeenCalledTimes(3);
  });

  it('#18 primed broadcast on ready', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('rsc'));
    p.settle('rsc');
    await flush();
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith('research_primed', {
      sessionId: 's1',
      topic: 'rsc',
    });
  });

  it('#18a generation discard: a result settling after clearPrefetch is dropped', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a'));
    await flush(); // a is running
    clearPrefetch('s1'); // bumps generation
    p.settle('a'); // late result
    await flush();
    expect(vi.mocked(broadcast)).not.toHaveBeenCalledWith('research_primed', expect.anything());
    expect(getPrimedTopics('s1')).toEqual([]);
  });

  it('#18b supersession: scheduling a new session drops the old one’s queued entries', async () => {
    startSession('sA', 'goalA');
    startSession('sB', 'goalB');
    const p = makeProvider();
    schedulePrefetch('sA', topics('a1', 'a2')); // a1 runs, a2 queued
    await flush();
    schedulePrefetch('sB', topics('b1')); // supersede → a2 dropped
    await flush();
    expect(p.inFlight()).toBe(1); // still only a1 in flight
    p.settle('a1');
    await flush();
    expect(p.research).toHaveBeenCalledWith('b1'); // loop moved to sB, not a2
    expect(p.research).not.toHaveBeenCalledWith('a2');
  });

  it('#18c attach: tapping a running topic resolves to the same single result', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a'));
    await flush(); // a running
    const tapped = takePrefetched('s1', 'a');
    p.settle('a', { sections: [{ heading: 'a', body: 'shared' }] });
    const v = await tapped;
    expect(v?.sections[0].body).toBe('shared');
    expect(p.research).toHaveBeenCalledTimes(1);
  });
});

describe('TTL', () => {
  it('#10 ready entry past TTL reads as a miss', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-06T00:00:00Z'));
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a'));
    p.settle('a');
    await flush();
    expect(getPrimedTopics('s1')).toEqual(['a']);

    vi.setSystemTime(new Date('2026-06-06T00:20:00Z')); // +20min > 15min TTL
    expect(getPrimedTopics('s1')).toEqual([]);
    expect(await takePrefetched('s1', 'a')).toBeNull();
  });
});

describe('instrumentation', () => {
  it('counts attempted / hit / consumed / wasted', async () => {
    startSession('s1', 'goal');
    const p = makeProvider();
    schedulePrefetch('s1', topics('a'));
    p.settle('a');
    await flush();
    await resolveAndStoreResearch(getSession('s1')!, 'a');
    const stats = getPrefetchStats();
    expect(stats.attempted).toBe(1);
    expect(stats.hit).toBe(1);
    expect(stats.consumed).toBe(1);
  });
});
