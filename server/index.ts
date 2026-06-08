import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { cfg } from './config.js';
import { handleSseConnection, setPrimedTopicsProvider, setWarmingTopicsProvider } from './sse.js';
import { handleHook } from './hooks.js';
import { buildProvider, setActiveProvider } from './providers/index.js';
import { getActiveProvider } from './providers/index.js';
import {
  getActiveSession,
  getSession,
  resolveResearchSession,
  isResearchInFlight,
  addResearchInFlight,
  removeResearchInFlight,
  initPersistence,
  hydrateSessions,
  closeSession,
  pinSession,
  unpinSession,
  setSessionEndListener,
  setSessionDropListener,
  flushAll,
} from './state.js';
import {
  resolveAndStoreResearch,
  schedulePrefetch,
  clearPrefetch,
  getPrimedTopics,
  getWarmingTopics,
} from './prefetch.js';
import { createJsonStore } from './store.js';
import {
  summarizeNow,
  startStaleSessionWatcher,
  startLiveSummaryPoll,
  forgetActivitySession,
} from './activity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Parse JSON bodies for hook POSTs
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Claude Code HTTP hooks → single ingest point
app.post('/hook', handleHook);

// SSE stream for the browser
app.get('/events', handleSseConnection);

// Research endpoint
app.post('/research', async (req, res) => {
  const { topic, sessionId } = req.body as { topic?: string; sessionId?: string };
  if (!topic?.trim()) {
    res.status(400).json({ error: 'topic is required' });
    return;
  }

  const provider = getActiveProvider();
  if (!provider) {
    res.status(503).json({
      error: 'No LLM provider configured. Run `npm run setup` to set one up.',
    });
    return;
  }

  const trimmed = topic.trim();
  // Target the session the user is *viewing* (body sessionId), falling back to the active one.
  const session = resolveResearchSession(sessionId);

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
    console.error('[/research] Error:', msg);
    res.status(500).json({ error: msg });
  } finally {
    if (session) removeResearchInFlight(session.sessionId, trimmed);
  }
});

// Activity summarisation — called by the client-side 30s poll for the viewed session.
// Triggers an immediate summarisation run (no debounce); result is pushed via SSE.
app.post('/activity', (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId?.trim()) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }

  const provider = getActiveProvider();
  if (!provider) {
    res.status(503).json({
      error: 'No LLM provider configured. Run `npm run setup` to set one up.',
    });
    return;
  }

  // Fire-and-forget — result is broadcast over SSE
  const id = sessionId.trim();
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
app.post('/prefetch', (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId?.trim()) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }

  const provider = getActiveProvider();
  if (!provider) {
    res.status(503).json({
      error: 'No LLM provider configured. Run `npm run setup` to set one up.',
    });
    return;
  }

  const s = getSession(sessionId.trim());
  // Skip closed (dismissed) sessions — a stale client must not burn provider calls warming a tab
  // the user already closed.
  if (s && !s.closed) schedulePrefetch(s.sessionId, s.suggestedTopics);
  res.status(202).json({});
});

// Close a session — persists a `closed` flag so the tab stays dismissed across restarts
// (data is kept on disk, not deleted). Returns 200 even for unknown ids (idempotent).
app.post('/close', (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId?.trim()) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }
  closeSession(sessionId.trim());
  clearPrefetch(sessionId.trim()); // drop any warmed/queued research for the dismissed tab
  res.status(200).json({});
});

