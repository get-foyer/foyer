import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseActivityJson, buildClaudeArgs, ClaudeCliProvider } from './claudeCli.js';
import { FOYER_INTERNAL_SENTINEL } from './internal.js';

// Capture the argv handed to the (promisified) execFile and control its stdout,
// so we can assert what `claude -p` is actually invoked with — without spawning.
// vi.hoisted lets the hoisted vi.mock factory below reference this safely.
const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[] }[],
  stdout: '',
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    // promisify(execFile) invokes execFile(cmd, args, opts, cb) and resolves to
    // the callback's first result arg — i.e. { stdout, stderr }.
    execFile: (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
    ) => {
      h.calls.push({ cmd, args });
      cb(null, { stdout: h.stdout, stderr: '' });
    },
  };
});

// parseResearchSections coverage lives in text.test.ts (shared util). claude-cli's research()
// integration with it is exercised in the ClaudeCliProvider.research block below.

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

  it('falls back gracefully when JSON is invalid (graph → null = no workflow)', () => {
    const result = parseActivityJson('not valid JSON at all');
    expect(result.summary).toBe('not valid JSON at all');
    expect(result.graph).toBeNull();
  });

  it('returns a null graph (no workflow) when the graph field is missing', () => {
    const result = parseActivityJson(JSON.stringify({}));
    expect(result.summary).toBe('Agent is working…');
    expect(result.graph).toBeNull();
  });

  it('returns a null graph when the model explicitly sends graph: null (trivial work)', () => {
    const result = parseActivityJson(JSON.stringify({ summary: 'Quick fix.', graph: null }));
    expect(result.summary).toBe('Quick fix.');
    expect(result.graph).toBeNull();
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

// ---------------------------------------------------------------------------
// ClaudeCliProvider.research() — argv regression
// run() always JSON.parse(stdout)s and buildClaudeArgs() hardcodes
// `--output-format json`. research() must NOT pass its own `--output-format`:
// a second one (text) makes the CLI emit plain text, JSON.parse throws, and
// /research 500s. This guards against re-introducing that conflicting flag.
// ---------------------------------------------------------------------------

describe('ClaudeCliProvider.research', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.stdout = '';
  });

  it('invokes claude with exactly one --output-format (json)', async () => {
    h.stdout = JSON.stringify({ result: 'Briefing.' });
    await new ClaudeCliProvider().research('React Server Components');

    expect(h.calls).toHaveLength(1);
    const { args } = h.calls[0];
    const formatFlags = args.filter((a) => a === '--output-format');
    expect(formatFlags).toHaveLength(1); // the bug: two flags (json then text)
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('still requests the web tools research needs', async () => {
    h.stdout = JSON.stringify({ result: 'Briefing.' });
    await new ClaudeCliProvider().research('topic');

    const { args } = h.calls[0];
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('WebSearch,WebFetch');
  });

  it('parses a structured briefing into lede + sections + links from the JSON `sources`', async () => {
    h.stdout = JSON.stringify({
      result: JSON.stringify({
        lede: 'RSC render on the server.',
        sections: [{ heading: 'Overview', body: 'They stream a UI description.' }],
        sources: [
          { title: 'React', url: 'https://react.dev' },
          { title: 'Vite', url: 'https://vitejs.dev' },
        ],
      }),
    });
    const result = await new ClaudeCliProvider().research('topic');

    expect(result.lede).toBe('RSC render on the server.');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({ heading: 'Overview' });
    expect(result.links).toEqual([
      { title: 'React', url: 'https://react.dev' },
      { title: 'Vite', url: 'https://vitejs.dev' },
    ]);
  });

  it('falls back to a single section (never throws) when the model returns non-JSON prose', async () => {
    h.stdout = JSON.stringify({ result: 'Just some prose, not JSON at all.' });
    const result = await new ClaudeCliProvider().research('My Topic');

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].heading).toBe('My Topic');
    expect(result.sections[0].body).toContain('Just some prose');
    expect(result.links).toEqual([]);
  });
});
