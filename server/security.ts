/**
 * HTTP trust boundary for a localhost-only daemon.
 *
 * Binding 127.0.0.1 keeps remote hosts out, but NOT the user's own browser: a
 * malicious web page can reach this server via DNS rebinding (its hostname
 * re-resolves to 127.0.0.1, so the browser happily sends same-"origin" requests
 * carrying an attacker Host header), reading /events (prompts, summaries,
 * research) and POSTing to every endpoint. The guard below closes that hole by
 * only serving requests whose Host — and, when the browser sends them, Origin
 * and Sec-Fetch-Site — prove a local, same-site context.
 *
 * Non-browser clients (Claude Code hook curl/node POSTs) send no Origin or
 * Sec-Fetch-Site and a localhost Host, so they pass untouched.
 */
import type { Request, RequestHandler, Response } from 'express';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Hostname of a Host/Origin header value, or null if unparseable. */
function hostnameOf(value: string, isOrigin: boolean): string | null {
  try {
    const url = new URL(isOrigin ? value : `http://${value}`);
    // Reject userinfo in Origin (e.g. http://evil.com@127.0.0.1 — hostname resolves
    // to 127.0.0.1 but the request originates from evil.com).
    if (url.username || url.password) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string | null): boolean {
  return hostname !== null && LOCAL_HOSTNAMES.has(hostname);
}

/**
 * Reject requests that don't prove a local, same-site context:
 *  1. Host must be localhost/127.0.0.1/::1 (any port) — defeats DNS rebinding,
 *     where the attacker's hostname resolves to 127.0.0.1 but stays in Host.
 *  2. Origin (when present, all methods — /events is the highest-value read)
 *     must itself be a localhost origin. This admits both the prod same-origin
 *     page (http://localhost:4317) and the Vite dev server (http://localhost:5173,
 *     whose proxy rewrites Host via changeOrigin but forwards Origin unchanged).
 *  3. Sec-Fetch-Site (when present, state-changing methods) must not be 'cross-site'.
 */
export function localhostGuard(): RequestHandler {
  return (req, res, next) => {
    const host = req.headers.host;
    if (!host || !isLocalHostname(hostnameOf(host, false))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && !isLocalHostname(hostnameOf(origin, true))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string' && site === 'cross-site') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Session id validation — route-level hygiene. Persistence is already
// traversal-safe (store.ts sha256-hashes filenames); this caps length and
// charset so arbitrary strings can't bloat the in-memory session Map or logs.
// Covers Claude Code UUIDs and Codex thread ids.
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/**
 * Read and validate `sessionId` from a POST body. Returns the id, or null
 * after sending a 400 — callers just `if (!id) return;`.
 */
export function requireSessionId(req: Request, res: Response): string | null {
  const { sessionId } = req.body as { sessionId?: unknown };
  const id = typeof sessionId === 'string' ? sessionId.trim() : sessionId;
  if (!isValidSessionId(id)) {
    res.status(400).json({ error: 'sessionId is required' });
    return null;
  }
  return id;
}
