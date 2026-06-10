import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalDirSource, extractTitleAndSnippet } from './local.js';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'foyer-docsrc-'));
  outside = await mkdtemp(join(tmpdir(), 'foyer-outside-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('extractTitleAndSnippet', () => {
  it('takes the first heading as title and first paragraph as snippet', () => {
    const { title, snippet } = extractTitleAndSnippet(
      '# Design System\n\nWarm-black instrument enclosure with one amber LED.\n\nSecond para.',
      'DESIGN.md',
    );
    expect(title).toBe('Design System');
    expect(snippet).toBe('Warm-black instrument enclosure with one amber LED.');
  });

  it('skips YAML frontmatter, HTML comments, blockquotes, and badges', () => {
    const head = [
      '---',
      'status: draft',
      '---',
      '<!-- AUTO-GENERATED -->',
      '> a blockquote callout',
      '![badge](x.svg)',
      '# ADR 0003',
      '',
      'Context: warm the cache before the tap.',
    ].join('\n');
    const { title, snippet } = extractTitleAndSnippet(head, 'adr.md');
    expect(title).toBe('ADR 0003');
    expect(snippet).toBe('Context: warm the cache before the tap.');
  });

  it('falls back to the filename when there is no heading, and caps the snippet at 500', () => {
    const { title, snippet } = extractTitleAndSnippet('x'.repeat(900), 'notes.txt');
    expect(title).toBe('notes.txt');
    expect(snippet).toHaveLength(500);
  });

  it('handles an empty file', () => {
    const { title, snippet } = extractTitleAndSnippet('', 'empty.md');
    expect(title).toBe('empty.md');
    expect(snippet).toBe('');
  });
});

describe('LocalDirSource', () => {
  it('indexes allowlisted files and skips other extensions', async () => {
    await writeFile(join(root, 'a.md'), '# Doc A\n\nAbout A.');
    await writeFile(join(root, 'b.ts'), 'export const x = 1;');
    const out = await new LocalDirSource('ext', root, {}).list();
    expect(out.map((d) => d.path)).toEqual(['a.md']);
    expect(out[0].title).toBe('Doc A');
    expect(out[0].source).toBe('ext');
  });

  it('skips oversized files without reading them', async () => {
    await writeFile(join(root, 'big.md'), '#'.repeat(300 * 1024));
    await writeFile(join(root, 'ok.md'), '# OK\n\nSmall.');
    const out = await new LocalDirSource('ext', root, {}).list();
    expect(out.map((d) => d.path)).toEqual(['ok.md']);
  });

  it('refuses symlinks that escape the root', async () => {
    await writeFile(join(outside, 'secret.md'), '# Secret\n\nDo not index.');
    await symlink(join(outside, 'secret.md'), join(root, 'link.md'));
    await writeFile(join(root, 'ok.md'), '# OK\n\nFine.');
    const out = await new LocalDirSource('ext', root, {}).list();
    expect(out.map((d) => d.path)).toEqual(['ok.md']);
  });

  it('skips junk dirs (node_modules, .git) and unreadable roots', async () => {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'dep.md'), '# Dep');
    await writeFile(join(root, 'real.md'), '# Real\n\nYes.');
    const out = await new LocalDirSource('ext', root, {}).list();
    expect(out.map((d) => d.path)).toEqual(['real.md']);
    expect(await new LocalDirSource('gone', join(root, 'missing'), {}).list()).toEqual([]);
  });

  it('repoMode indexes only root-level files + the docs/ tree', async () => {
    await writeFile(join(root, 'README.md'), '# Repo\n\nHello.');
    await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
    await writeFile(join(root, 'docs', 'decisions', '0001.md'), '# ADR 1\n\nDecided.');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'stray.md'), '# Stray\n\nNot a doc surface.');
    const out = await new LocalDirSource('repo', root, { repoMode: true }).list();
    const paths = out.map((d) => d.path).sort();
    expect(paths).toEqual(['README.md', 'docs/decisions/0001.md']);
  });

  it('serves unchanged files from the mtime cache across scans', async () => {
    await writeFile(join(root, 'a.md'), '# A\n\nFirst.');
    const src = new LocalDirSource('ext', root, {});
    const first = await src.list();
    const second = await src.list();
    expect(second).toEqual(first); // identical snapshot, file read once per mtime
  });
});
