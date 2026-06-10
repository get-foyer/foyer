/**
 * Integration suite (design review DR-9 / eng review T9): drives the REAL HTTP surface via
 * createApp() on an ephemeral port, with a raw SSE reader, so the cross-module chain
 *   hook → summarize → rank → designate → warm → SSE → (dismiss / retry / read) → reconnect replay
 * is exercised end-to-end with a stub provider. Per-module logic is unit-tested elsewhere; this
 * guards the SEAMS where an event-name typo or a missed replay would ship green.
 *
 * Also absorbs the pre-existing "cover the SSE reconnect-replay paths" TODO: the reconnect test
 * asserts a fresh /events connection re-derives primary state from the snapshot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createApp } from './app.js';
import { setActiveProvider, type LlmProvider } from './providers/index.js';
import { _resetStateForTest, getSession } from './state.js';
import {
  _resetPrefetchForTest,
  schedulePrimaryWarm,
  getPrimedTopics,
  getWarmingTopics,
} from './prefetch.js';
import { _resetActivityForTest, setPrimaryWarmScheduler } from './activity.js';
import { _resetTouchedForTest } from './touched.js';
import { setPrimedTopicsProvider, setWarmingTopicsProvider } from './sse.js';

// --- a tiny raw SSE reader -------------------------------------------------

interface SseEvent {
  type: string;
  data: unknown;
}

/** Open GET /events and accumulate parsed events. Returns the live array + a waitFor + close. */
function openSSE(port: number): {
  events: SseEvent[];
  waitFor: (pred: (e: SseEvent[]) => boolean, ms?: number) => Promise<void>;
  close: () => void;
} {
  const events: SseEvent[] = [];
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/events',
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    },
    (res) => {
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        // SSE frames are separated by a blank line.
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let type = 'message';
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          }
          if (dataLines.length) {
            let data: unknown = null;
            try {
              data = JSON.parse(dataLines.join('\n'));
            } catch {
              data = dataLines.join('\n');
            }
            events.push({ type, data });
          }
        }
      });
    },
  );
  req.end();
  const waitFor = (pred: (e: SseEvent[]) => boolean, ms = 3000): Promise<void> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (pred(events)) return resolve();
        if (Date.now() - started > ms) return reject(new Error('SSE waitFor timed out'));
        setTimeout(tick, 10);
      };
      tick();
    });
  return { events, waitFor, close: () => req.destroy() };
}

// --- stub provider with controllable research ------------------------------

function stubProvider(opts: {
  primary: { topic: string; reason: string } | null;
  topics?: { topic: string; reason: string }[];
  research?: () => Promise<{
    lede: string;
    sections: { heading: string; body: string }[];
    links: [];
  }>;
}): LlmProvider {
  const topics = opts.topics ?? (opts.primary ? [opts.primary] : []);
  return {
    id: 'anthropic-api',
    isAvailable: async () => true,
    research:
      opts.research ??
      (async () => ({ lede: 'briefing lede', sections: [{ heading: 'h', body: 'b' }], links: [] })),
    summarizeActivity: async () => ({ summary: 'working', topics, primary: opts.primary }),
  } as unknown as LlmProvider;
}

let server: http.Server;
let port: number;

beforeEach(async () => {
  _resetStateForTest();
  _resetPrefetchForTest();
  _resetActivityForTest();
  _resetTouchedForTest();
  // Wire the boot-time injections createApp() doesn't do (index.ts boot() owns these in prod):
  // the primary-warm scheduler is what flips a designation warming → ready.
  setPrimaryWarmScheduler(schedulePrimaryWarm);
  setPrimedTopicsProvider(getPrimedTopics);
  setWarmingTopicsProvider(getWarmingTopics);
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  setPrimaryWarmScheduler(null);
  // SSE connections keep the server alive (25s heartbeat); force them shut so close() resolves fast.
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
});

const post = (path: string, body: unknown): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null }),
        );
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

const hook = (sessionId: string, prompt: string) =>
  post('/hook', { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt });

const primaryEvents = (events: SseEvent[], sessionId: string) =>
  events.filter(
    (e) => e.type === 'primary' && (e.data as { sessionId: string }).sessionId === sessionId,
  );
const lastPrimary = (events: SseEvent[], sessionId: string) =>
  primaryEvents(events, sessionId).at(-1)?.data as
    | { sessionId: string; primary: { topic: string; status: string } | null }
    | undefined;

describe('glance-over: hook → designate → warm → ready over SSE', () => {
  it('streams a primary warming then ready as the briefing lands', async () => {
    setActiveProvider(
      stubProvider({ primary: { topic: 'DNS rebinding guard', reason: 'editing security' } }),
    );
    const sse = openSSE(port);
    await sse.waitFor((e) => e.some((x) => x.type === 'snapshot'));

    await hook('sess-1', 'harden the server');
    // The primary designates (warming) then flips ready once the stub research resolves.
    await sse.waitFor((e) => lastPrimary(e, 'sess-1')?.primary?.status === 'ready');

    const p = lastPrimary(sse.events, 'sess-1')!.primary!;
    expect(p.topic).toBe('DNS rebinding guard');
    expect(p.status).toBe('ready');
    // The briefing body landed via the SAME path as a tap (D8 — one source of truth).
    expect(
      sse.events.some(
        (e) =>
          e.type === 'research_result' &&
          (e.data as { topic: string }).topic === 'DNS rebinding guard',
      ),
    ).toBe(true);
    expect(getSession('sess-1')?.research.map((r) => r.topic)).toEqual(['DNS rebinding guard']);
    sse.close();
  });

  it('null primary → no designation, no strip (thin context is a first-class outcome)', async () => {
    setActiveProvider(stubProvider({ primary: null, topics: [{ topic: 'x', reason: 'y' }] }));
    const sse = openSSE(port);
    await sse.waitFor((e) => e.some((x) => x.type === 'snapshot'));
    await hook('sess-1', 'do a thing');
    await sse.waitFor((e) => e.some((x) => x.type === 'activity'));
    expect(primaryEvents(sse.events, 'sess-1').length).toBe(0);
    expect(getSession('sess-1')?.primary ?? null).toBeNull();
    sse.close();
  });
});

