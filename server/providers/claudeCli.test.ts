import { describe, it, expect } from 'vitest';
import { parseResearchText, parseActivityJson, buildClaudeArgs } from './claudeCli.js';
import { FALLBACK_GRAPH } from './codex.js';
import { FOYER_INTERNAL_SENTINEL } from './internal.js';

// ---------------------------------------------------------------------------
// parseResearchText
// ---------------------------------------------------------------------------

describe('parseResearchText', () => {
  it('parses numbered "Title — URL" links', () => {
    const text = `Summary here.\n\n1. React Docs — https://react.dev\n2. Vite — https://vitejs.dev`;
    const result = parseResearchText(text);
    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toEqual({ title: 'React Docs', url: 'https://react.dev' });
    expect(result.links[1]).toEqual({ title: 'Vite', url: 'https://vitejs.dev' });
  });

  it('parses markdown [Title](URL) links', () => {
    const text = `Summary.\n\n[React Docs](https://react.dev) is useful.`;
    const result = parseResearchText(text);
    expect(result.links.some((l) => l.url === 'https://react.dev')).toBe(true);
  });

  it('deduplicates URLs', () => {
    const text = `1. React — https://react.dev\n2. React Again — https://react.dev`;
    const result = parseResearchText(text);
    const reactLinks = result.links.filter((l) => l.url === 'https://react.dev');
    expect(reactLinks).toHaveLength(1);
  });

  it('caps links at 8', () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) => `${i + 1}. Title ${i} — https://example.com/${i}`,
    );
    const result = parseResearchText(lines.join('\n'));
    expect(result.links.length).toBeLessThanOrEqual(8);
  });

  it('returns the full text as the summary', () => {
    const text = 'This is the summary text.';
    const result = parseResearchText(text);
    expect(result.summary).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// parseActivityJson
// ---------------------------------------------------------------------------

describe('parseActivityJson', () => {
  it('parses a valid { summary, graph } JSON object', () => {
    const raw = JSON.stringify({
      summary: 'Agent is refactoring the auth module.',
      graph: 'graph TD\n  A[Start] --> B[Auth]:::active\n  classDef active fill:#1f6feb',
    });
    const result = parseActivityJson(raw);
    expect(result.summary).toBe('Agent is refactoring the auth module.');
    expect(result.graph).toContain('graph TD');
  });

  it('strips markdown fences before parsing', () => {
    const raw =
      '```json\n' +
      JSON.stringify({ summary: 'Working on tests.', graph: 'graph TD\n  A[Test]' }) +
      '\n```';
    const result = parseActivityJson(raw);
    expect(result.summary).toBe('Working on tests.');
  });

  it('falls back gracefully when JSON is invalid', () => {
    const result = parseActivityJson('not valid JSON at all');
    expect(result.summary).toBe('not valid JSON at all');
    expect(result.graph).toBe(FALLBACK_GRAPH);
  });

  it('provides fallback values when fields are missing', () => {
    const result = parseActivityJson(JSON.stringify({}));
    expect(result.summary).toBe('Agent is working…');
    expect(result.graph).toBe(FALLBACK_GRAPH);
  });

  it('strips mermaid fences from the graph field', () => {
    const raw = JSON.stringify({
      summary: 'Building API.',
      graph: '```mermaid\ngraph TD\n  A-->B\n```',
    });
    const result = parseActivityJson(raw);
    expect(result.graph).toBe('graph TD\n  A-->B');
  });

  it('parses and normalizes the topics array', () => {
    const raw = JSON.stringify({
      summary: 'S',
      graph: 'graph TD\n  A',
      topics: [
        { topic: 'React useTransition', reason: 'used in App.tsx' },
        { topic: '', reason: 'dropped — no topic' },
      ],
    });
    const result = parseActivityJson(raw);
    expect(result.topics).toEqual([{ topic: 'React useTransition', reason: 'used in App.tsx' }]);
  });

  it('defaults topics to [] when the field is missing', () => {
    const result = parseActivityJson(JSON.stringify({ summary: 'S', graph: 'G' }));
    expect(result.topics).toEqual([]);
  });

  it('defaults topics to [] when JSON is invalid', () => {
    const result = parseActivityJson('not json');
    expect(result.topics).toEqual([]);
  });
});

// stripFences tests are in text.test.ts (shared util)

// ---------------------------------------------------------------------------
// buildClaudeArgs — flag-assertion tests
// These exist so a refactor can't silently drop the source-isolation flags
// and inadvertently revive phantom sessions in the dashboard.
// ---------------------------------------------------------------------------

describe('buildClaudeArgs', () => {
  it('includes --setting-sources user to exclude project/local hooks', () => {
    const args = buildClaudeArgs('some prompt', []);
    const idx = args.indexOf('--setting-sources');
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe('user');
  });

  it('places the sentinel-prefixed prompt as the -p argument', () => {
    const sentinelPrompt = `${FOYER_INTERNAL_SENTINEL}\nDo something`;
    const args = buildClaudeArgs(sentinelPrompt, []);
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe(sentinelPrompt);
    expect(args[1]).toContain(FOYER_INTERNAL_SENTINEL);
  });

  it('includes --output-format json', () => {
    const args = buildClaudeArgs('prompt', []);
    const idx = args.indexOf('--output-format');
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe('json');
  });

  it('appends extra args after the fixed flags', () => {
    const args = buildClaudeArgs('prompt', ['--allowedTools', 'WebSearch']);
    expect(args).toContain('--allowedTools');
    expect(args).toContain('WebSearch');
    // Extra args come after the fixed flags
    expect(args.indexOf('--allowedTools')).toBeGreaterThan(args.indexOf('--setting-sources'));
  });
});
