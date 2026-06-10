import { cfg } from './config.js';
import { createApp } from './app.js';
import { setPrimedTopicsProvider, setWarmingTopicsProvider } from './sse.js';
import { buildProvider, setActiveProvider } from './providers/index.js';
import {
  initPersistence,
  hydrateSessions,
  setSessionEndListener,
  setSessionDropListener,
  flushAll,
} from './state.js';
import { clearPrefetch, getPrimedTopics, getWarmingTopics } from './prefetch.js';
import { createJsonStore } from './store.js';
import {
  startStaleSessionWatcher,
  startLiveSummaryPoll,
  forgetActivitySession,
} from './activity.js';

const app = createApp();

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
          `Activity summaries and research will fail. Run \`foyer setup\` to reconfigure.`,
      );
    } else {
      console.log(`✓ LLM provider: ${cfg.provider}`);
    }
  } catch (err) {
    console.warn('⚠  Could not initialize LLM provider:', err);
  }

  const server = app.listen(cfg.port, '127.0.0.1', () => {
    console.log(`\nFoyer running at http://localhost:${cfg.port}`);
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
          `  Another Foyer (or another process) may be running on that port.\n` +
          `  → Stop the other process, or use a different port:\n` +
          `    FOYER_PORT=<port> foyer start\n`,
      );
    } else {
      console.error('✗ Server error:', err);
    }
    process.exit(1);
  });
}

boot().catch(console.error);
