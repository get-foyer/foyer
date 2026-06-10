import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { cfg } from './config.js';
import { handleSseConnection } from './sse.js';
import { handleHook } from './hooks.js';
import { getActiveProvider } from './providers/index.js';
import {
  getActiveSession,
  getSession,
  resolveResearchSession,
  isResearchInFlight,
  addResearchInFlight,
  removeResearchInFlight,
  closeSession,
  pinSession,
  unpinSession,
  markResearchRead,
} from './state.js';
import { resolveAndStoreResearch, schedulePrefetch, clearPrefetch } from './prefetch.js';
import { summarizeNow } from './activity.js';
import { localhostGuard, isValidSessionId, requireSessionId } from './security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build the Express app: middleware + routes only, no listeners/boot side effects.
 * Extracted from index.ts so routes are testable with supertest.
 */
export function createApp(): express.Express {
  const app = express();

  // Trust boundary FIRST — before body parsing, so rejected requests cost nothing.
  app.use(localhostGuard());

  // Per-route body parsers: /hook carries full prompts and tool_input (file
  // contents for Write/Edit) and needs headroom; every other POST is a few
  // bytes of control data. Per-route is deliberate — a small global parser
  // would consume the body before a route-level override could run.
  const hookJson = express.json({ limit: '1mb' });
  const smallJson = express.json({ limit: '16kb' });

  // -------------------------------------------------------------------------
  // API routes
  // -------------------------------------------------------------------------

  // Claude Code HTTP hooks → single ingest point
  app.post('/hook', hookJson, handleHook);

  // SSE stream for the browser
  app.get('/events', handleSseConnection);

  // Research endpoint
  app.post('/research', smallJson, async (req, res) => {
    const { topic, sessionId } = req.body as { topic?: string; sessionId?: string };
    if (!topic?.trim()) {
      res.status(400).json({ error: 'topic is required' });
      return;
    }

    const provider = getActiveProvider();
    if (!provider) {
      res.status(503).json({
        error: 'No LLM provider configured. Run `foyer setup` to set one up.',
      });
      return;
    }

    const trimmed = topic.trim().slice(0, 200);
    // Target the session the user is *viewing* (body sessionId), falling back to the active
    // one. sessionId is optional here — an invalid one is treated as absent, not a 400.
    const session = resolveResearchSession(
      isValidSessionId(sessionId?.trim()) ? sessionId?.trim() : undefined,
    );

    // In-flight guard: a chip click runs research for 5-30s. If a call for this
    // (session, topic) is already running, no-op — the original call's SSE result
    // will land for both clicks. Prevents duplicate research from a double-click,
    // a second tab, or an activity tick re-surfacing the chip mid-research.
    if (session && isResearchInFlight(session.sessionId, trimmed)) {
      res.status(200).json({ deduped: true });
      return;
    }
    if (session) addResearchInFlight(session.sessionId, trimmed);

    try {
      // With a session, resolveAndStoreResearch serves a warmed (prefetched) result instantly
      // when available, else runs it live, then stores + broadcasts exactly as before. Without a
      // resolvable session there's nowhere to store it — just run it live.
      const result = session
        ? await resolveAndStoreResearch(session, trimmed)
        : await provider.research(trimmed);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Full detail stays server-side — provider errors can embed CLI stderr,
      // paths, or key fragments that must not reach the browser.
      console.error('[/research] Error:', msg);
      res.status(500).json({ error: 'Research failed — see the foyer server logs.' });
    } finally {
      if (session) removeResearchInFlight(session.sessionId, trimmed);
    }
  });

  // Activity summarisation — called by the client-side 30s poll for the viewed session.
  // Triggers an immediate summarisation run (no debounce); result is pushed via SSE.
  app.post('/activity', smallJson, (req, res) => {
    const id = requireSessionId(req, res);
    if (!id) return;

    const provider = getActiveProvider();
    if (!provider) {
      res.status(503).json({
        error: 'No LLM provider configured. Run `foyer setup` to set one up.',
      });
      return;
    }

    // Fire-and-forget — result is broadcast over SSE
    summarizeNow(id);
    // This poll is the ONLY server-side signal of which session the user is viewing. Use it to
    // warm research for that session's current top topics in the background (no-op if disabled).
    const s = getSession(id);
    if (s) schedulePrefetch(s.sessionId, s.suggestedTopics);
    res.status(202).json({});
  });

  // Prefetch-only warm trigger — the WARMING half of /activity, WITHOUT summarising. The client
  // fires this when it lands on a session that's paused (`waiting`) or finished (`done`): the
  // agent isn't producing new activity to summarise, but the user is now most likely to read, so
  // we warm the chips already on screen. Decoupled from /activity on purpose — re-running the
  // summariser on idle sessions would burn provider calls (its skip-if-unchanged guard doesn't
  // cover sessions with no transcript path). Warming itself is idempotent + back-off-guarded.
  app.post('/prefetch', smallJson, (req, res) => {
    const id = requireSessionId(req, res);
    if (!id) return;

    const provider = getActiveProvider();
    if (!provider) {
      res.status(503).json({
        error: 'No LLM provider configured. Run `foyer setup` to set one up.',
      });
      return;
    }

    const s = getSession(id);
    // Skip closed (dismissed) sessions — a stale client must not burn provider calls warming a tab
    // the user already closed.
    if (s && !s.closed) schedulePrefetch(s.sessionId, s.suggestedTopics);
    res.status(202).json({});
  });

  // Close a session — persists a `closed` flag so the tab stays dismissed across restarts
  // (data is kept on disk, not deleted). Returns 200 even for unknown ids (idempotent).
  app.post('/close', smallJson, (req, res) => {
    const id = requireSessionId(req, res);
    if (!id) return;
    closeSession(id);
    clearPrefetch(id); // drop any warmed/queued research for the dismissed tab
    res.status(200).json({});
  });

  // Pin / unpin a session — persists a `pinnedAt` timestamp so the tab stays at the top of the
  // sidebar across reloads/restarts (mirrors /close: write-through, idempotent 200 for unknown
  // ids, no broadcast — the client updates optimistically and the next snapshot reconciles).
  app.post('/pin', smallJson, (req, res) => {
    const id = requireSessionId(req, res);
    if (!id) return;
    const { pinned } = req.body as { pinned?: boolean };
    // Require an explicit boolean — a missing/malformed `pinned` must not silently clear a pin.
    if (typeof pinned !== 'boolean') {
      res.status(400).json({ error: 'pinned must be a boolean' });
      return;
    }
    if (pinned) pinSession(id);
    else unpinSession(id);
    res.status(200).json({});
  });

  // Mark a research briefing as read — persists a `readAt` timestamp so the rail can show "ready to
  // read" (unread, amber) vs "read" (dimmed) honestly across reloads/restarts. Mirrors /pin:
  // write-through, idempotent 200 for unknown ids, no broadcast — the client marks read optimistically
  // and the next snapshot reconciles.
  app.post('/research/read', smallJson, (req, res) => {
    const id = requireSessionId(req, res);
    if (!id) return;
    const { ts } = req.body as { ts?: number };
    // Require a finite numeric ts — a missing/NaN ts must not silently no-op as a "marked read".
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      res.status(400).json({ error: 'ts must be a finite number' });
      return;
    }
    markResearchRead(id, ts);
    res.status(200).json({});
  });

  // Status / health
  app.get('/api/status', (_req, res) => {
    const provider = getActiveProvider();
    res.json({
      ok: true,
      provider: provider?.id ?? null,
      session: getActiveSession(),
    });
  });

  // -------------------------------------------------------------------------
  // Static serving (production: serve built React app)
  // -------------------------------------------------------------------------
  if (cfg.isDev) {
    app.get('/', (_req, res) => {
      res.send(
        '<html><body><p>Dev mode: open <a href="http://localhost:5173">http://localhost:5173</a> for the React app.</p></body></html>',
      );
    });
  } else {
    const publicDir = join(__dirname, '..', 'public');
    if (!existsSync(join(publicDir, 'index.html'))) {
      // Build output is missing — serve a helpful message instead of a raw ENOENT
      app.get('*', (_req, res) => {
        res
          .status(503)
          .send(
            '<html><body style="font-family:monospace;padding:2rem">' +
              '<h2>Dashboard not built</h2>' +
              '<p>Run <code>pnpm build</code> first, then <code>foyer start</code>.</p>' +
              '</body></html>',
          );
      });
    } else {
      app.use(express.static(publicDir));
      app.get('*', (_req, res) => {
        res.sendFile(join(publicDir, 'index.html'));
      });
    }
  }

  return app;
}
