import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ResearchTab } from './ResearchTab';
import type { ResearchResult } from '../types';

const results: ResearchResult[] = [
  {
    topic: 'Caching strategies',
    summary: 'Cache invalidation is hard.',
    links: [{ title: 'Source One', url: 'https://example.com/1' }],
    ts: 2000,
  },
  {
    topic: 'Vector databases',
    summary: 'Embeddings and ANN search.',
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

  it('renders the selected briefing body + sources in the reading pane', () => {
    render(<ResearchTab results={results} selectedTs={2000} onSelect={() => {}} />);
    expect(screen.getByRole('heading', { level: 1, name: /caching strategies/i })).toBeTruthy();
    expect(screen.getByText(/cache invalidation is hard/i)).toBeTruthy();
    const source = screen.getByRole('link', { name: 'Source One' });
    expect(source.getAttribute('href')).toBe('https://example.com/1');
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
