/**
 * Tests for the self-trigger guard in handleHook.
 *
 * Uses the real state module (reset between tests) and mocks SSE/activity so
 * we can assert on session creation without spawning real subprocesses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// vi.mock() is hoisted by vitest — these factories run before any imports.

vi.mock('./sse.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('./activity.js', () => ({
  recordTranscriptPath: vi.fn(),
  scheduleSummarize: vi.fn(),
  summarizeNow: vi.fn(),
  resetSummarizeBaseline: vi.fn(),
}));

import { handleHook } from './hooks.js';
import { _resetStateForTest, getAllSessions } from './state.js';
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
    expect(broadcast).not.toHaveBeenCalledWith('touch', expect.anything());
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

  it('a follow-up prompt continues the session: accumulates the arc and keeps touchpoints', async () => {
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
    // A file edit in turn 1 records a touchpoint
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
    // Touchpoint from turn 1 survives the follow-up prompt
    expect(sessions[0].touchPoints).toHaveLength(1);
    expect(sessions[0].touchPoints[0].path).toBe('/src/feature.ts');
  });
});
