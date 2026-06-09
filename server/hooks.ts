/**
 * POST /hook — single ingest point for all Claude Code HTTP hooks and the Codex command shim.
 *
 * Returns 200 {} immediately (never blocks the agent).
 * All heavy work (activity summarisation) happens asynchronously after the response.
 */
import type { Request, Response } from 'express';
import { basename } from 'path';
import {
  startSession,
  setWaiting,
  clearWaiting,
  finishSession,
  getSession,
  markWorking,
} from './state.js';
import { broadcast } from './sse.js';
import {
  recordTranscriptPath,
  scheduleSummarize,
  summarizeNow,
  stopTranscriptWatcher,
  resetSummarizeBaseline,
} from './activity.js';
import { readFirstUserPrompt } from './transcript.js';
import { isSelfOriginatedHook } from './providers/internal.js';

// ---------------------------------------------------------------------------
// Claude Code hook payload shape
// ---------------------------------------------------------------------------

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // Claude Code Notification fields (exact names confirmed by live payload inspection)
  notification_type?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Codex command-hook envelope — `foyer hook codex` wraps Codex payloads
// as { source:'codex', event:<CodexEvent>, payload:<raw> }.
// ---------------------------------------------------------------------------

interface CodexEnvelope {
  source: 'codex';
  event: string;
  payload: Record<string, unknown>;
}

function isCodexEnvelope(body: unknown): body is CodexEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>).source === 'codex'
  );
}

/** Map Codex lifecycle event names to the internal event strings the switch uses. */
function mapCodexEvent(codexEvent: string): string {
  switch (codexEvent) {
    case 'PermissionRequest':
      return 'Notification'; // treated as a waiting signal
    case 'UserPromptSubmit':
      return 'UserPromptSubmit';
    case 'PostToolUse':
      return 'PostToolUse';
    case 'Stop':
      return 'Stop';
    default:
      return codexEvent;
  }
}

