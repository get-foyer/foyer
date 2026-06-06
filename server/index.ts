import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { cfg } from './config.js';
import { handleSseConnection } from './sse.js';
import { handleHook } from './hooks.js';
import { buildProvider, setActiveProvider } from './providers/index.js';
import { getActiveProvider } from './providers/index.js';
import type { ResearchResult } from './providers/index.js';
import {
  addResearch,
  getActiveSession,
  resolveResearchSession,
  isResearchInFlight,
  addResearchInFlight,
  removeResearchInFlight,
  initPersistence,
  hydrateSessions,
  closeSession,
  flushAll,
} from './state.js';
import { createJsonStore } from './store.js';
import { broadcast } from './sse.js';
import { summarizeNow, startStaleSessionWatcher } from './activity.js';

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
    const result: ResearchResult = await provider.research(trimmed);
    if (session) {
      const withTs = { ...result, topic: trimmed, ts: Date.now() };
      addResearch(session.sessionId, withTs);
      broadcast('research_result', { sessionId: session.sessionId, ...withTs });
    }
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
  summarizeNow(sessionId.trim());
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
    console.log(`\n🚪 Agent Foyer running at http://localhost:${cfg.port}`);
    if (cfg.isDev) {
      console.log(`   React app: http://localhost:5173  (run \`npm run dev\`)`);
    } else {
      console.log(`   Dashboard: http://localhost:${cfg.port}`);
    }
    console.log(`   Hooks endpoint: POST http://localhost:${cfg.port}/hook\n`);
  });

  // Auto-close sessions whose transcript goes quiet (handles Ctrl-C / hard kill)
  startStaleSessionWatcher();

  // Friendly error for the most common boot failure
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n✗ Port ${cfg.port} is already in use.\n` +
          `  Another Agent Foyer (or another process) may be running on that port.\n` +
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
