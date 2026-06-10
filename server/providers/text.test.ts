import { describe, it, expect } from 'vitest';
import {
  stripFences,
  normalizeTopics,
  normalizeWhitespace,
  RESEARCH_PROMPT,
  parseResearchSections,
} from './text.js';

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

// ---------------------------------------------------------------------------
// RESEARCH_PROMPT — the shared structured-briefing instruction
// ---------------------------------------------------------------------------

describe('RESEARCH_PROMPT', () => {
  it('embeds the topic and asks for the structured JSON shape', () => {
    const p = RESEARCH_PROMPT('React Server Components');
    expect(p).toContain('React Server Components');
    expect(p).toMatch(/"lede"/);
    expect(p).toMatch(/"sections"/);
    expect(p).toMatch(/"sources"/);
  });

  it('states the adaptive rule (single section for simple topics, diagram only when it helps)', () => {
    const p = RESEARCH_PROMPT('x');
    expect(p).toMatch(/SINGLE section/i);
    expect(p).toMatch(/do not invent sections/i);
    expect(p).toMatch(/ONLY when a visual genuinely aids/i);
  });
});

// ---------------------------------------------------------------------------
// parseResearchSections — structured briefing parser (with single-section fallback)
// ---------------------------------------------------------------------------

describe('parseResearchSections', () => {
  it('parses a valid briefing JSON into lede + sections + sources', () => {
    const raw = JSON.stringify({
      lede: 'A gist.',
      sections: [{ heading: 'Overview', body: 'Body.' }],
      sources: [{ title: 'Docs', url: 'https://example.com' }],
    });
    const r = parseResearchSections(raw, 'topic');
    expect(r.lede).toBe('A gist.');
    expect(r.sections).toEqual([{ heading: 'Overview', body: 'Body.' }]);
    expect(r.sources).toEqual([{ title: 'Docs', url: 'https://example.com' }]);
  });

  it('strips ```json fences before parsing', () => {
    const raw = '```json\n' + JSON.stringify({ sections: [{ heading: 'H', body: 'B' }] }) + '\n```';
    const r = parseResearchSections(raw, 'topic');
    expect(r.sections[0]).toEqual({ heading: 'H', body: 'B' });
  });

  it('extracts the JSON object when the model wraps it in prose preamble', () => {
    const raw =
      'Here is your briefing:\n' + JSON.stringify({ sections: [{ heading: 'H', body: 'B' }] });
    const r = parseResearchSections(raw, 'topic');
    expect(r.sections[0].heading).toBe('H');
  });

  it('falls back to a single section (heading = topic) on non-JSON prose — never throws', () => {
    const r = parseResearchSections('totally not json', 'My Topic');
    expect(r.sections).toEqual([{ heading: 'My Topic', body: 'totally not json' }]);
    expect(r.lede).toBe('');
    expect(r.sources).toEqual([]);
  });

  it('falls back when JSON parses but yields zero usable sections (all bodies empty)', () => {
    const raw = JSON.stringify({ lede: 'x', sections: [{ heading: 'H' }, { body: '' }] });
    const r = parseResearchSections(raw, 'T');
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].heading).toBe('T');
  });

  it('keeps a fence-stripped diagram and drops one past the size cap', () => {
    const okDiagram = '```mermaid\nflowchart LR\n  A-->B\n```';
    const huge = 'flowchart LR\n' + 'A-->B\n'.repeat(2000); // > 4000 chars
    const raw = JSON.stringify({
      sections: [
        { heading: 'Has diagram', body: 'b', diagram: okDiagram },
        { heading: 'Too big', body: 'b', diagram: huge },
      ],
    });
    const r = parseResearchSections(raw, 'T');
    expect(r.sections[0].diagram).toBe('flowchart LR\n  A-->B');
    expect(r.sections[1].diagram).toBeUndefined();
  });

  it('drops sources without a valid http(s) url and dedupes', () => {
    const raw = JSON.stringify({
      sections: [{ heading: 'H', body: 'B' }],
      sources: [
        { title: 'Good', url: 'https://a.example' },
        { title: 'Dupe', url: 'https://a.example' },
        { title: 'Bad', url: 'not-a-url' },
      ],
    });
    const r = parseResearchSections(raw, 'T');
    expect(r.sources).toEqual([{ title: 'Good', url: 'https://a.example' }]);
  });

  it('drops sources with dangerous URL schemes', () => {
    const raw = JSON.stringify({
      sections: [{ heading: 'H', body: 'B' }],
      sources: [
        { title: 'XSS', url: 'javascript:alert(1)' },
        { title: 'Data', url: 'data:text/html,<script>alert(1)</script>' },
        { title: 'Good', url: 'https://a.example' },
      ],
    });
    const r = parseResearchSections(raw, 'T');
    expect(r.sources).toEqual([{ title: 'Good', url: 'https://a.example' }]);
  });
});
