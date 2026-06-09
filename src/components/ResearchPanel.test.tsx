import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResearchPanel } from './ResearchPanel';
import type { ResearchResult, SuggestedTopic } from '../types';

const topics: SuggestedTopic[] = [
  { topic: 'React useTransition', reason: 'used in App.tsx' },
  { topic: 'Mermaid graph LR', reason: 'drawing the workflow' },
];

/** Render with a default no-op onOpenResearch unless overridden. */
function renderPanel(props: Partial<React.ComponentProps<typeof ResearchPanel>> = {}) {
  return render(
    <ResearchPanel
      results={[]}
      suggestedTopics={topics}
      primedTopics={[]}
      warmingTopics={[]}
      activityStatus="ready"
      sessionId="s1"
      onOpenResearch={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  // Default: a fetch that never resolves, so we can observe the pending state.
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Chip-behavior (POST, pending guard, error, primed/warming dots) is owned by ResearchChips and
// tested in ResearchChips.test.tsx. Here we only guard the composition: the panel still mounts the
// launcher and still drops the legacy manual input.
describe('ResearchPanel — composes ResearchChips (regression)', () => {
  it('renders a chip per suggested topic via the shared launcher', () => {
    renderPanel();
    expect(screen.getByText('React useTransition')).toBeTruthy();
    expect(screen.getByText('Mermaid graph LR')).toBeTruthy();
  });

  it('passes prefetch state through — a primed topic lights its amber dot', () => {
    renderPanel({ primedTopics: ['react usetransition'] });
    const primedChip = screen.getByText('React useTransition').closest('button')!;
    expect(primedChip.querySelector('.research-chip__primed')).toBeTruthy();
  });

  it('does not render the old manual topic input box', () => {
    renderPanel();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('ResearchPanel — unified list (briefings + chips, one section)', () => {
  // One unread (newer) + one read (older) briefing.
  const mixed: ResearchResult[] = [
    {
      topic: 'Caching strategies',
      lede: '',
      sections: [{ heading: '', body: 'Body A' }],
      links: [],
      ts: 2000,
    },
    {
      topic: 'Vector databases',
      lede: '',
      sections: [{ heading: '', body: 'Body B' }],
      links: [],
      ts: 1000,
      readAt: 1500,
    },
  ];

  it('renders a row per completed briefing without full bodies', () => {
    renderPanel({ results: mixed });
    expect(screen.getByText('Caching strategies')).toBeTruthy();
    expect(screen.getByText('Vector databases')).toBeTruthy();
    // The full briefing body lives in the Research tab, not the rail.
    expect(screen.queryByText('Body A')).toBeNull();
    expect(screen.queryByText('Body B')).toBeNull();
  });

  it('clicking a briefing row calls onOpenResearch with that briefing ts', () => {
    const onOpen = vi.fn();
    renderPanel({ results: mixed, onOpenResearch: onOpen });
    fireEvent.click(screen.getByText('Caching strategies').closest('button')!);
    expect(onOpen).toHaveBeenCalledWith(2000);
  });

  it('never renders a separate "Ready to read" header/section — one list carries the state', () => {
    const { container } = renderPanel({ results: mixed }); // even WITH briefings present
    // The old dedicated block + its uppercase label are gone; everything lives in one .research-list.
    expect(container.querySelector('.research-ready-list, .research-ready-list__label')).toBeNull();
    expect(container.querySelectorAll('.research-list').length).toBe(1);
  });

  it('an unread briefing leads with an amber dot and "ready to read" label', () => {
    renderPanel({ results: mixed });
    const row = screen.getByText('Caching strategies').closest('button')!;
    expect(row.getAttribute('aria-label')).toBe('Caching strategies — ready to read');
    expect(row.className).not.toContain('research-ready-row--read');
    const dot = row.querySelector('.research-ready-row__dot')!;
    expect(dot.classList.contains('research-ready-row__dot--read')).toBe(false); // amber, not dim
  });

  it('a read briefing is dimmed, dropped to the bottom, with no amber', () => {
    renderPanel({ results: mixed });
    const row = screen.getByText('Vector databases').closest('button')!;
    expect(row.getAttribute('aria-label')).toBe('Vector databases — read');
    expect(row.className).toContain('research-ready-row--read');
    expect(row.querySelector('.research-ready-row__dot--read')).toBeTruthy(); // dim ring, not amber
  });

  it('orders the one list as unread → suggested chips → read', () => {
    const { container } = renderPanel({ results: mixed }); // default topics = 2 chips
    const labels = [...container.querySelectorAll('.research-list > li')].map(
      (li) => li.querySelector('.research-ready-row__topic, .research-chip__topic')!.textContent,
    );
    expect(labels).toEqual([
      'Caching strategies', // unread briefing
      'React useTransition', // chip
      'Mermaid graph LR', // chip
      'Vector databases', // read briefing
    ]);
  });
});

describe('ResearchPanel — empty states', () => {
  it('shows a spinner + "Surfacing topics" while generating', () => {
    renderPanel({ suggestedTopics: [], activityStatus: 'generating' });
    expect(screen.getByText(/Surfacing topics/i)).toBeTruthy();
  });

  it('shows the ready-but-empty message when a tick produced no topics', () => {
    renderPanel({ suggestedTopics: [], activityStatus: 'ready' });
    expect(screen.getByText(/No research topics yet/i)).toBeTruthy();
  });

  it('shows a neutral, spinner-free message when idle (e.g. no provider)', () => {
    const { container } = renderPanel({
      suggestedTopics: [],
      activityStatus: 'idle',
      sessionId: null,
    });
    expect(screen.getByText(/appear here as the agent works/i)).toBeTruthy();
    // No spinner — don't imply work is happening when there's no provider.
    expect(container.querySelector('.spinner')).toBeNull();
  });

  // REGRESSION: the old panel rendered the empty "no topics" copy whenever suggestedTopics was
  // empty — even when briefings existed, double-rendering alongside the ready-list. The unified
  // list must show the empty state ONLY when there are no topics AND no briefings.
  it('with briefings present but no topics, renders the list — not the empty copy', () => {
    const { container } = renderPanel({
      suggestedTopics: [],
      results: [
        {
          topic: 'Caching strategies',
          lede: '',
          sections: [{ heading: '', body: 'B' }],
          links: [],
          ts: 2000,
        },
      ],
      activityStatus: 'ready',
    });
    expect(screen.queryByText(/No research topics yet/i)).toBeNull();
    expect(screen.getByText('Caching strategies')).toBeTruthy();
    expect(container.querySelector('.research-list')).toBeTruthy();
  });
});
