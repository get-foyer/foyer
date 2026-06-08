import { describe, it, expect } from 'vitest';
import { slugify, sectionAnchors, estimateReadMinutes, serializeToMarkdown } from './research';
import type { ResearchResult, ResearchSection } from '../types';

describe('slugify', () => {
  it('lowercases, strips punctuation, and joins words with hyphens', () => {
    expect(slugify('How It Works')).toBe('how-it-works');
    expect(slugify('  Tradeoffs & Costs!  ')).toBe('tradeoffs-costs');
  });

  it('returns a stable fallback for an empty/symbol-only heading', () => {
    expect(slugify('')).toBe('section');
    expect(slugify('!!!')).toBe('section');
  });
});

describe('sectionAnchors', () => {
  it('dedupes colliding slugs (overview, overview-1, overview-2)', () => {
    const sections: ResearchSection[] = [
      { heading: 'Overview', body: 'a' },
      { heading: 'Overview', body: 'b' },
      { heading: 'Overview', body: 'c' },
    ];
    expect(sectionAnchors(sections).map((a) => a.slug)).toEqual([
      'overview',
      'overview-1',
      'overview-2',
    ]);
  });

  it('synthesizes a heading + slug when a section heading is blank', () => {
    const a = sectionAnchors([{ heading: '', body: 'x' }]);
    expect(a[0].heading).toBe('Section 1');
    expect(a[0].slug).toBe('section-1');
  });
});

describe('estimateReadMinutes', () => {
  it('floors at 1 minute for short briefings', () => {
    expect(estimateReadMinutes([{ heading: 'H', body: 'a few words' }])).toBe(1);
  });

  it('excludes fenced code so syntax does not inflate the count', () => {
    const codeHeavy = '```\n' + 'x '.repeat(1000) + '\n```\nthree real words here';
    // Only the 4 prose words count → still ~1 min, not ~5.
    expect(estimateReadMinutes([{ heading: 'H', body: codeHeavy }])).toBe(1);
  });

  it('scales with prose length (~200 wpm)', () => {
    const body = 'word '.repeat(600); // 600 words → 3 min
    expect(estimateReadMinutes([{ heading: 'H', body }])).toBe(3);
  });
});

describe('serializeToMarkdown', () => {
  it('renders topic, lede, sections, diagram fences, and sources', () => {
    const result: ResearchResult = {
      topic: 'Caching',
      lede: 'Caching trades freshness for speed.',
      sections: [
        { heading: 'Overview', body: 'Body text.' },
        { heading: 'Flow', body: 'See diagram.', diagram: 'flowchart LR\n  A-->B' },
      ],
      links: [{ title: 'Docs', url: 'https://example.com' }],
      ts: 1,
    };
    const md = serializeToMarkdown(result);
    expect(md).toContain('# Caching');
    expect(md).toContain('Caching trades freshness for speed.');
    expect(md).toContain('## Overview');
    expect(md).toContain('```mermaid\nflowchart LR\n  A-->B\n```');
    expect(md).toContain('## Sources');
    expect(md).toContain('1. [Docs](https://example.com)');
  });
});
