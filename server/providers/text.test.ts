import { describe, it, expect } from 'vitest';
import { stripFences, normalizeTopics, normalizeWhitespace } from './text.js';

// ---------------------------------------------------------------------------
// stripFences — canonical test suite (replaces the duplicate blocks that
// previously lived in claudeCli.test.ts and codex.test.ts)
// ---------------------------------------------------------------------------

describe('stripFences', () => {
  // Basic fence variants
  it('strips leading ```mermaid fence', () => {
    expect(stripFences('```mermaid\ngraph TD\nA-->B\n```')).toBe('graph TD\nA-->B');
  });

  it('strips bare ``` fences', () => {
    expect(stripFences('```\ngraph TD\nA-->B\n```')).toBe('graph TD\nA-->B');
  });

  it('returns plain mermaid unchanged', () => {
    expect(stripFences('graph TD\nA-->B')).toBe('graph TD\nA-->B');
  });

  it('strips a trailing fence without a leading one', () => {
    expect(stripFences('graph TD\nA-->B\n```')).toBe('graph TD\nA-->B');
  });

  it('handles fences with CRLF line endings', () => {
    expect(stripFences('```mermaid\r\ngraph TD\r\nA-->B\r\n```')).toBe('graph TD\r\nA-->B');
  });

  it('handles a fence without a closing ``` (model omitted it)', () => {
    expect(stripFences('```mermaid\ngraph TD\n  A-->B')).toBe('graph TD\n  A-->B');
  });

  // Nested / double-wrapped fences
  it('strips double-wrapped fences', () => {
    expect(stripFences('```mermaid\n```mermaid\ngraph TD\nA-->B\n```\n```')).toBe(
      'graph TD\nA-->B',
    );
  });

  // Preamble stripping
  it('strips a leading prose preamble before the graph keyword', () => {
    const input = 'Sure, here is the mermaid diagram:\ngraph TD\n  A-->B';
    expect(stripFences(input)).toBe('graph TD\n  A-->B');
  });

  it('strips preamble before the flowchart keyword', () => {
    const input = 'Here is the requested diagram.\nflowchart TD\n  A-->B';
    expect(stripFences(input)).toBe('flowchart TD\n  A-->B');
  });

  it('does not strip text when the diagram starts on line 1 (no preamble)', () => {
    // idx === 0, so no slice
    expect(stripFences('graph TD\n  A-->B')).toBe('graph TD\n  A-->B');
  });

  it('strips preamble after removing fences', () => {
    const input = '```\nSure:\ngraph TD\n  A-->B\n```';
    expect(stripFences(input)).toBe('graph TD\n  A-->B');
  });

  // flowchart variant
  it('handles flowchart LR syntax', () => {
    expect(stripFences('flowchart LR\n  A-->B')).toBe('flowchart LR\n  A-->B');
  });
});

// ---------------------------------------------------------------------------
// normalizeTopics — defensive parsing of the LLM `topics` field
// ---------------------------------------------------------------------------

describe('normalizeTopics', () => {
  it('keeps well-formed items, trimming whitespace', () => {
    const out = normalizeTopics([
      { topic: '  React useTransition  ', reason: '  used in App.tsx ' },
      { topic: 'Mermaid graph LR', reason: 'drawing the workflow' },
    ]);
    expect(out).toEqual([
      { topic: 'React useTransition', reason: 'used in App.tsx' },
      { topic: 'Mermaid graph LR', reason: 'drawing the workflow' },
    ]);
  });

  it('returns [] for non-array input (null, object, string, undefined)', () => {
    expect(normalizeTopics(null)).toEqual([]);
    expect(normalizeTopics(undefined)).toEqual([]);
    expect(normalizeTopics('topics')).toEqual([]);
    expect(normalizeTopics({ topic: 'x', reason: 'y' })).toEqual([]);
  });

  it('drops items missing a non-empty topic or reason', () => {
    const out = normalizeTopics([
      { topic: 'Valid', reason: 'ok' },
      { topic: '', reason: 'no topic' },
      { topic: 'no reason', reason: '   ' },
      { topic: 'missing reason' },
      { reason: 'missing topic' },
      'not an object',
      null,
    ]);
    expect(out).toEqual([{ topic: 'Valid', reason: 'ok' }]);
  });

  it('caps topic/reason length', () => {
    const out = normalizeTopics([{ topic: 'a'.repeat(300), reason: 'b'.repeat(300) }]);
    expect(out[0].topic.length).toBe(120);
    expect(out[0].reason.length).toBe(160);
  });

  it('caps the number of topics at 6', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ topic: `t${i}`, reason: `r${i}` }));
    expect(normalizeTopics(many)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// normalizeWhitespace — equality key for focus-history de-dup
// ---------------------------------------------------------------------------

describe('normalizeWhitespace', () => {
  it('treats casing/spacing/line-wrap variants as equal', () => {
    const a = normalizeWhitespace('Writing  the\n  auth   handler');
    const b = normalizeWhitespace('writing the auth handler');
    expect(a).toBe(b);
  });

  it('collapses runs of whitespace to a single space and trims', () => {
    expect(normalizeWhitespace('  a\t\tb\n\nc  ')).toBe('a b c');
  });

  it('distinguishes genuinely different text', () => {
    expect(normalizeWhitespace('adding the button')).not.toBe(
      normalizeWhitespace('removing the button'),
    );
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeWhitespace('   \n\t ')).toBe('');
  });
});