describe('dismiss → promote next pick → broadcast', () => {
  it('dismissing the primary excludes it and promotes the next-ranked topic', async () => {
    setActiveProvider(
      stubProvider({
        primary: { topic: 'First pick', reason: 'r1' },
        topics: [
          { topic: 'First pick', reason: 'r1' },
          { topic: 'Second pick', reason: 'r2' },
        ],
      }),
    );
    const sse = openSSE(port);
    await sse.waitFor((e) => e.some((x) => x.type === 'snapshot'));
    await hook('sess-1', 'task');
    await sse.waitFor((e) => lastPrimary(e, 'sess-1')?.primary?.topic === 'First pick');

    const res = await post('/primary/dismiss', { sessionId: 'sess-1' });
    expect(res.status).toBe(200);
    // The next-ranked candidate is promoted (the strip never blanks — DR8).
    await sse.waitFor((e) => lastPrimary(e, 'sess-1')?.primary?.topic === 'Second pick');
    const s = getSession('sess-1')!;
    expect(s.dismissedTopics).toContain('first pick');
    expect(s.primary?.topic).toBe('Second pick');
    sse.close();
  });

  it('dismiss with no primary is an idempotent 200', async () => {
    setActiveProvider(stubProvider({ primary: null }));
    await hook('sess-1', 'task');
    const res = await post('/primary/dismiss', { sessionId: 'sess-1' });
    expect(res.status).toBe(200);
  });
});

describe('failure → error → retry', () => {
  it('two warm failures reach the error state, then retry re-warms to ready', async () => {
    let calls = 0;
    setActiveProvider(
      stubProvider({
        primary: { topic: 'Flaky', reason: 'r' },
        research: async () => {
          calls++;
          if (calls <= 2) throw new Error('provider down');
          return { lede: 'ok', sections: [{ heading: 'h', body: 'b' }], links: [] };
        },
      }),
    );
    const sse = openSSE(port);
    await sse.waitFor((e) => e.some((x) => x.type === 'snapshot'));
    await hook('sess-1', 'task');
    // ×1 auto-retries, ×2 → error.
    await sse.waitFor((e) => lastPrimary(e, 'sess-1')?.primary?.status === 'error');

    const res = await post('/primary/retry', { sessionId: 'sess-1' });
    expect(res.status).toBe(200);
    await sse.waitFor((e) => lastPrimary(e, 'sess-1')?.primary?.status === 'ready');
    sse.close();
  });
});

describe('open/read flips the primary, broadcast for other tabs (DR10)', () => {
  it('POST /research/read flips ready → read and broadcasts the change', async () => {
    setActiveProvider(stubProvider({ primary: { topic: 'T', reason: 'r' } }));
    const sse = openSSE(port);
    await sse.waitFor((e) => e.some((x) => x.type === 'snapshot'));
    await hook('sess-1', 'task');
    await sse.waitFor((e) => lastPrimary(e, 'sess-1')?.primary?.status === 'ready');

    const ts = getSession('sess-1')!.research[0].ts;
    await post('/research/read', { sessionId: 'sess-1', ts });
    await sse.waitFor((e) => lastPrimary(e, 'sess-1')?.primary?.status === 'read');
    expect(getSession('sess-1')?.primary?.status).toBe('read');
    sse.close();
  });
});

describe('reconnect replay (absorbs the SSE-replay TODO)', () => {
  it('a fresh /events connection re-derives the primary from the snapshot', async () => {
    setActiveProvider(stubProvider({ primary: { topic: 'T', reason: 'r' } }));
    const first = openSSE(port);
    await first.waitFor((e) => e.some((x) => x.type === 'snapshot'));
    await hook('sess-1', 'task');
    await first.waitFor((e) => lastPrimary(e, 'sess-1')?.primary?.status === 'ready');
    first.close();

    // Reconnect: the snapshot must carry the ready primary on the session (no separate replay
    // event needed — primary lives on Session).
    const second = openSSE(port);
    await second.waitFor((e) => e.some((x) => x.type === 'snapshot'));
    const snap = second.events.find((e) => e.type === 'snapshot')!.data as {
      sessions: { sessionId: string; primary?: { topic: string; status: string } | null }[];
    };
    const sess = snap.sessions.find((s) => s.sessionId === 'sess-1');
    expect(sess?.primary?.topic).toBe('T');
    expect(sess?.primary?.status).toBe('ready');
    second.close();
  });
});

describe('multi-session: each active session gets its own primary', () => {
  it('two sessions both designate + warm to ready (cap allows 2 concurrent)', async () => {
    setActiveProvider(stubProvider({ primary: { topic: 'Shared topic', reason: 'r' } }));
    const sse = openSSE(port);
    await sse.waitFor((e) => e.some((x) => x.type === 'snapshot'));
    await hook('sess-1', 'task one');
    await hook('sess-2', 'task two');
    await sse.waitFor(
      (e) =>
        lastPrimary(e, 'sess-1')?.primary?.status === 'ready' &&
        lastPrimary(e, 'sess-2')?.primary?.status === 'ready',
    );
    expect(getSession('sess-1')?.primary?.status).toBe('ready');
    expect(getSession('sess-2')?.primary?.status).toBe('ready');
    sse.close();
  });
});
