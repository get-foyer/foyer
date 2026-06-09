import { describe, it, expect, vi, afterEach } from 'vitest';
import { postHookEvent } from '../cli.js';

// ---------------------------------------------------------------------------
// postHookEvent — pure Codex hook forwarder
//
// The `runCodexHook` shell guarantees exit 0 (covered end-to-end by
// scripts/package-smoke.mjs, which actually execs the built CLI). Here we pin
// the pure core's contract: it builds the { source:'codex' } envelope, POSTs it
// to the configured port, and THROWS on real failures so they're observable.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('postHookEvent', () => {
  it('wraps the payload in a codex envelope and POSTs to the given port', async () => {
    const fetchMock = stubFetch();
    await postHookEvent('UserPromptSubmit', '{"session_id":"s1","prompt":"hi"}', 4317);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4317/hook');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({
      source: 'codex',
      event: 'UserPromptSubmit',
      payload: { session_id: 's1', prompt: 'hi' },
    });
  });

  it('treats empty / whitespace stdin as an empty payload', async () => {
    const fetchMock = stubFetch();
    await postHookEvent('Stop', '   \n', 4317);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      source: 'codex',
      event: 'Stop',
      payload: {},
    });
  });

  it('passes the port through into the URL (even an odd one)', async () => {
    const fetchMock = stubFetch();
    await postHookEvent('PostToolUse', '{}', 5999);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:5999/hook');
  });

  it('throws on malformed JSON (so the shell can log + swallow it)', async () => {
    stubFetch();
    await expect(postHookEvent('UserPromptSubmit', '{not json', 4317)).rejects.toThrow();
  });

  it('propagates a failed fetch (e.g. server down)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postHookEvent('Stop', '{}', 4317)).rejects.toThrow(/ECONNREFUSED/);
  });
});
