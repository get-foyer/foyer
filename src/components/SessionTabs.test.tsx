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

describe('SessionTabs', () => {
  it('renders one tab button per session in order', () => {
    const sessions = [
      makeSession({ sessionId: 'a', prompt: 'First task' }),
      makeSession({ sessionId: 'b', prompt: 'Second task' }),
    ];
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId="a"
        unseenSessionIds={[]}
        onSelect={noop}
        onClose={noop}
      />,
    );
    const tabs = screen.getAllByRole('button', { name: /first task|second task/i });
    // The tab buttons contain the prompts (accessible via title/text)
    expect(tabs[0]).toHaveAttribute('title', 'First task');
    expect(tabs[1]).toHaveAttribute('title', 'Second task');
  });

  it('renders an interrupted session with the interrupted status dot', () => {
    render(
      <SessionTabs
        sessions={[makeSession({ sessionId: 'a', prompt: 'Cut off', status: 'interrupted' })]}
        activeSessionId="a"
        unseenSessionIds={[]}
        onSelect={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByLabelText('interrupted by a restart')).toBeTruthy();
  });

  it('active tab has aria-current="true"', () => {
    const sessions = [
      makeSession({ sessionId: 'a', prompt: 'First task' }),
      makeSession({ sessionId: 'b', prompt: 'Second task' }),
    ];
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId="b"
        unseenSessionIds={[]}
        onSelect={noop}
        onClose={noop}
      />,
    );
    // Find tab buttons by title attr
    const tabA = screen.getByTitle('First task');
    const tabB = screen.getByTitle('Second task');
    expect(tabA).not.toHaveAttribute('aria-current');
    expect(tabB).toHaveAttribute('aria-current', 'true');
  });

  it('unseen tab renders the "new activity" indicator', () => {
    const sessions = [makeSession({ sessionId: 'a', prompt: 'Task A' })];
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId={null}
        unseenSessionIds={['a']}
        onSelect={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByRole('status', { name: 'new activity' })).toBeInTheDocument();
  });

  it('clicking a tab fires onSelect with the sessionId', () => {
    const onSelect = vi.fn();
    const sessions = [makeSession({ sessionId: 'a', prompt: 'Task A' })];
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId={null}
        unseenSessionIds={[]}
        onSelect={onSelect}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByTitle('Task A'));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('clicking × fires onClose and does NOT fire onSelect', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const sessions = [makeSession({ sessionId: 'a', prompt: 'Task A' })];
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId={null}
        unseenSessionIds={[]}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    // Close button is labelled "Close session <shortId>"
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
    render(
      <SessionTabs
        sessions={sessions}
        activeSessionId={null}
        unseenSessionIds={[]}
        onSelect={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByRole('status', { name: 'needs your input' })).toBeInTheDocument();
  });

  it('renders the empty-state placeholder when sessions is empty', () => {
    render(
      <SessionTabs
        sessions={[]}
        activeSessionId={null}
        unseenSessionIds={[]}
        onSelect={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });
});
