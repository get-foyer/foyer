/**
 * Tests for server/activity.ts — the orchestration layer that drives
 * live activity summarisation.
 *
 * All external dependencies are mocked so tests run fast and offline.
 * We use vi.useFakeTimers() for debounce assertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared with vi.fn() INSIDE the factory to avoid hoisting issues.
// After import, access via vi.mocked(importedFn).
// ---------------------------------------------------------------------------

vi.mock('./state.js', () => ({
  getSession: vi.fn(),
  setActivityGenerating: vi.fn(),
  setActivity: vi.fn(),
  setActivityError: vi.fn(),
  // run() reads this to set ctx.planned (the hybrid workflow floor). Default: not planned.
  isPlannedTurn: vi.fn(() => false),
}));

vi.mock('./sse.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('./providers/index.js', () => ({
  getActiveProvider: vi.fn(),
}));

vi.mock('./transcript.js', () => ({
  readTranscriptTail: vi.fn(),
  getTranscriptSize: vi.fn(),
}));

// Import after mocks are registered (Vitest hoists vi.mock() calls)
import {
  scheduleSummarize,
  summarizeNow,
  recordTranscriptPath,
  runLiveSummaryPass,
  startLiveSummaryPoll,
  _resetActivityForTest,
} from './activity.js';
import { getSession, setActivityGenerating, setActivity, setActivityError } from './state.js';
import { broadcast } from './sse.js';
import { getActiveProvider } from './providers/index.js';
import { readTranscriptTail, getTranscriptSize } from './transcript.js';

// Typed mock refs
const mockGetSession = vi.mocked(getSession);
const mockSetActivityGenerating = vi.mocked(setActivityGenerating);
const mockSetActivity = vi.mocked(setActivity);
const mockSetActivityError = vi.mocked(setActivityError);
const mockBroadcast = vi.mocked(broadcast);
const mockGetActiveProvider = vi.mocked(getActiveProvider);
const mockReadTranscriptTail = vi.mocked(readTranscriptTail);
const mockGetTranscriptSize = vi.mocked(getTranscriptSize);

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-1';

function makeProvider(summary = 'Agent working on auth.', graph = 'graph TD\n  A-->B') {
  return {
    summarizeActivity: vi.fn().mockResolvedValue({ summary, graph, topics: [] }),
  };
}

function makeSession() {
  return {
    sessionId: SESSION_ID,
    status: 'working',
    waitingReason: null,
    prompt: 'Build the auth module',
    prompts: ['Build the auth module'],
    turnSeq: 1,
    graph: 'graph LR\n  G(["Build auth module"]):::goal',
    touchPoints: [],
    focusHistory: [],
    suggestedTopics: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetActivityForTest();
  vi.clearAllMocks();

  // Default happy path
  mockGetSession.mockReturnValue(makeSession() as unknown as ReturnType<typeof getSession>);
  mockGetActiveProvider.mockReturnValue(
    makeProvider() as unknown as ReturnType<typeof getActiveProvider>,
  );
  mockGetTranscriptSize.mockResolvedValue(1000);
  mockReadTranscriptTail.mockResolvedValue('[assistant] Working on tests.');
  mockSetActivityGenerating.mockReturnValue(true);
  mockSetActivity.mockReturnValue(null); // no focus entry appended by default
  mockSetActivityError.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  _resetActivityForTest();
});

// ---------------------------------------------------------------------------
// recordTranscriptPath
// ---------------------------------------------------------------------------

describe('recordTranscriptPath', () => {
  it('stores the path so run() uses it for transcript reads', async () => {
    recordTranscriptPath(SESSION_ID, '/tmp/transcript.jsonl');
    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();
    expect(mockGetTranscriptSize).toHaveBeenCalledWith('/tmp/transcript.jsonl');
  });

  it('ignores undefined paths without throwing', () => {
    expect(() => recordTranscriptPath(SESSION_ID, undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// scheduleSummarize — trailing debounce
// ---------------------------------------------------------------------------

describe('scheduleSummarize — debounce', () => {
  it('does not call the provider immediately', () => {
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');
    scheduleSummarize(SESSION_ID);
    expect(mockGetActiveProvider).not.toHaveBeenCalled();
  });

  it('calls the provider after TOUCH_DEBOUNCE_MS elapses', async () => {
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');
    scheduleSummarize(SESSION_ID);
    await vi.runAllTimersAsync();
    expect(mockGetActiveProvider).toHaveBeenCalled();
  });

  it('coalesces multiple rapid calls into a single run', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    // 5 rapid calls — only the last debounce fires
    scheduleSummarize(SESSION_ID);
    scheduleSummarize(SESSION_ID);
    scheduleSummarize(SESSION_ID);
    scheduleSummarize(SESSION_ID);
    scheduleSummarize(SESSION_ID);

    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// summarizeNow — immediate, no debounce
// ---------------------------------------------------------------------------

describe('summarizeNow', () => {
  it('triggers a run without waiting for the debounce', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();

    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending debounce when called', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    scheduleSummarize(SESSION_ID); // arms the debounce
    summarizeNow(SESSION_ID); // cancels + runs immediately
    await vi.runAllTimersAsync();

    // Only one run despite both calls
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Skip-if-unchanged
// ---------------------------------------------------------------------------

describe('skip-if-unchanged', () => {
  it('skips the LLM call when transcript size has not grown', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');
    mockGetTranscriptSize.mockResolvedValue(500);

    // First run sets lastSummarizedSize = 500
    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);

    // Second run — size unchanged → skip
    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);
  });

  it('runs again when transcript has grown', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    mockGetTranscriptSize.mockResolvedValueOnce(500);
    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);

    // Transcript grew to 800
    mockGetTranscriptSize.mockResolvedValueOnce(800);
    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Single-flight
// ---------------------------------------------------------------------------

describe('single-flight', () => {
  it('does not start a second run while one is in-flight', async () => {
    let resolveFirst!: (v: { summary: string; graph: string }) => void;
    const firstCallPromise = new Promise<{ summary: string; graph: string }>(
      (res) => (resolveFirst = res),
    );
    const provider = {
      summarizeActivity: vi
        .fn()
        .mockReturnValueOnce(firstCallPromise) // first call blocks
        .mockResolvedValueOnce({ summary: 'Second.', graph: 'graph TD\n  B-->C' }),
    };
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    // Two different sizes so skip-if-unchanged doesn't block
    mockGetTranscriptSize
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(700)
      .mockResolvedValueOnce(700)
      .mockResolvedValueOnce(900);

    // Start first run, then a second while first is in-flight
    summarizeNow(SESSION_ID);
    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();

    // First call blocking — provider called exactly once
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);

    // Resolve the first call; the queued rerun should fire
    resolveFirst({ summary: 'First.', graph: 'graph TD\n  A-->B' });
    await vi.runAllTimersAsync();

    expect(provider.summarizeActivity).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Activity context threading
// ---------------------------------------------------------------------------

describe('activity context', () => {
  it('feeds previousGraph, status and waitingReason to the provider (append-only)', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();

    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);
    const ctx = provider.summarizeActivity.mock.calls[0][0] as {
      previousGraph: string | null;
      previousTopics: { topic: string; reason: string }[];
      status: string;
      waitingReason: string | null;
    };
    // The prior storyline is threaded back so the model extends it, not redraws.
    expect(ctx.previousGraph).toBe('graph LR\n  G(["Build auth module"]):::goal');
    // Prior topics are threaded back for the same anti-churn reason.
    expect(ctx.previousTopics).toEqual([]);
    expect(ctx.status).toBe('working');
    expect(ctx.waitingReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suggested topics — broadcast the STORED (filtered) list, not the raw model
// output. This proves the F1 race guard wiring: run() reads back the session's
// suggestedTopics (which setActivity filtered against researched + in-flight)
// rather than re-broadcasting whatever the provider returned.
// ---------------------------------------------------------------------------

describe('suggested topics broadcast', () => {
  it('broadcasts the stored/filtered topics from the session, not the raw provider output', async () => {
    const provider = {
      // Provider proposes a topic that is (pretend) in flight...
      summarizeActivity: vi.fn().mockResolvedValue({
        summary: 'S',
        graph: 'graph TD\n  A',
        topics: [{ topic: 'In flight topic', reason: 'raw' }],
      }),
    };
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    // ...but the stored session (after setActivity filtered) only has the other topic.
    const session = { ...makeSession(), suggestedTopics: [{ topic: 'Kept topic', reason: 'ok' }] };
    mockGetSession.mockReturnValue(session as unknown as ReturnType<typeof getSession>);
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();

    const activityCall = mockBroadcast.mock.calls.find((c) => c[0] === 'activity');
    expect(activityCall).toBeDefined();
    const payload = activityCall![1] as { topics: { topic: string }[] };
    expect(payload.topics.map((t) => t.topic)).toEqual(['Kept topic']);
  });
});

// ---------------------------------------------------------------------------
// Focus history wiring — turn identity captured pre-await, entry forwarded
// ---------------------------------------------------------------------------

describe('focus history broadcast', () => {
  it('passes turn identity + allowAppend to setActivity and forwards the returned entry', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    const fakeEntry = {
      id: `${SESSION_ID}-1`,
      summary: 'Agent working on auth.',
      ts: 1,
      turnSeq: 1,
      turnPrompt: 'Build the auth module',
    };
    mockSetActivity.mockReturnValue(fakeEntry as unknown as ReturnType<typeof setActivity>);
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();

    // turn identity captured from the session; allowAppend true (empty focusHistory)
    expect(mockSetActivity).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        turnSeq: 1,
        turnPrompt: 'Build the auth module',
        allowAppend: true,
      }),
    );
    // the entry the store appended is forwarded on the activity event
    const activityCall = mockBroadcast.mock.calls.find((c) => c[0] === 'activity');
    expect(activityCall).toBeDefined();
    expect((activityCall![1] as { entry: unknown }).entry).toEqual(fakeEntry);
  });
});

// ---------------------------------------------------------------------------
// No provider
// ---------------------------------------------------------------------------

describe('no provider', () => {
  it('skips silently when no provider is configured', async () => {
    mockGetActiveProvider.mockReturnValue(null);
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();

    expect(mockSetActivityGenerating).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No session
// ---------------------------------------------------------------------------

describe('no session', () => {
  it('skips silently when session is not found', async () => {
    mockGetSession.mockReturnValue(null);
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();

    expect(mockSetActivityGenerating).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe('error path', () => {
  it('calls setActivityError and broadcasts activity_error on provider failure', async () => {
    const provider = {
      summarizeActivity: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    };
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();

    expect(mockSetActivityError).toHaveBeenCalledWith(SESSION_ID, 'LLM timeout');
    expect(mockBroadcast).toHaveBeenCalledWith('activity_error', {
      sessionId: SESSION_ID,
      error: 'LLM timeout',
    });
  });
});

// ---------------------------------------------------------------------------
// Live size-poll — server-side trigger for assistant-text-only turns.
// Claude Code fires no hook when the agent emits text without a tool call, so
// runLiveSummaryPass re-summarises any working session whose transcript grew.
// ---------------------------------------------------------------------------

describe('runLiveSummaryPass', () => {
  it('summarises a working session whose transcript grew since the last summary', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    mockGetTranscriptSize.mockResolvedValue(500);
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    // Baseline: first summary pins lastSummarizedSize = 500.
    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);

    // Transcript grows to 800 — the poll should re-summarise.
    mockGetTranscriptSize.mockResolvedValue(800);
    await runLiveSummaryPass();
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(2);
  });

  it('skips a session whose transcript has not grown', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    mockGetTranscriptSize.mockResolvedValue(500);
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    summarizeNow(SESSION_ID);
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);

    // Size unchanged — the growth pre-check short-circuits, no second LLM call.
    await runLiveSummaryPass();
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);
  });

  it('skips (no empty-context spam) when the transcript file does not exist yet', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');
    mockGetTranscriptSize.mockResolvedValue(null); // file absent → null

    await runLiveSummaryPass();
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).not.toHaveBeenCalled();
  });

  it('skips sessions that are not working', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    mockGetSession.mockReturnValue({
      ...makeSession(),
      status: 'done',
    } as unknown as ReturnType<typeof getSession>);
    mockGetTranscriptSize.mockResolvedValue(800);
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    await runLiveSummaryPass();
    await vi.runAllTimersAsync();
    expect(provider.summarizeActivity).not.toHaveBeenCalled();
  });

  it('skips sessions with no recorded transcript path (never stats them)', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    // Register the session in the scheduler WITHOUT a transcript path.
    scheduleSummarize(SESSION_ID);
    mockGetTranscriptSize.mockClear();

    await runLiveSummaryPass();
    // The shared generator filters path-less sessions out before any stat.
    expect(mockGetTranscriptSize).not.toHaveBeenCalled();
  });
});

describe('startLiveSummaryPoll', () => {
  it('runs a summarisation pass every LIVE_POLL_MS (~5s)', async () => {
    const provider = makeProvider();
    mockGetActiveProvider.mockReturnValue(
      provider as unknown as ReturnType<typeof getActiveProvider>,
    );
    mockGetTranscriptSize.mockResolvedValue(1000); // grew vs the null baseline
    recordTranscriptPath(SESSION_ID, '/tmp/t.jsonl');

    startLiveSummaryPoll();
    // Interval has not elapsed yet — no pass.
    expect(provider.summarizeActivity).not.toHaveBeenCalled();

    // Advance one interval — exactly one pass fires and summarises.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(provider.summarizeActivity).toHaveBeenCalledTimes(1);
  });
});
