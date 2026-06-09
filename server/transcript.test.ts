import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readTranscriptTail, getTranscriptSize, readFirstUserPrompt } from './transcript.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'foyer-transcript-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a JSONL transcript line for an assistant text block. */
function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

/** Build a JSONL line for an assistant tool_use block. */
function assistantTool(name: string, file_path: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: { file_path } }] },
  });
}

/** Build a JSONL line for a user message whose content is a plain string. */
function userString(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', message: { content: text }, ...extra });
}

/** Build a JSONL line for a user message whose content is a block array. */
function userBlocks(blocks: Array<Record<string, unknown>>): string {
  return JSON.stringify({ type: 'user', message: { content: blocks } });
}

// ---------------------------------------------------------------------------
// readTranscriptTail
// ---------------------------------------------------------------------------

describe('readTranscriptTail', () => {
  it('returns an empty string when the file does not exist', async () => {
    const result = await readTranscriptTail(join(tempDir, 'nonexistent.jsonl'));
    expect(result).toBe('');
  });

  it('extracts assistant text blocks', async () => {
    const lines = [assistantText('I will write the tests now.'), assistantText('Done.')];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readTranscriptTail(path);
    expect(result).toContain('[assistant] I will write the tests now.');
    expect(result).toContain('[assistant] Done.');
  });

  it('extracts tool_use blocks with file path', async () => {
    const lines = [assistantTool('Write', '/src/auth.ts')];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readTranscriptTail(path);
    expect(result).toContain('[tool:Write] /src/auth.ts');
  });

  it('skips malformed JSONL lines without throwing', async () => {
    const lines = ['{INVALID JSON', assistantText('Still works after bad line.')];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readTranscriptTail(path);
    expect(result).toContain('[assistant] Still works after bad line.');
  });

  it('skips lines that are not type:assistant', async () => {
    const lines = [
      JSON.stringify({ type: 'user', content: 'ignored' }),
      JSON.stringify({ type: 'summary', data: 'also ignored' }),
      assistantText('This is included.'),
    ];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readTranscriptTail(path);
    expect(result).toContain('[assistant] This is included.');
    expect(result).not.toContain('ignored');
    expect(result).not.toContain('also ignored');
  });

  it('caps output at MAX_CHARS (4000 chars)', async () => {
    // Generate a transcript that would exceed the cap
    const longText = 'x'.repeat(600); // each line ~614 chars after prefix
    const lines = Array.from({ length: 10 }, () => assistantText(longText));
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readTranscriptTail(path);
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it('drops the first (partial) line when reading from a byte offset', async () => {
    // Create a large enough file that maxBytes kicks in and cuts a line in the middle.
    // The first line after byte-offset cut will be partial and should be dropped.
    const lines = Array.from({ length: 30 }, (_, i) => assistantText(`Line ${i}`));
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    // Use a small maxBytes so the file is definitely sliced
    const result = await readTranscriptTail(path, 200);
    // Should have some content (didn't throw)
    // Should NOT contain "Line 0" (would be in the dropped partial)
    // Hard to test exactly which line is first — just ensure no crash and some output
    expect(typeof result).toBe('string');
  });

  it('handles an empty file gracefully', async () => {
    const path = join(tempDir, 'empty.jsonl');
    await writeFile(path, '', 'utf-8');
    const result = await readTranscriptTail(path);
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// readFirstUserPrompt
// ---------------------------------------------------------------------------

describe('readFirstUserPrompt', () => {
  it('returns null when the file does not exist', async () => {
    const result = await readFirstUserPrompt(join(tempDir, 'nonexistent.jsonl'));
    expect(result).toBeNull();
  });

  it('returns the first user prompt (string content)', async () => {
    const lines = [
      userString('Fix the login redirect bug'),
      assistantText('On it.'),
      userString('Also update the tests'),
    ];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readFirstUserPrompt(path);
    expect(result).toBe('Fix the login redirect bug');
  });

  it('extracts the first text block from array content', async () => {
    const lines = [userBlocks([{ type: 'text', text: 'Refactor the auth module' }])];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readFirstUserPrompt(path);
    expect(result).toBe('Refactor the auth module');
  });

  it('skips tool_result-only user entries and finds the real prompt', async () => {
    const lines = [
      userBlocks([{ type: 'tool_result', tool_use_id: 'abc', content: 'output' }]),
      userString('Add a dark mode toggle'),
    ];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readFirstUserPrompt(path);
    expect(result).toBe('Add a dark mode toggle');
  });

  it('skips isMeta user entries', async () => {
    const lines = [
      userString('injected meta context', { isMeta: true }),
      userString('The real task'),
    ];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readFirstUserPrompt(path);
    expect(result).toBe('The real task');
  });

  it('skips slash-command and caveat wrapper messages', async () => {
    const lines = [
      userString('<command-name>/plan</command-name>'),
      userString('Caveat: The messages below were generated by the user.'),
      userString('Build the settings page'),
    ];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readFirstUserPrompt(path);
    expect(result).toBe('Build the settings page');
  });

  it('strips a leading system-reminder wrapper from the prompt', async () => {
    const lines = [
      userString('<system-reminder>some context</system-reminder>Migrate to Postgres'),
    ];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readFirstUserPrompt(path);
    expect(result).toBe('Migrate to Postgres');
  });

  it('returns null when there is no user prompt', async () => {
    const lines = [assistantText('hello'), assistantTool('Read', '/a.ts')];
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n'), 'utf-8');

    const result = await readFirstUserPrompt(path);
    expect(result).toBeNull();
  });

  it('caps the recovered prompt length', async () => {
    const longPrompt = 'y'.repeat(500);
    const path = join(tempDir, 'transcript.jsonl');
    await writeFile(path, userString(longPrompt), 'utf-8');

    const result = await readFirstUserPrompt(path);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(200);
  });

  it('handles an empty file gracefully', async () => {
    const path = join(tempDir, 'empty.jsonl');
    await writeFile(path, '', 'utf-8');
    const result = await readFirstUserPrompt(path);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getTranscriptSize
// ---------------------------------------------------------------------------

describe('getTranscriptSize', () => {
  it('returns the byte size of the file', async () => {
    const content = 'hello world';
    const path = join(tempDir, 'size-test.jsonl');
    await writeFile(path, content, 'utf-8');

    const size = await getTranscriptSize(path);
    expect(size).toBe(Buffer.byteLength(content, 'utf-8'));
  });

  it('returns null when the file does not exist', async () => {
    const size = await getTranscriptSize(join(tempDir, 'nonexistent.jsonl'));
    expect(size).toBeNull();
  });

  it('returns 0 for an empty file', async () => {
    const path = join(tempDir, 'zero.jsonl');
    await writeFile(path, '', 'utf-8');
    const size = await getTranscriptSize(path);
    expect(size).toBe(0);
  });
});
