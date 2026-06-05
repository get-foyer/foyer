/**
 * POST /hook — single ingest point for all Claude Code HTTP hooks.
 *
 * Returns 200 {} immediately (never blocks the agent).
 * All heavy work (graph generation) happens asynchronously after the response.
 *
 * Self-trigger guard: events whose `cwd` matches our own server directory are
 * ignored (prevents Codex/Claude CLI calls from the server creating phantom tasks).
 */
import type { Request, Response } from 'express';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  startSession,
  addTouchPoint,
  setPlan,
  setGraph,
  setGraphError,
  setGraphGenerating,
  finishSession,
  getSession,
} from './state.js';
import { broadcast } from './sse.js';
import { extractPlanFromTranscript, extractNewestPlan } from './transcript.js';
import { getActiveProvider } from './providers/index.js';

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export async function handleHook(req: Request, res: Response): Promise<void> {
  // Respond immediately — never block the agent
  res.json({});

  const payload = req.body as HookPayload;
  const event = payload.hook_event_name;
  const sessionId = payload.session_id;

  // Self-trigger guard: ignore events that came from our own server directory
  if (payload.cwd === SERVER_DIR || payload.cwd?.startsWith(SERVER_DIR + '/')) {
    return;
  }

  if (!event || !sessionId) return;

  try {
    switch (event) {
      case 'UserPromptSubmit':
        await onUserPrompt(sessionId, payload);
        break;
      case 'PreToolUse':
        if (payload.tool_name === 'ExitPlanMode') {
          await onExitPlanMode(sessionId, payload);
        }
        break;
      case 'PostToolUse':
        await onPostToolUse(sessionId, payload);
        break;
      case 'Stop':
        await onStop(sessionId, payload);
        break;
    }
  } catch (err) {
    console.error(`[hook] Error handling ${event} for ${sessionId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function onUserPrompt(sessionId: string, p: HookPayload): Promise<void> {
  const prompt = (p.prompt ?? '').trim() || '(no prompt)';
  const session = startSession(sessionId, prompt);
  broadcast('task', { sessionId, prompt, startedAt: session.startedAt });
  console.log(`[hook] Task started: ${sessionId} — "${prompt.slice(0, 80)}"`);
}

async function onExitPlanMode(sessionId: string, p: HookPayload): Promise<void> {
  // Strategy 1: plan text in tool_input.plan (classic Claude Code)
  let planText: string | null =
    typeof p.tool_input?.plan === 'string' ? p.tool_input.plan : null;

  // Strategy 2: read plan file referenced from transcript
  if (!planText && p.transcript_path) {
    planText = await extractPlanFromTranscript(p.transcript_path);
  }

  // Strategy 3: newest ~/.claude/plans/*.md
  if (!planText) {
    planText = await extractNewestPlan();
  }

  if (!planText) {
    console.warn(`[hook] Could not extract plan for ${sessionId}`);
    return;
  }

  setPlan(sessionId, planText);
  broadcast('plan', { sessionId, plan: planText });
  console.log(`[hook] Plan captured for ${sessionId} (${planText.length} chars)`);

  // Kick off graph generation asynchronously
  const provider = getActiveProvider();
  if (provider) {
    setGraphGenerating(sessionId);
    broadcast('graph_generating', { sessionId });
    generateGraphAsync(sessionId, planText, provider);
  }
}

async function onPostToolUse(sessionId: string, p: HookPayload): Promise<void> {
  const toolName = p.tool_name ?? 'unknown';
  const filePath =
    typeof p.tool_input?.file_path === 'string'
      ? p.tool_input.file_path
      : typeof p.tool_input?.path === 'string'
        ? p.tool_input.path
        : null;

  if (!filePath) return;

  const tp = { path: filePath, tool: toolName, ts: Date.now() };
  const ok = addTouchPoint(sessionId, tp);

  // If this is an unknown session (e.g. server restarted mid-task), start a minimal one
  if (!ok) {
    startSession(sessionId, '(resumed session)');
    addTouchPoint(sessionId, tp);
  }

  broadcast('touch', { sessionId, ...tp });
}

async function onStop(sessionId: string, p: HookPayload): Promise<void> {
  finishSession(sessionId);
  broadcast('done', { sessionId, finishedAt: Date.now() });
  console.log(`[hook] Task done: ${sessionId}`);
}

// ---------------------------------------------------------------------------
// Async graph generation (fire-and-forget from hook handler)
// ---------------------------------------------------------------------------

function generateGraphAsync(
  sessionId: string,
  planText: string,
  provider: ReturnType<typeof getActiveProvider> & object
): void {
  provider
    .generateGraph(planText)
    .then((mermaid) => {
      setGraph(sessionId, mermaid);
      broadcast('graph', { sessionId, graph: mermaid });
      console.log(`[hook] Graph generated for ${sessionId}`);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setGraphError(sessionId, msg);
      broadcast('graph_error', { sessionId, error: msg });
      console.error(`[hook] Graph generation failed for ${sessionId}:`, msg);
    });
}
