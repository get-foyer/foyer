import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionTabs } from './SessionTabs';
import type { Session } from '../types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-abc',
    status: 'working',
    prompt: 'test prompt',
    prompts: ['test prompt'],
    turnSeq: 1,
    summary: null,
    focusHistory: [],
    graph: null,
    workflowTurnSeq: null,
    activityStatus: 'idle',
    activityError: null,
    waitingReason: null,
    touchPoints: [],
    research: [],
    suggestedTopics: [],
    startedAt: 1000,
    finishedAt: null,
    ...overrides,
  };
}

const noop = () => {};

/** Default props so each test only specifies what it cares about. */
const baseProps = {
  sessions: [] as Session[],
  activeSessionId: null as string | null,
  liveSessionId: null as string | null,
  followMode: 'follow' as 'follow' | 'held',
  unseenSessionIds: [] as string[],
  onFollow: noop,
  onSelect: noop,
  onClose: noop,
  onPin: noop,
  onUnpin: noop,
};

describe('SessionTabs', () => {
  it('renders one tab button per session in order', () => {
    const sessions = [
      makeSession({ sessionId: 'a', prompt: 'First task' }),
      makeSession({ sessionId: 'b', prompt: 'Second task' }),
    ];
    render(<SessionTabs {...baseProps} sessions={sessions} activeSessionId="a" />);
    const tabs = screen.getAllByRole('button', { name: /first task|second task/i });
    expect(tabs[0]).toHaveAttribute('title', 'First task');
    expect(tabs[1]).toHaveAttribute('title', 'Second task');
  });

  it('renders an interrupted session with the interrupted status dot', () => {
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a', prompt: 'Cut off', status: 'interrupted' })]}
        activeSessionId="a"
      />,
    );
    expect(screen.getByLabelText('interrupted by a restart')).toBeTruthy();
  });

  it('active tab has aria-current="true"', () => {
    const sessions = [
      makeSession({ sessionId: 'a', prompt: 'First task' }),
      makeSession({ sessionId: 'b', prompt: 'Second task' }),
    ];
    render(<SessionTabs {...baseProps} sessions={sessions} activeSessionId="b" />);
    expect(screen.getByTitle('First task')).not.toHaveAttribute('aria-current');
    expect(screen.getByTitle('Second task')).toHaveAttribute('aria-current', 'true');
  });

  it('unseen tab renders the "new activity" indicator', () => {
    const sessions = [makeSession({ sessionId: 'a', prompt: 'Task A' })];
    render(<SessionTabs {...baseProps} sessions={sessions} unseenSessionIds={['a']} />);
    expect(screen.getByRole('status', { name: 'new activity' })).toBeInTheDocument();
  });

  it('clicking a tab fires onSelect with the sessionId', () => {
    const onSelect = vi.fn();
    const sessions = [makeSession({ sessionId: 'a', prompt: 'Task A' })];
    render(<SessionTabs {...baseProps} sessions={sessions} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle('Task A'));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('clicking × fires onClose and does NOT fire onSelect', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const sessions = [makeSession({ sessionId: 'a', prompt: 'Task A' })];
    render(
      <SessionTabs {...baseProps} sessions={sessions} onSelect={onSelect} onClose={onClose} />,
    );
    const closeBtn = screen.getByRole('button', { name: /close session/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith('a');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('waiting session renders the "needs your input" status indicator', () => {
    const sessions = [
      makeSession({
        sessionId: 'a',
        prompt: 'Task A',
        status: 'waiting',
        waitingReason: 'Permission requested',
      }),
    ];
    render(<SessionTabs {...baseProps} sessions={sessions} />);
    expect(screen.getByRole('status', { name: 'needs your input' })).toBeInTheDocument();
  });

  it('renders the empty-state placeholder when sessions is empty', () => {
    render(<SessionTabs {...baseProps} sessions={[]} />);
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Jump-to-live pill (contextual; replaces the persistent FOLLOW/HELD control)
// ---------------------------------------------------------------------------

describe('SessionTabs — Jump-to-live pill', () => {
  const queryPill = () => screen.queryByRole('button', { name: /jump to the live session/i });

  it('following → no pill (silent default)', () => {
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })]}
        activeSessionId="a"
        liveSessionId="b"
        followMode="follow"
      />,
    );
    expect(queryPill()).not.toBeInTheDocument();
  });

  it('held + live === active (nothing newer) → no pill', () => {
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a' })]}
        activeSessionId="a"
        liveSessionId="a"
        followMode="held"
      />,
    );
    expect(queryPill()).not.toBeInTheDocument();
  });

  it('held + a different visible session live → pill renders, names that session', () => {
    render(
      <SessionTabs
        {...baseProps}
        sessions={[
          makeSession({ sessionId: 'a', prompt: 'fix the header' }),
          makeSession({ sessionId: 'b', prompt: 'add export button' }),
        ]}
        activeSessionId="a"
        liveSessionId="b"
        followMode="held"
      />,
    );
    // The pill renders AND names the live session (asserted via its accessible name, which is
    // unique to the pill — the session's own tab also shows the prompt text).
    expect(
      screen.getByRole('button', { name: /jump to the live session: add export button/i }),
    ).toBeInTheDocument();
  });

  it('held + live points at a non-visible session → no pill (no false catch-up)', () => {
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a' })]}
        activeSessionId="a"
        liveSessionId="ghost"
        followMode="held"
      />,
    );
    expect(queryPill()).not.toBeInTheDocument();
  });

  it('clicking the pill fires onFollow', () => {
    const onFollow = vi.fn();
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })]}
        activeSessionId="a"
        liveSessionId="b"
        followMode="held"
        onFollow={onFollow}
      />,
    );
    fireEvent.click(queryPill()!);
    expect(onFollow).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// ⋯ options menu + pinning
