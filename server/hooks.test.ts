/**
 * Tests for the self-trigger guard in handleHook.
 *
 * Uses the real state module (reset between tests) and mocks SSE/activity so
 * we can assert on session creation without spawning real subprocesses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// vi.mock() is hoisted by vitest — these factories run before any imports.

vi.mock('./sse.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('./activity.js', () => ({
  recordTranscriptPath: vi.fn(),
  scheduleSummarize: vi.fn(),
  summarizeNow: vi.fn(),
  stopTranscriptWatcher: vi.fn(),
  resetSummarizeBaseline: vi.fn(),
}));

import { handleHook } from './hooks.js';
import { _resetStateForTest, getAllSessions, getSession, closeSession } from './state.js';
import { broadcast } from './sse.js';
import { FOYER_INTERNAL_DIR_PREFIX, FOYER_INTERNAL_SENTINEL } from './providers/internal.js';

function fakeReq(body: unknown): Request {
  return { body } as unknown as Request;
}

function fakeRes(): Response {
  return { json: vi.fn() } as unknown as Response;
}

beforeEach(() => {
  _resetStateForTest();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Self-trigger guard — events from Foyer's own LLM subprocess calls are dropped
// ---------------------------------------------------------------------------

describe('handleHook self-trigger guard', () => {
  it('drops UserPromptSubmit when cwd contains the internal dir prefix', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'abc-self',
        cwd: `/tmp/${FOYER_INTERNAL_DIR_PREFIX}xyz123`,
        prompt: 'You are narrating, for a live dashboard…',
      }),
      fakeRes(),
    );

    expect(getAllSessions()).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalledWith('task', expect.anything());
  });

  it('drops UserPromptSubmit when prompt contains the sentinel', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'abc-sentinel',
        cwd: '/real/project',
        prompt: `${FOYER_INTERNAL_SENTINEL}\nYou are narrating, for a live dashboard…`,
      }),
      fakeRes(),
    );

    expect(getAllSessions()).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalledWith('task', expect.anything());
  });

  it('drops Stop when cwd contains the internal dir prefix (prevents amplification loop)', async () => {
    // This is the critical amplification path: an internal claude -p Stop event
    // would normally call summarizeNow() → another claude -p → another phantom tab.
    await handleHook(
      fakeReq({
        hook_event_name: 'Stop',
        session_id: 'abc-stop-self',
        cwd: `/tmp/${FOYER_INTERNAL_DIR_PREFIX}xyz123`,
      }),
      fakeRes(),
    );

    expect(broadcast).not.toHaveBeenCalledWith('done', expect.anything());
  });

  it('drops PostToolUse when cwd contains the internal dir prefix', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: 'abc-tool-self',
        cwd: `/var/folders/xy/${FOYER_INTERNAL_DIR_PREFIX}abc/`,
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/out.json' },
      }),
      fakeRes(),
    );

    expect(getAllSessions()).toHaveLength(0);
  });

  it('drops a Codex-envelope event when the payload cwd contains the prefix', async () => {
    // Codex payloads arrive wrapped in { source:'codex', event, payload }
    await handleHook(
      fakeReq({
        source: 'codex',
        event: 'UserPromptSubmit',
        payload: {
          session_id: 'codex-self-123',
          cwd: `/tmp/${FOYER_INTERNAL_DIR_PREFIX}codex-999`,
          prompt: 'You are narrating…',
        },
      }),
      fakeRes(),
    );

    expect(getAllSessions()).toHaveLength(0);
  });

  it('drops a Codex-envelope event when the payload prompt contains the sentinel', async () => {
    await handleHook(
      fakeReq({
        source: 'codex',
        event: 'UserPromptSubmit',
        payload: {
          session_id: 'codex-sentinel-456',
          cwd: '/real/path',
          prompt: `${FOYER_INTERNAL_SENTINEL}\nGraph prompt`,
        },
      }),
      fakeRes(),
    );

    expect(getAllSessions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Normal passthrough — genuine user events must still work after the guard
// ---------------------------------------------------------------------------

describe('handleHook passthrough for genuine events', () => {
  it('creates a session for a real UserPromptSubmit', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'real-session-1',
        cwd: '/home/user/myproject',
        prompt: 'Fix the authentication bug',
      }),
      fakeRes(),
    );

    const sessions = getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('real-session-1');
    expect(sessions[0].prompt).toBe('Fix the authentication bug');
    expect(broadcast).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ sessionId: 'real-session-1' }),
    );
  });

  it('does not create a session when session_id is missing (unchanged behaviour)', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        // no session_id
        prompt: 'Something',
      }),
      fakeRes(),
    );

    expect(getAllSessions()).toHaveLength(0);
  });

  it('processes two distinct real sessions independently', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-a',
        cwd: '/home/user/project',
        prompt: 'Task A',
      }),
      fakeRes(),
    );
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-b',
        cwd: '/home/user/project',
        prompt: 'Task B',
      }),
      fakeRes(),
    );

    const sessions = getAllSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b']);
  });

  it('continues (does not duplicate) when the same id arrives twice; identical prompt is deduped', async () => {
    const body = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'dup-sess',
      cwd: '/home/user/project',
      prompt: 'Duplicate prompt',
    };
    await handleHook(fakeReq(body), fakeRes());
    await handleHook(fakeReq(body), fakeRes());

    // Same session_id continues the existing session (no second entry); an identical
    // consecutive prompt is deduped, so the arc stays length 1.
    const sessions = getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].prompts).toEqual(['Duplicate prompt']);
  });

  it('a follow-up prompt continues the session: accumulates the arc', async () => {
    const sessionId = 'multi-turn';
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: '/home/user/project',
        prompt: 'Build the feature',
      }),
      fakeRes(),
    );
    // A tool hook in turn 1 keeps the session working
    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: '/home/user/project',
        tool_name: 'Write',
        tool_input: { file_path: '/src/feature.ts' },
      }),
      fakeRes(),
    );
    // Turn 2: a new prompt must NOT wipe the session
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: '/home/user/project',
        prompt: 'Now add tests',
      }),
      fakeRes(),
    );

    const sessions = getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].prompts).toEqual(['Build the feature', 'Now add tests']);
    expect(sessions[0].prompt).toBe('Now add tests');
  });

  it('tool activity after a stale done state revives the session row', async () => {
    const sessionId = 'stale-done-tool';
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: '/home/user/project',
        prompt: 'Keep working',
      }),
      fakeRes(),
    );
    await handleHook(
      fakeReq({
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: '/home/user/project',
      }),
      fakeRes(),
    );
    expect(getSession(sessionId)!.status).toBe('done');

    vi.mocked(broadcast).mockClear();
    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: '/home/user/project',
        tool_name: 'Write',
        tool_input: { file_path: '/src/live.ts' },
      }),
      fakeRes(),
    );

    const s = getSession(sessionId)!;
    expect(s.status).toBe('working');
    expect(s.finishedAt).toBeNull();
    expect(broadcast).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ sessionId, prompt: 'Keep working' }),
    );
  });

  it('does NOT revive a CLOSED (dismissed) session on late tool activity', async () => {
    const sessionId = 'closed-no-revive';
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: '/home/user/project',
        prompt: 'work',
      }),
      fakeRes(),
    );
    await handleHook(
      fakeReq({ hook_event_name: 'Stop', session_id: sessionId, cwd: '/home/user/project' }),
      fakeRes(),
    );
    expect(getSession(sessionId)!.status).toBe('done');
    closeSession(sessionId); // user dismisses the tab; agent keeps running

    vi.mocked(broadcast).mockClear();
    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: '/home/user/project',
        tool_name: 'Write',
        tool_input: { file_path: '/src/live.ts' },
      }),
      fakeRes(),
    );

    const s = getSession(sessionId)!;
    expect(s.closed).toBe(true); // stays dismissed
    expect(s.status).not.toBe('working'); // not resurrected
    expect(broadcast).not.toHaveBeenCalledWith('task', expect.objectContaining({ sessionId }));
  });

  it('does NOT revive a terminal INTERRUPTED session on late tool activity', async () => {
    const sessionId = 'interrupted-no-revive';
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: '/home/user/project',
        prompt: 'work',
      }),
      fakeRes(),
    );
    // Simulate crash-recovery terminal state (ADR 0002).
    const before = getSession(sessionId)!;
    before.status = 'interrupted';
    before.finishedAt = 123;

    vi.mocked(broadcast).mockClear();
    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: '/home/user/project',
        tool_name: 'Write',
        tool_input: { file_path: '/src/live.ts' },
      }),
      fakeRes(),
    );

    const s = getSession(sessionId)!;
    expect(s.status).toBe('interrupted'); // terminal state preserved
    expect(s.finishedAt).toBe(123);
    expect(broadcast).not.toHaveBeenCalledWith('task', expect.objectContaining({ sessionId }));
  });

  it('non-file tool activity after a stale done state revives the session row', async () => {
    const sessionId = 'stale-done-shell';
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd: '/home/user/project',
        prompt: 'Run checks',
      }),
      fakeRes(),
    );
    await handleHook(
      fakeReq({
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: '/home/user/project',
      }),
      fakeRes(),
    );
    expect(getSession(sessionId)!.status).toBe('done');

    vi.mocked(broadcast).mockClear();
    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: '/home/user/project',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
      }),
      fakeRes(),
    );

    const s = getSession(sessionId)!;
    expect(s.status).toBe('working');
    expect(s.finishedAt).toBeNull();
    expect(broadcast).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ sessionId, prompt: 'Run checks' }),
    );
  });
});

// ---------------------------------------------------------------------------
// active focus signal — emitted ONLY on genuine user prompts (never on the
// agent-driven `task` re-broadcasts), so the dashboard follows YOUR interaction.
// ---------------------------------------------------------------------------

describe('handleHook active focus signal', () => {
  it('emits `active` on a real UserPromptSubmit', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'focus-1',
        cwd: '/home/user/project',
        prompt: 'Do the thing',
      }),
      fakeRes(),
    );
    expect(broadcast).toHaveBeenCalledWith('active', { sessionId: 'focus-1' });
  });

  it('does NOT emit `active` when a PostToolUse clears a waiting session (agent-driven)', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'focus-2',
        cwd: '/home/user/project',
        prompt: 'Start',
      }),
      fakeRes(),
    );
    await handleHook(
      fakeReq({
        hook_event_name: 'Notification',
        session_id: 'focus-2',
        cwd: '/home/user/project',
        notification_type: 'permission_prompt',
        message: 'Allow Bash?',
      }),
      fakeRes(),
    );
    vi.mocked(broadcast).mockClear();
    // A tool completes → clears waiting, re-broadcasts `task`, but must NOT steal focus.
    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: 'focus-2',
        cwd: '/home/user/project',
        tool_name: 'Write',
        tool_input: { file_path: '/src/x.ts' },
      }),
      fakeRes(),
    );
    expect(broadcast).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ sessionId: 'focus-2' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith('active', expect.anything());
  });

  it('does NOT emit `active` when an unknown session is resumed via Notification', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'Notification',
        session_id: 'focus-3',
        cwd: '/home/user/project',
        notification_type: 'permission_prompt',
        message: 'Allow Bash?',
      }),
      fakeRes(),
    );
    expect(broadcast).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ sessionId: 'focus-3' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith('active', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Resumed-session title recovery — a hook for an UNKNOWN session (Foyer started
// mid-turn) must recover a real title from the transcript instead of showing the
// "(resumed session)" placeholder.
// ---------------------------------------------------------------------------

describe('handleHook resumed-session title recovery', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'foyer-hooks-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeTranscript(prompt: string): Promise<string> {
    const path = join(tempDir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: prompt } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
    ];
    await writeFile(path, lines.join('\n'), 'utf-8');
    return path;
  }

  it('PostToolUse for an unknown session uses the transcript prompt as the title', async () => {
    const transcript = await writeTranscript('Refactor the billing service');

    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: 'unknown-1',
        cwd: '/home/user/billing',
        transcript_path: transcript,
        tool_name: 'Write',
        tool_input: { file_path: '/src/billing.ts' },
      }),
      fakeRes(),
    );

    const s = getSession('unknown-1');
    expect(s).not.toBeNull();
    expect(s!.prompt).toBe('Refactor the billing service');
    expect(s!.prompt).not.toBe('(resumed session)');
  });

  it('falls back to the cwd folder name when the transcript has no usable prompt', async () => {
    await handleHook(
      fakeReq({
        hook_event_name: 'PostToolUse',
        session_id: 'unknown-2',
        cwd: '/home/user/my-cool-app',
        // no transcript_path → recovery skips straight to cwd basename
        tool_name: 'Write',
        tool_input: { file_path: '/src/x.ts' },
      }),
      fakeRes(),
    );

    const s = getSession('unknown-2');
    expect(s).not.toBeNull();
    expect(s!.prompt).toBe('(resumed: my-cool-app)');
  });

  it('Notification for an unknown session recovers the title and broadcasts it', async () => {
    const transcript = await writeTranscript('Add OAuth login');

    await handleHook(
      fakeReq({
        hook_event_name: 'Notification',
        session_id: 'unknown-3',
        cwd: '/home/user/auth',
        transcript_path: transcript,
        notification_type: 'permission_prompt',
        message: 'Allow Bash?',
      }),
      fakeRes(),
    );

    const s = getSession('unknown-3');
    expect(s).not.toBeNull();
    expect(s!.prompt).toBe('Add OAuth login');
    expect(s!.status).toBe('waiting');
    // The task broadcast carries the recovered title, not the placeholder.
    expect(broadcast).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ sessionId: 'unknown-3', prompt: 'Add OAuth login' }),
    );
  });
});
