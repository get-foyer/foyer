import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResearchPanel } from './ResearchPanel';
import type { SuggestedTopic } from '../types';

const topics: SuggestedTopic[] = [
  { topic: 'React useTransition', reason: 'used in App.tsx' },
  { topic: 'Mermaid graph LR', reason: 'drawing the workflow' },
];

beforeEach(() => {
  // Default: a fetch that never resolves, so we can observe the pending state.
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ResearchPanel — chips', () => {
  it('renders one chip per suggested topic, with the provenance reason', () => {
    render(
      <ResearchPanel results={[]} suggestedTopics={topics} activityStatus="ready" sessionId="s1" />,
    );
    expect(screen.getByText('React useTransition')).toBeTruthy();
    expect(screen.getByText('used in App.tsx')).toBeTruthy();
    expect(screen.getByText('Mermaid graph LR')).toBeTruthy();
  });

  it('does not render the old manual topic input box', () => {
    render(
      <ResearchPanel results={[]} suggestedTopics={topics} activityStatus="ready" sessionId="s1" />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('clicking a chip POSTs /research with the topic + sessionId and disables it', () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ResearchPanel results={[]} suggestedTopics={topics} activityStatus="ready" sessionId="s1" />,
    );
    const chip = screen.getByText('React useTransition').closest('button')!;
    fireEvent.click(chip);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/research');
    expect(JSON.parse(opts.body)).toEqual({ topic: 'React useTransition', sessionId: 's1' });
    expect(chip.disabled).toBe(true);
  });

  it('double-click only fires one research request (pending guard)', () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ResearchPanel results={[]} suggestedTopics={topics} activityStatus="ready" sessionId="s1" />,
    );
    const chip = screen.getByText('React useTransition').closest('button')!;
    fireEvent.click(chip);
    fireEvent.click(chip);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows an error and re-enables the chip when research fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'provider exploded' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ResearchPanel results={[]} suggestedTopics={topics} activityStatus="ready" sessionId="s1" />,
    );
    const chip = screen.getByText('React useTransition').closest('button')!;
    fireEvent.click(chip);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('provider exploded');
    expect(chip.disabled).toBe(false); // retryable
  });
});

describe('ResearchPanel — empty states', () => {
  it('shows a spinner + "Surfacing topics" while generating', () => {
    render(
      <ResearchPanel
        results={[]}
        suggestedTopics={[]}
        activityStatus="generating"
        sessionId="s1"
      />,
    );
    expect(screen.getByText(/Surfacing topics/i)).toBeTruthy();
  });

  it('shows the ready-but-empty message when a tick produced no topics', () => {
    render(
      <ResearchPanel results={[]} suggestedTopics={[]} activityStatus="ready" sessionId="s1" />,
    );
    expect(screen.getByText(/No research topics yet/i)).toBeTruthy();
  });

  it('shows a neutral, spinner-free message when idle (e.g. no provider)', () => {
    const { container } = render(
      <ResearchPanel results={[]} suggestedTopics={[]} activityStatus="idle" sessionId={null} />,
    );
    expect(screen.getByText(/appear here as the agent works/i)).toBeTruthy();
    // No spinner — don't imply work is happening when there's no provider.
    expect(container.querySelector('.spinner')).toBeNull();
  });
});
