import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ResearchTab } from './ResearchTab';
import type { ResearchResult, SuggestedTopic } from '../types';

// Stub the mermaid figure: the real mermaid.render + DOMPurify pipeline needs a layout engine
// jsdom doesn't have, and is exercised by graphSanitize.test.ts. Same pattern as SummaryPanel.test.
vi.mock('./MermaidFigure', () => ({
  MermaidFigure: ({ diagram }: { diagram: string }) => (
    <div data-testid="mermaid-figure">{diagram}</div>
  ),
}));

const results: ResearchResult[] = [
  {
    topic: 'Caching strategies',
    lede: 'Caching trades freshness for speed via `invalidateCache`.',
    sections: [
      { heading: 'Overview', body: 'Cache invalidation is hard.' },
      {
        heading: 'Tradeoffs',
        body: 'Freshness versus latency.',
        diagram: 'flowchart LR\n  A["Read"] --> B["Cache"]',
      },
    ],
    links: [{ title: 'Source One', url: 'https://example.com/1' }],
    ts: 2000,
  },
  {
    topic: 'Vector databases',
    lede: '',
    sections: [{ heading: 'Vector databases', body: 'Embeddings and ANN search.' }],
    links: [],
    ts: 1000,
  },
];

/** Render with empty-state inputs defaulted, so reading-surface tests stay terse. */
function renderTab(props: Partial<React.ComponentProps<typeof ResearchTab>> = {}) {
  return render(
    <ResearchTab
      results={results}
      selectedTs={2000}
      onSelect={() => {}}
      suggestedTopics={[]}
      activityStatus="ready"
      sessionId="s1"
      primedTopics={[]}
      warmingTopics={[]}
      {...props}
    />,
  );
}

describe('ResearchTab', () => {
  it('lists every briefing in the index, newest-first', () => {
    renderTab();
    const index = screen.getByRole('navigation', { name: /briefings/i });
    const items = within(index).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Caching strategies'),
      expect.stringContaining('Vector databases'),
    ]);
  });

  it('renders the selected briefing sections + sources in the reading pane', () => {
    renderTab();
    expect(screen.getByRole('heading', { level: 1, name: /caching strategies/i })).toBeTruthy();
    expect(screen.getByText(/cache invalidation is hard/i)).toBeTruthy();
    expect(screen.getByText(/freshness versus latency/i)).toBeTruthy();
    const source = screen.getByRole('link', { name: 'Source One' });
    expect(source.getAttribute('href')).toBe('https://example.com/1');
  });

  it('renders the TL;DR lede above the sections', () => {
    renderTab();
    expect(screen.getByText(/caching trades freshness for speed/i)).toBeTruthy();
  });

  it('parses markdown in the lede — inline code becomes a <code> span, not literal backticks', () => {
    renderTab();
    const code = screen.getByText('invalidateCache');
    expect(code.tagName).toBe('CODE');
    // No raw backtick leaked into the rendered text.
    expect(screen.queryByText(/`invalidateCache`/)).toBeNull();
  });

  it('renders the section index when a briefing has 2+ sections', () => {
    renderTab();
    const sectionNav = screen.getByRole('navigation', { name: /sections in this briefing/i });
    const links = within(sectionNav).getAllByRole('button');
    expect(links.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Overview'),
      expect.stringContaining('Tradeoffs'),
    ]);
  });

  it('hides the section index for a single-section (trivial) briefing — adaptive rule', () => {
    renderTab({ selectedTs: 1000 });
    expect(screen.queryByRole('navigation', { name: /sections in this briefing/i })).toBeNull();
  });

  it('renders the section diagram via MermaidFigure when present', () => {
    renderTab();
    expect(screen.getByTestId('mermaid-figure').textContent).toContain('flowchart LR');
  });

  it('shows a read-time readout', () => {
    renderTab();
    expect(screen.getByText(/min read/i)).toBeTruthy();
  });

  it('copies the briefing as markdown to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /copy markdown/i }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain('# Caching strategies');
    expect(writeText.mock.calls[0][0]).toContain('## Overview');
  });

  it('marks the selected index item aria-current', () => {
    renderTab({ selectedTs: 1000 });
    const selected = screen.getByRole('button', { current: true });
    expect(selected.textContent).toContain('Vector databases');
  });

  it('clicking an index item calls onSelect with its ts', () => {
    const onSelect = vi.fn();
    renderTab({ onSelect });
    fireEvent.click(screen.getByText('Vector databases').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith(1000);
  });

  it('falls back to the newest briefing when selectedTs is unknown', () => {
    renderTab({ selectedTs: null });
    expect(screen.getByRole('heading', { level: 1, name: /caching strategies/i })).toBeTruthy();
  });
});

describe('ResearchTab — empty state (no briefings)', () => {
  beforeEach(() => {
    // A fetch that never resolves, so a tapped chip stays pending without unhandled rejections.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const topics: SuggestedTopic[] = [{ topic: 'Vite SSR config', reason: 'touched vite.config' }];

  it('Variant 1 — with topics, surfaces the inline launcher chips', () => {
    renderTab({ results: [], suggestedTopics: topics, activityStatus: 'ready' });
    expect(screen.getByText(/no briefings yet — start one below/i)).toBeTruthy();
    expect(screen.getByText('Vite SSR config')).toBeTruthy();
  });

  it('Variant 1 — clicking an empty-state chip POSTs /research for the viewed session', () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    renderTab({ results: [], suggestedTopics: topics, sessionId: 's9' });
    fireEvent.click(screen.getByText('Vite SSR config').closest('button')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/research');
    expect(JSON.parse(opts.body)).toEqual({ topic: 'Vite SSR config', sessionId: 's9' });
  });

  it('Variant 2 — generating shows the spinner + surfacing copy, no chips', () => {
    const { container } = renderTab({
      results: [],
      suggestedTopics: [],
      activityStatus: 'generating',
    });
    expect(screen.getByText(/surfacing topics/i)).toBeTruthy();
    expect(container.querySelector('.spinner')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Variant 3 — idle (e.g. no provider) shows a neutral, spinner-free signpost', () => {
    const { container } = renderTab({
      results: [],
      suggestedTopics: [],
      activityStatus: 'idle',
      sessionId: null,
    });
    expect(screen.getByText(/briefings will open here/i)).toBeTruthy();
    expect(container.querySelector('.spinner')).toBeNull();
  });

  it('Variant 3 — ready-but-no-topics says topics will appear as the agent works', () => {
    renderTab({ results: [], suggestedTopics: [], activityStatus: 'ready' });
    expect(screen.getByText(/no research topics yet/i)).toBeTruthy();
  });

  it('keeps the tabpanel role on the empty state for the always-on tab', () => {
    renderTab({ results: [], suggestedTopics: [] });
    const panel = document.getElementById('view-panel-research');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe('view-tab-research');
  });
});