// ---------------------------------------------------------------------------

describe('SessionTabs — options menu + pinning', () => {
  it('renders a ⋯ options trigger per session', () => {
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a', prompt: 'Task A' })]}
        activeSessionId="a"
      />,
    );
    const trigger = screen.getByRole('button', { name: /session options/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('an unpinned session offers "Pin session"; clicking it fires onPin, not onSelect', () => {
    const onPin = vi.fn();
    const onSelect = vi.fn();
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a', prompt: 'Task A' })]}
        onPin={onPin}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /pin session/i, hidden: true }));
    expect(onPin).toHaveBeenCalledWith('a');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a pinned session offers "Unpin session"; clicking it fires onUnpin', () => {
    const onUnpin = vi.fn();
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a', prompt: 'Task A', pinnedAt: 1000 })]}
        onUnpin={onUnpin}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /unpin session/i, hidden: true }));
    expect(onUnpin).toHaveBeenCalledWith('a');
  });

  it('a pinned session renders the pin marker with a screen-reader "Pinned" label', () => {
    render(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a', prompt: 'Task A', pinnedAt: 1000 })]}
      />,
    );
    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  it('an unpinned session shows no pin marker', () => {
    render(
      <SessionTabs {...baseProps} sessions={[makeSession({ sessionId: 'a', prompt: 'Task A' })]} />,
    );
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
  });

  it('shows the group divider only when both a pinned and an unpinned session exist', () => {
    const { rerender } = render(
      <SessionTabs
        {...baseProps}
        sessions={[
          makeSession({ sessionId: 'p', prompt: 'Pinned', pinnedAt: 1000 }),
          makeSession({ sessionId: 'u', prompt: 'Unpinned' }),
        ]}
      />,
    );
    expect(screen.getAllByRole('separator')).toHaveLength(1);

    // all pinned → no divider
    rerender(
      <SessionTabs
        {...baseProps}
        sessions={[
          makeSession({ sessionId: 'p1', prompt: 'P1', pinnedAt: 1000 }),
          makeSession({ sessionId: 'p2', prompt: 'P2', pinnedAt: 2000 }),
        ]}
      />,
    );
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();

    // none pinned → no divider
    rerender(
      <SessionTabs
        {...baseProps}
        sessions={[makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })]}
      />,
    );
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});
