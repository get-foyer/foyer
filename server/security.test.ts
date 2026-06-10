import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { localhostGuard, isValidSessionId, requireSessionId } from './security.js';

// ---------------------------------------------------------------------------
// Express-pure helpers — exercise the middleware without a server.
// ---------------------------------------------------------------------------

function mockReq(headers: Record<string, string>, method = 'GET'): Request {
  return { headers, method } as unknown as Request;
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as typeof res & Response;
}

function run(headers: Record<string, string>, method = 'GET') {
  const res = mockRes();
  const next = vi.fn();
  localhostGuard()(mockReq(headers, method), res, next);
  return { res, next };
}

describe('localhostGuard', () => {
  it('rejects a missing Host header', () => {
    const { res, next } = run({});
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a non-local Host (DNS rebinding)', () => {
    const { res, next } = run({ host: 'rebind.attacker.com:4317' });
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['localhost:4317', '127.0.0.1:4317', '[::1]:4317', 'localhost'])(
    'allows local Host %s',
    (host) => {
      const { next } = run({ host });
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it('allows a localhost Origin (Vite dev server on :5173)', () => {
    const { next } = run({ host: 'localhost:4317', origin: 'http://localhost:5173' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a cross-origin request even with a local Host (CSRF)', () => {
    const { res, next } = run({ host: 'localhost:4317', origin: 'https://attacker.example' });
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unparseable Origin', () => {
    const { res } = run({ host: 'localhost:4317', origin: 'not a url' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a cross-site Sec-Fetch-Site on POST', () => {
    const { res, next } = run({ host: 'localhost:4317', 'sec-fetch-site': 'cross-site' }, 'POST');
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['same-origin', 'same-site', 'none'])('allows Sec-Fetch-Site %s on POST', (site) => {
    const { next } = run({ host: 'localhost:4317', 'sec-fetch-site': site }, 'POST');
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows a bare hook POST (no Origin, no Sec-Fetch-Site)', () => {
    const { next } = run({ host: 'localhost:4317' }, 'POST');
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('isValidSessionId', () => {
  it('accepts a Claude Code UUID', () => {
    expect(isValidSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  });

  it('accepts codex-style ids with dots and colons', () => {
    expect(isValidSessionId('thread_abc:123.v2')).toBe(true);
  });

  it('rejects path traversal', () => {
    expect(isValidSessionId('../../etc/passwd')).toBe(false);
  });

  it('rejects over-long ids', () => {
    expect(isValidSessionId('a'.repeat(129))).toBe(false);
    expect(isValidSessionId('a'.repeat(128))).toBe(true);
  });

  it('rejects empty and non-string values', () => {
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
  });
});

describe('requireSessionId', () => {
  function call(body: unknown) {
    const res = mockRes();
    const req = { body } as unknown as Request;
    return { id: requireSessionId(req, res), res };
  }

  it('returns a trimmed valid id', () => {
    const { id } = call({ sessionId: '  abc-123  ' });
    expect(id).toBe('abc-123');
  });

  it('400s on a missing id', () => {
    const { id, res } = call({});
    expect(id).toBeNull();
    expect(res.statusCode).toBe(400);
  });

  it('400s on an invalid id', () => {
    const { id, res } = call({ sessionId: '../x' });
    expect(id).toBeNull();
    expect(res.statusCode).toBe(400);
  });
});
