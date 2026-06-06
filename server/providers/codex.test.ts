import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseCodexResearchOutput, buildActivityPrompt, BASE_FLAGS } from './codex.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'foyer-codex-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseCodexResearchOutput
// ---------------------------------------------------------------------------

describe('parseCodexResearchOutput', () => {
  it('extracts summary from agent_message with string content', async () => {
    const lines = [
      JSON.stringify({ item: { type: 'agent_message', content: 'This is the briefing.' } }),
    ];
    const eventsFile = join(tempDir, 'events.jsonl');
    await writeFile(eventsFile, lines.join('\n'), 'utf-8');

    const result = await parseCodexResearchOutput(eventsFile);
    expect(result.summary).toBe('This is the briefing.');
  });

  it('extracts summary from agent_message with array content', async () => {
    const content = [
      { type: 'text', text: 'Part one. ' },
      { type: 'text', text: 'Part two.' },
    ];
    const lines = [JSON.stringify({ item: { type: 'agent_message', content } })];
    const eventsFile = join(tempDir, 'events.jsonl');
    await writeFile(eventsFile, lines.join('\n'), 'utf-8');

    const result = await parseCodexResearchOutput(eventsFile);
    expect(result.summary).toBe('Part one. \nPart two.');
  });

  it('extracts links from web_search events', async () => {
    const lines = [
      JSON.stringify({ item: { type: 'agent_message', content: 'Summary.' } }),
      JSON.stringify({
        item: { type: 'web_search', url: 'https://example.com', title: 'Example' },
      }),
    ];
    const eventsFile = join(tempDir, 'events.jsonl');
    await writeFile(eventsFile, lines.join('\n'), 'utf-8');

    const result = await parseCodexResearchOutput(eventsFile);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toEqual({ url: 'https://example.com', title: 'Example' });
  });

  it('falls back to URL extraction from summary when no web_search events', async () => {
    const summary = 'See https://react.dev and https://vitejs.dev for details.';
    const lines = [JSON.stringify({ item: { type: 'agent_message', content: summary } })];
    const eventsFile = join(tempDir, 'events.jsonl');
    await writeFile(eventsFile, lines.join('\n'), 'utf-8');

    const result = await parseCodexResearchOutput(eventsFile);
    expect(result.links.length).toBeGreaterThanOrEqual(2);
    expect(result.links.some((l) => l.url === 'https://react.dev')).toBe(true);
    expect(result.links.some((l) => l.url === 'https://vitejs.dev')).toBe(true);
  });

  it('skips malformed JSONL lines and keeps processing', async () => {
    const lines = [
      '{BAD JSON',
      JSON.stringify({ item: { type: 'agent_message', content: 'Valid summary.' } }),
    ];
    const eventsFile = join(tempDir, 'events.jsonl');
    await writeFile(eventsFile, lines.join('\n'), 'utf-8');

    const result = await parseCodexResearchOutput(eventsFile);
    expect(result.summary).toBe('Valid summary.');
  });
});

// ---------------------------------------------------------------------------
// buildActivityPrompt
// ---------------------------------------------------------------------------

