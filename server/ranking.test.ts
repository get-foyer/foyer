import { describe, it, expect } from 'vitest';
import {
  selectSnippets,
  decidePrimary,
  nextPrimaryAfterDismiss,
  TICK_SNIPPET_BUDGET,
  BRIEFING_SNIPPET_BUDGET,
} from './ranking.js';
import type { DocSnippet } from './docsources/index.js';
import type { PrimaryBriefing, SuggestedTopic } from '../src/types.js';

const doc = (path: string, title: string, snippet = '', mtime = 0): DocSnippet => ({
  path,
  title,
  snippet,
  mtime,
  source: 'repo',
});

const primary = (over: Partial<PrimaryBriefing> = {}): PrimaryBriefing => ({
  topic: 'DNS rebinding guard',
  reason: 'editing server/security',
  status: 'ready',
  since: 1,
  ...over,
});

describe('selectSnippets', () => {
  const index = [
    doc('docs/decisions/0003-prefetch.md', 'Background research prefetch', 'warming the cache'),
    doc('docs/security.md', 'DNS rebinding guard', 'localhost Host validation'),
    doc('docs/unrelated.md', 'Release checklist', 'bump versions'),
  ];

  it('ranks docs by keyword overlap with the prompt', () => {
    const out = selectSnippets(
      index,
      { touchedAreas: [], promptText: 'fix the DNS rebinding guard' },
      8,
    );
    expect(out[0].path).toBe('docs/security.md');
  });

  it('weights touched-area path affinity above plain keyword overlap', () => {
    const out = selectSnippets(
      index,
      { touchedAreas: ['docs/decisions'], promptText: 'prefetch' },
      8,
    );
    expect(out[0].path).toBe('docs/decisions/0003-prefetch.md');
  });

  it('drops zero-score docs entirely (no padding to k)', () => {
    const out = selectSnippets(index, { touchedAreas: [], promptText: 'kubernetes ingress' }, 8);
    expect(out).toEqual([]);
  });

  it('respects the k budget', () => {
    const many = Array.from({ length: 20 }, (_, i) => doc(`docs/d${i}.md`, `prefetch note ${i}`));
    const out = selectSnippets(many, { touchedAreas: [], promptText: 'prefetch' }, 3);
    expect(out).toHaveLength(3);
  });

  it('exports the D13 budgets (8 tick / 30 briefing)', () => {
    expect(TICK_SNIPPET_BUDGET).toBe(8);
    expect(BRIEFING_SNIPPET_BUDGET).toBe(30);
  });
});

describe('decidePrimary (the sticky rule, eng D6 + design DR7)', () => {
  const none = new Set<string>();

  it('null proposal → keep (stickiness: null means keep current / no confident pick)', () => {
    expect(decidePrimary({ current: primary(), proposal: null, dismissedKeys: none })).toEqual({
      action: 'keep',
    });
    expect(decidePrimary({ current: null, proposal: null, dismissedKeys: none })).toEqual({
      action: 'keep',
    });
  });

  it('no current + proposal → designate', () => {
    const d = decidePrimary({
      current: null,
      proposal: { topic: 'URL sanitizer contract', reason: 'editing url.ts' },
      dismissedKeys: none,
    });
    expect(d).toEqual({
      action: 'designate',
      topic: 'URL sanitizer contract',
      reason: 'editing url.ts',
    });
  });

  it('same topic re-proposed → keep (no churn, no re-warm), case-insensitively', () => {
    const d = decidePrimary({
      current: primary(),
      proposal: { topic: 'dns REBINDING guard', reason: 'still security' },
      dismissedKeys: none,
    });
    expect(d).toEqual({ action: 'keep' });
  });

  it('different proposal supersedes a ready-unread primary (meaningful shift)', () => {
    const d = decidePrimary({
      current: primary({ status: 'ready' }),
      proposal: { topic: 'single-flight caches', reason: 'now debugging prefetch' },
      dismissedKeys: none,
    });
    expect(d.action).toBe('designate');
  });

  it('different proposal replaces a READ primary (DR7 — read is not terminal)', () => {
    const d = decidePrimary({
      current: primary({ status: 'read' }),
      proposal: { topic: 'single-flight caches', reason: 'now debugging prefetch' },
      dismissedKeys: none,
    });
    expect(d.action).toBe('designate');
  });

  it('never designates a dismissed topic (eng D18)', () => {
    const d = decidePrimary({
      current: null,
      proposal: { topic: 'URL sanitizer contract', reason: 'editing url.ts' },
      dismissedKeys: new Set(['url sanitizer contract']),
    });
    expect(d).toEqual({ action: 'keep' });
  });
});

describe('nextPrimaryAfterDismiss', () => {
  const candidates: SuggestedTopic[] = [
    { topic: 'A topic', reason: 'ra' },
    { topic: 'B topic', reason: 'rb' },
  ];

  it('promotes the first non-dismissed candidate (suggestion order = ranking)', () => {
    expect(nextPrimaryAfterDismiss(candidates, new Set(['a topic']))).toEqual({
      topic: 'B topic',
      reason: 'rb',
    });
  });

  it('returns null when the queue is exhausted (strip falls back to extractive — DR8)', () => {
    expect(nextPrimaryAfterDismiss(candidates, new Set(['a topic', 'b topic']))).toBeNull();
    expect(nextPrimaryAfterDismiss([], new Set())).toBeNull();
  });
});
