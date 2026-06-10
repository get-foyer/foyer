import { describe, it, expect } from 'vitest';
import { normalizePrimary } from './text.js';
import { parseActivityJson } from './claudeCli.js';
import type { SuggestedTopic } from '../../src/types.js';

const topics: SuggestedTopic[] = [
  { topic: 'DNS rebinding guard', reason: 'editing server/security.ts' },
  { topic: 'URL sanitizer contract', reason: 'editing src/lib/url.ts' },
];

describe('normalizePrimary (trust boundary, eng review D10)', () => {
  it('accepts a proposal matching a suggested topic, returning the CANONICAL topic text', () => {
    const out = normalizePrimary(
      { topic: '  dns REBINDING guard ', reason: 'the session edits security hooks' },
      topics,
    );
    expect(out).toEqual({
      topic: 'DNS rebinding guard', // canonical text from the suggestion, not the raw LLM string
      reason: 'the session edits security hooks',
    });
  });

  it('rejects an unknown/hallucinated topic → null (never reaches designation)', () => {
    expect(normalizePrimary({ topic: 'Kubernetes ingress', reason: 'x' }, topics)).toBeNull();
  });

  it('null / missing / non-object / array → null (first-class no-pick outcome)', () => {
    expect(normalizePrimary(null, topics)).toBeNull();
    expect(normalizePrimary(undefined, topics)).toBeNull();
    expect(normalizePrimary('DNS rebinding guard', topics)).toBeNull();
    expect(normalizePrimary([{ topic: 'DNS rebinding guard' }], topics)).toBeNull();
  });

  it('caps the reason at 80 chars (one strip line, design DR12)', () => {
    const out = normalizePrimary({ topic: 'DNS rebinding guard', reason: 'r'.repeat(200) }, topics);
    expect(out?.reason).toHaveLength(80);
  });

  it("falls back to the suggestion's own reason when the LLM omits one", () => {
    const out = normalizePrimary({ topic: 'URL sanitizer contract' }, topics);
    expect(out?.reason).toBe('editing src/lib/url.ts');
  });

  it('rejects an empty/whitespace topic', () => {
    expect(normalizePrimary({ topic: '   ', reason: 'x' }, topics)).toBeNull();
  });
});

describe('parseActivityJson — primary field (CRITICAL regression: old shape unchanged)', () => {
  it('OLD-SHAPE output (no primary field) parses exactly as before, with primary: null', () => {
    const raw = JSON.stringify({
      summary: 'Agent is refactoring auth.',
      topics: [{ topic: 'JWT rotation', reason: 'editing auth.ts' }],
    });
    const out = parseActivityJson(raw);
    expect(out.summary).toBe('Agent is refactoring auth.');
    expect(out.topics).toEqual([{ topic: 'JWT rotation', reason: 'editing auth.ts' }]);
    expect(out.primary).toBeNull();
  });

  it('new-shape output parses the primary against its own topics', () => {
    const raw = JSON.stringify({
      summary: 'Working.',
      topics: [{ topic: 'JWT rotation', reason: 'editing auth.ts' }],
      primary: { topic: 'JWT rotation', reason: 'auth is the whole task' },
    });
    expect(parseActivityJson(raw).primary).toEqual({
      topic: 'JWT rotation',
      reason: 'auth is the whole task',
    });
  });

  it('a primary naming a topic NOT in topics is dropped to null', () => {
    const raw = JSON.stringify({
      summary: 'Working.',
      topics: [{ topic: 'JWT rotation', reason: 'editing auth.ts' }],
      primary: { topic: 'something invented', reason: 'x' },
    });
    expect(parseActivityJson(raw).primary).toBeNull();
  });

  it('malformed JSON still falls back with primary: null', () => {
    const out = parseActivityJson('not json at all');
    expect(out.topics).toEqual([]);
    expect(out.primary).toBeNull();
  });
});
