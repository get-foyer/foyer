import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cfg } from './config.js';
import { handleSseConnection } from './sse.js';
import { handleHook } from './hooks.js';
import { buildProvider, setActiveProvider } from './providers/index.js';
import { getActiveProvider } from './providers/index.js';
import type { ResearchResult } from './providers/index.js';
import { addResearch, getActiveSession } from './state.js';
import { broadcast } from './sse.js';

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
  const { topic } = req.body as { topic?: string };
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

  try {
    const result: ResearchResult = await provider.research(topic.trim());
    const session = getActiveSession();
    if (session) {
      const withTs = { ...result, topic, ts: Date.now() };
      addResearch(session.sessionId, withTs);
      broadcast('research_result', { sessionId: session.sessionId, ...withTs });
    }
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/research] Error:', msg);
    res.status(500).json({ error: msg });
  }
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
      '<html><body><p>Dev mode: open <a href="http://localhost:5173">http://localhost:5173</a> for the React app.</p></body></html>'
    );
  });
} else {
  const publicDir = join(__dirname, '..', 'dist', 'public');
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => {
    res.sendFile(join(publicDir, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // Initialize LLM provider
  try {
    const provider = await buildProvider(cfg.provider);
    setActiveProvider(provider);
    const available = await provider.isAvailable();
    if (!available) {
      console.warn(
        `⚠  Provider "${cfg.provider}" is not available. ` +
        `Graph generation and research will fail. Run \`npm run setup\` to reconfigure.`
      );
    } else {
      console.log(`✓ LLM provider: ${cfg.provider}`);
    }
  } catch (err) {
    console.warn('⚠  Could not initialize LLM provider:', err);
  }

  app.listen(cfg.port, '127.0.0.1', () => {
    console.log(`\n🚪 Agent Foyer running at http://localhost:${cfg.port}`);
    if (cfg.isDev) {
      console.log(`   React app: http://localhost:5173  (run \`npm run dev\`)`);
    } else {
      console.log(`   Dashboard: http://localhost:${cfg.port}`);
    }
    console.log(`   Hooks endpoint: POST http://localhost:${cfg.port}/hook\n`);
  });
}

boot().catch(console.error);