describe('buildActivityPrompt', () => {
  const baseCtx = {
    prompt: '',
    prompts: [] as string[],
    recentTouchPoints: [] as { path: string; tool: string; ts: number }[],
    transcriptTail: '',
    previousGraph: null as string | null,
    previousTopics: [] as { topic: string; reason: string }[],
    status: 'working' as 'working' | 'waiting' | 'done',
    waitingReason: null as string | null,
  };

  it('includes the user prompt in the output', () => {
    const result = buildActivityPrompt({ ...baseCtx, prompt: 'Refactor the auth module' });
    expect(result).toContain('Refactor the auth module');
  });

  it('includes touch point file paths in the output', () => {
    const result = buildActivityPrompt({
      ...baseCtx,
      prompt: 'Build tests',
      recentTouchPoints: [
        { path: '/src/auth.ts', tool: 'Write', ts: 1000 },
        { path: '/src/auth.test.ts', tool: 'Write', ts: 2000 },
      ],
    });
    expect(result).toContain('/src/auth.ts');
    expect(result).toContain('/src/auth.test.ts');
  });

  it('includes transcript tail when non-empty', () => {
    const tail = '[assistant] Working on the implementation.\n[tool:Write] /src/index.ts';
    const result = buildActivityPrompt({
      ...baseCtx,
      prompt: 'Implement feature',
      transcriptTail: tail,
    });
    expect(result).toContain(tail);
  });

  it('requests JSON output with summary and graph fields', () => {
    const result = buildActivityPrompt({ ...baseCtx, prompt: 'Test' });
    expect(result).toMatch(/summary/i);
    expect(result).toMatch(/graph/i);
  });

  it('asks for a graph LR milestone storyline, append-only (not a graph TD tool trace)', () => {
    const result = buildActivityPrompt({ ...baseCtx, prompt: 'Test' });
    expect(result).toContain('graph LR');
    expect(result).not.toContain('graph TD');
    expect(result).toMatch(/milestone/i);
    expect(result).toMatch(/append-only/i);
  });

  it('embeds the previous storyline so the model extends it instead of redrawing', () => {
    const prev = 'graph LR\n  G(["Fix login bug"]):::goal --> A["Diagnose"]:::active';
    const result = buildActivityPrompt({
      ...baseCtx,
      prompt: 'Fix login bug',
      previousGraph: prev,
    });
    expect(result).toContain(prev);
  });

  it('surfaces the waiting reason so the storyline can append a terminal chip', () => {
    const result = buildActivityPrompt({
      ...baseCtx,
      prompt: 'Fix login bug',
      status: 'waiting',
      waitingReason: 'Permission requested',
    });
    expect(result).toMatch(/waiting/i);
    expect(result).toContain('Permission requested');
  });

  it('renders the session arc (goal + middle + current focus) when there are multiple prompts', () => {
    const result = buildActivityPrompt({
      ...baseCtx,
      prompts: ['Build the auth module', 'Add rate limiting', 'Now write tests'],
      prompt: 'Now write tests',
    });
    expect(result).toContain('Build the auth module'); // goal anchored even if it scrolled out of the tail
    expect(result).toContain('Now write tests'); // current focus
    expect(result).toMatch(/current focus/i);
    expect(result).toContain('Add rate limiting'); // middle turn compacted in
  });

  it('falls back to a single "Original task" line when there is only one prompt', () => {
    const result = buildActivityPrompt({
      ...baseCtx,
      prompts: ['Just one thing'],
      prompt: 'Just one thing',
    });
    expect(result).toContain('Original task: Just one thing');
  });

  it('asks for a topics array with topic + reason, extraction-only (no web search)', () => {
    const result = buildActivityPrompt({ ...baseCtx, prompt: 'Test' });
    expect(result).toMatch(/topics/i);
    expect(result).toMatch(/reason/i);
    expect(result).toMatch(/EXTRACTION ONLY/i);
  });

  it('embeds previously-suggested topics so chips stay stable across ticks', () => {
    const result = buildActivityPrompt({
      ...baseCtx,
      prompt: 'Fix login bug',
      previousTopics: [{ topic: 'JWT expiry', reason: 'auth work' }],
    });
    expect(result).toContain('JWT expiry');
    expect(result).toMatch(/keep stable|stability/i);
  });
});

// ---------------------------------------------------------------------------
// BASE_FLAGS — flag-assertion tests
// These exist so a refactor can't silently drop the hook-disabling flag
// and inadvertently revive phantom sessions in the dashboard.
// ---------------------------------------------------------------------------

describe('BASE_FLAGS', () => {
  it('contains -c features.hooks=false to disable Codex lifecycle hooks', () => {
    const hooksFlagIdx = BASE_FLAGS.findIndex(
      (flag, i) => flag === '-c' && BASE_FLAGS[i + 1] === 'features.hooks=false',
    );
    expect(hooksFlagIdx).not.toBe(-1);
  });

  it('contains read-only sandbox and never-approval flags', () => {
    expect(BASE_FLAGS).toContain('-s');
    expect(BASE_FLAGS).toContain('read-only');
    expect(BASE_FLAGS).toContain('-a');
    expect(BASE_FLAGS).toContain('never');
  });
});

// ---------------------------------------------------------------------------
// stripFences
// stripFences tests are in text.test.ts (shared util)