// Pin / unpin a session — persists a `pinnedAt` timestamp so the tab stays at the top of the
// sidebar across reloads/restarts (mirrors /close: write-through, idempotent 200 for unknown
// ids, no broadcast — the client updates optimistically and the next snapshot reconciles).
app.post('/pin', (req, res) => {
  const { sessionId, pinned } = req.body as { sessionId?: string; pinned?: boolean };
  if (!sessionId?.trim()) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }
  // Require an explicit boolean — a missing/malformed `pinned` must not silently clear a pin.
  if (typeof pinned !== 'boolean') {
    res.status(400).json({ error: 'pinned must be a boolean' });
    return;
  }
  const id = sessionId.trim();
  if (pinned) pinSession(id);
  else unpinSession(id);
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

// ---------------------------------------------------------------------------
// Static serving (production: serve built React app)
// ---------------------------------------------------------------------------
if (cfg.isDev) {
  app.get('/', (_req, res) => {
    res.send(
      '<html><body><p>Dev mode: open <a href="http://localhost:5173">http://localhost:5173</a> for the React app.</p></body></html>',
    );
  });
} else {
  const publicDir = join(__dirname, '..', 'dist', 'public');
  if (!existsSync(join(publicDir, 'index.html'))) {
    // Build output is missing — serve a helpful message instead of a raw ENOENT
    app.get('*', (_req, res) => {
      res
        .status(503)
        .send(
          '<html><body style="font-family:monospace;padding:2rem">' +
            '<h2>Dashboard not built</h2>' +
            '<p>Run <code>npm run build</code> first, then <code>npm start</code>.</p>' +
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // Let the SSE layer replay primed-research dots on (re)connect without importing prefetch.ts
  // (avoids an sse↔prefetch cycle — prefetch already imports broadcast from sse).
  setPrimedTopicsProvider(getPrimedTopics);
  setWarmingTopicsProvider(getWarmingTopics);

  // Free a session's prefetch cache when it ends (done/stale/turn-end), mirroring the /close
  // path. Injected so state.ts stays free of a prefetch import (one-way: prefetch → state).
  setSessionEndListener(clearPrefetch);
  // When retention removes a session from the live in-memory window, also clear longer-lived
  // scheduler/watch metadata. Normal finish keeps activity metadata long enough for the final
  // summarizeNow() call in hooks.ts.
  setSessionDropListener((sessionId) => {
    clearPrefetch(sessionId);
    forgetActivitySession(sessionId);
  });

  // Persistence: install the JSON store and hydrate prior sessions before serving, so the
  // first SSE snapshot already carries them. createJsonStore falls back to in-memory only
  // if the data dir isn't writable — persistence failure never blocks the tool.
  const store = createJsonStore(cfg.dataDir);
  initPersistence(store);
  const restored = store.hydrate();
  hydrateSessions(restored);
  if (restored.length > 0) {
    console.log(`✓ Restored ${restored.length} session(s) from ${cfg.dataDir}`);
  }

  // Flush pending session writes on shutdown so the last state survives Ctrl-C / SIGTERM.
  const shutdown = () => {
    flushAll();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Initialize LLM provider
  try {
    const provider = await buildProvider(cfg.provider);
    setActiveProvider(provider);
    const available = await provider.isAvailable();
    if (!available) {
      console.warn(
        `⚠  Provider "${cfg.provider}" is not available. ` +
          `Graph generation and research will fail. Run \`npm run setup\` to reconfigure.`,
      );
    } else {
      console.log(`✓ LLM provider: ${cfg.provider}`);
    }
  } catch (err) {
    console.warn('⚠  Could not initialize LLM provider:', err);
  }

  const server = app.listen(cfg.port, '127.0.0.1', () => {
    console.log(`\n🚪 Foyer Gate running at http://localhost:${cfg.port}`);
    if (cfg.isDev) {
      console.log(`   React app: http://localhost:5173  (run \`npm run dev\`)`);
    } else {
      console.log(`   Dashboard: http://localhost:${cfg.port}`);
    }
    console.log(`   Hooks endpoint: POST http://localhost:${cfg.port}/hook\n`);
  });

  // Auto-close sessions whose transcript goes quiet (handles Ctrl-C / hard kill)
  startStaleSessionWatcher();

  // Live summarisation: re-summarise any working session whose transcript grew (catches
  // assistant-text-only turns, which fire no tool hook — see activity.ts trigger #4).
  startLiveSummaryPoll();

  // Friendly error for the most common boot failure
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n✗ Port ${cfg.port} is already in use.\n` +
          `  Another Foyer Gate (or another process) may be running on that port.\n` +
          `  → Stop the other process, or use a different port:\n` +
          `    FOYER_PORT=<port> npm start\n`,
      );
    } else {
      console.error('✗ Server error:', err);
    }
    process.exit(1);
  });
}

boot().catch(console.error);
