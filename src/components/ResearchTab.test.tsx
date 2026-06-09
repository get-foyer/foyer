import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ResearchTab } from './ResearchTab';
import type { ResearchResult } from '../types';

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

describe('ResearchTab', () => {
  it('lists every briefing in the index, newest-first', () => {
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    const index = screen.getByRole('navigation', { name: /briefings/i });
    const items = within(index).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Caching strategies'),
      expect.stringContaining('Vector databases'),
    ]);
  });

  it('renders the selected briefing sections + sources in the reading pane', () => {
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    expect(screen.getByRole('heading', { level: 1, name: /caching strategies/i })).toBeTruthy();
    expect(screen.getByText(/cache invalidation is hard/i)).toBeTruthy();
    expect(screen.getByText(/freshness versus latency/i)).toBeTruthy();
    const source = screen.getByRole('link', { name: 'Source One' });
    expect(source.getAttribute('href')).toBe('https://example.com/1');
  });

  it('renders the TL;DR lede above the sections', () => {
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    expect(screen.getByText(/caching trades freshness for speed/i)).toBeTruthy();
  });

  it('parses markdown in the lede — inline code becomes a <code> span, not literal backticks', () => {
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    const code = screen.getByText('invalidateCache');
    expect(code.tagName).toBe('CODE');
    // No raw backtick leaked into the rendered text.
    expect(screen.queryByText(/`invalidateCache`/)).toBeNull();
  });

  it('renders the section index when a briefing has 2+ sections', () => {
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    const sectionNav = screen.getByRole('navigation', { name: /sections in this briefing/i });
    const links = within(sectionNav).getAllByRole('button');
    expect(links.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Overview'),
      expect.stringContaining('Tradeoffs'),
    ]);
  });

  it('hides the section index for a single-section (trivial) briefing — adaptive rule', () => {
    render(<ResearchTab results={results} selectedTs={1000} onSelect={() => {}} />);
    expect(screen.queryByRole('navigation', { name: /sections in this briefing/i })).toBeNull();
  });

  it('renders the section diagram via MermaidFigure when present', () => {
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    expect(screen.getByTestId('mermaid-figure').textContent).toContain('flowchart LR');
  });

  it('shows a read-time readout', () => {
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    expect(screen.getByText(/min read/i)).toBeTruthy();
  });

  it('copies the briefing as markdown to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /copy markdown/i }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain('# Caching strategies');
    expect(writeText.mock.calls[0][0]).toContain('## Overview');
  });

  it('marks the selected index item aria-current', () => {
    render(<ResearchTab results={results} selectedTs={1000} onSelect={() => {}} />);
    const selected = screen.getByRole('button', { current: true });
    expect(selected.textContent).toContain('Vector databases');
  });

  it('clicking an index item calls onSelect with its ts', () => {
    const onSelect = vi.fn();
    render(<ResearchTab results={results} selectedTs={2000} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Vector databases').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith(1000);
  });

  it('falls back to the newest briefing when selectedTs is unknown', () => {
    render(<ResearchTab results={results} selectedTs={null} onSelect={() => {}} />);
    expect(screen.getByRole('heading', { level: 1, name: /caching strategies/i })).toBeTruthy();
  });
});