/** Notification types that mean the agent is waiting on human input. */
const WAITING_NOTIFICATION_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
]);

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleHook(req: Request, res: Response): Promise<void> {
  // Respond immediately — never block the agent
  res.json({});

  const body = req.body as HookPayload | CodexEnvelope;

  // Normalise Codex envelope onto the flat HookPayload shape the switch expects.
  let event: string | undefined;
  let sessionId: string | undefined;
  let payload: HookPayload;

  if (isCodexEnvelope(body)) {
    event = mapCodexEvent(body.event);
    // Codex session id may live under different keys depending on the version
    sessionId =
      (body.payload.session_id as string | undefined) ??
      (body.payload.conversation_id as string | undefined) ??
      (body.payload.thread_id as string | undefined);
    // Flatten the Codex payload so handlers can read standard fields
    payload = {
      hook_event_name: event,
      session_id: sessionId,
      cwd: body.payload.cwd as string | undefined,
      prompt: body.payload.prompt as string | undefined,
      tool_name: body.payload.tool_name as string | undefined,
      tool_input: body.payload.tool_input as Record<string, unknown> | undefined,
      // For PermissionRequest→Notification: surface the permission reason as message
      notification_type: 'permission_prompt',
      message:
        (body.payload.message as string | undefined) ??
        (body.payload.description as string | undefined) ??
        (body.payload.command as string | undefined),
    };
  } else {
    payload = body;
    event = payload.hook_event_name;
    sessionId = payload.session_id;
  }

  if (!event || !sessionId) return;

  // Server-side backstop: silently drop any hook event that originated from
  // Foyer's own internal LLM subprocess calls.  Without this guard, each
  // `claude -p` / `codex exec` narration call would register a new phantom
  // session with the title "You are narrating, for a live dashboard…".
  // This check is provider-agnostic and catches self-triggered Stop / PostToolUse
  // events too, which would otherwise amplify (Stop → summarizeNow → another call).
  if (isSelfOriginatedHook(payload)) {
    console.log(`[hook] dropped self-originated ${event} for ${sessionId}`);
    return;
  }

  try {
    switch (event) {
      case 'UserPromptSubmit':
        await onUserPrompt(sessionId, payload);
        break;
      case 'PreToolUse':
        if (payload.tool_name === 'ExitPlanMode') {
          // Plan presented/approved — clear the plan-approval wait and refresh the focus now
          // that the agent is about to resume real work.
          clearWaiting(sessionId);
          summarizeNow(sessionId);
        } else if (payload.tool_name === 'AskUserQuestion') {
          // Extract the first question text from the `questions` array
          const qs = payload.tool_input?.questions;
          const firstQ =
            Array.isArray(qs) && qs.length > 0 ? (qs[0] as Record<string, unknown>) : null;
          const questionText = typeof firstQ?.question === 'string' ? firstQ.question.trim() : '';
          await onNotification(sessionId, {
            ...payload,
            notification_type: 'elicitation_dialog',
            message: questionText || 'Response required',
          });
        }
        break;
      case 'PostToolUse':
        await onPostToolUse(sessionId, payload);
        break;
      case 'Notification':
        await onNotification(sessionId, payload);
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

/**
 * Best-effort title for a session Foyer first sees mid-turn (no UserPromptSubmit
 * carrying the prompt). Without this, every such tab reads "(resumed session)".
 * Tries, in order: the original task from the transcript head → the project
 * folder name from cwd → the bare placeholder.
 */
async function recoverTitle(p: HookPayload): Promise<string> {
  if (p.transcript_path) {
    const first = await readFirstUserPrompt(p.transcript_path);
    if (first) return first;
  }
  if (p.cwd) {
    const base = basename(p.cwd);
    if (base) return `(resumed: ${base})`;
  }
  return '(resumed session)';
}

async function onUserPrompt(sessionId: string, p: HookPayload): Promise<void> {
  const prompt = (p.prompt ?? '').trim() || '(no prompt)';
  const { session, continued } = startSession(sessionId, prompt);
  // Record the transcript path immediately — activity.ts uses it for summarisation context
  recordTranscriptPath(sessionId, p.transcript_path);
  broadcast('task', { sessionId, prompt, prompts: session.prompts, startedAt: session.startedAt });
  // Focus signal: a genuine user prompt makes this the live channel. Emitted ONLY here (never
  // on the agent-driven `task` broadcasts in onPostToolUse / onNotification), so the dashboard
  // follows where you're interacting without being yanked by autonomous agent activity. Must
  // come AFTER `task` so the client has the session before it's asked to focus it (SSE is ordered).
  broadcast('active', { sessionId });
  // On a follow-up prompt (continue), the transcript may not have grown past the last
  // summary yet — force the next run so the new focus is reflected immediately.
  if (continued) resetSummarizeBaseline(sessionId);
  // Kick off summarisation immediately so panels show a "thinking" spinner from t=0.
  // Fire-and-forget: handleHook already returned 200 before this runs, so the
  // agent is never blocked. The single-flight + skip-if-unchanged guards in
  // activity.ts prevent redundant calls if PostToolUse fires soon after.
  summarizeNow(sessionId);
  console.log(
    `[hook] Task ${continued ? 'continued' : 'started'}: ${sessionId} — "${prompt.slice(0, 80)}"`,
  );
}

async function onPostToolUse(sessionId: string, p: HookPayload): Promise<void> {
  // Any tool completion proves the agent is active again. This also repairs a stale
  // terminal state if Stop / transcript auto-close reached us before later hook traffic.
  const s = getSession(sessionId);
  if (!s) {
    // Unknown session (e.g. server restarted mid-task) — resume it with a real title
    // recovered from the transcript instead of an opaque placeholder, so tool activity
    // after a restart resurrects the tab.
    const title = await recoverTitle(p);
    startSession(sessionId, title);
  } else if (!s.closed && (s.status === 'waiting' || s.status === 'done')) {
    // Only revive sessions that are merely waiting or prematurely done — never a tab the
    // user dismissed (closed) nor a terminal `interrupted` session (crash-recovery, ADR
    // 0002); a still-running agent's late hooks must not resurrect either of those.
    markWorking(sessionId);
    const live = getSession(sessionId) ?? s;
    broadcast('task', {
      sessionId,
      prompt: live.prompt,
      prompts: live.prompts,
      startedAt: live.startedAt,
    });
  }

  // Update the transcript path and schedule a debounced summarisation.
  recordTranscriptPath(sessionId, p.transcript_path);
  scheduleSummarize(sessionId);
}

async function onNotification(sessionId: string, p: HookPayload): Promise<void> {
  // Only certain notification types mean the agent is waiting on us
  const ntype = p.notification_type ?? '';
  if (!WAITING_NOTIFICATION_TYPES.has(ntype)) return;

  const defaultReason: Record<string, string> = {
    permission_prompt: 'Permission requested',
    idle_prompt: 'Waiting for your input',
    elicitation_dialog: 'Response required',
  };
  const reason = (p.message ?? '').trim() || defaultReason[ntype] || 'Needs your attention';

  const ok = setWaiting(sessionId, reason);
  if (!ok) {
    // Unknown session (e.g. server restarted mid-task) — resume with a real title
    // recovered from the transcript instead of an opaque placeholder.
    // Broadcast `task` first so the client adds the session before the `waiting` event arrives.
    const title = await recoverTitle(p);
    const { session: s } = startSession(sessionId, title);
    broadcast('task', {
      sessionId,
      prompt: title,
      prompts: s.prompts,
      startedAt: s.startedAt,
    });
    setWaiting(sessionId, reason);
  }

  broadcast('waiting', { sessionId, reason });
  console.log(`[hook] Waiting on user: ${sessionId} — ${ntype}: ${reason.slice(0, 80)}`);
}

async function onStop(sessionId: string, _p: HookPayload): Promise<void> {
  finishSession(sessionId);
  stopTranscriptWatcher(sessionId); // clean up — watcher is redundant once Stop fires
  broadcast('done', { sessionId, finishedAt: Date.now() });
  console.log(`[hook] Task done: ${sessionId}`);
  // Fire a final summarisation so the completed session state is captured
  summarizeNow(sessionId);
}
