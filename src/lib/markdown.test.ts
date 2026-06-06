import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

// ---------------------------------------------------------------------------
// Paragraphs — the critical regression (one <p> per line → merged paragraph)
// ---------------------------------------------------------------------------

describe('paragraphs', () => {
  it('wraps a single prose line in one <p>', () => {
    expect(renderMarkdown('Hello world')).toBe('<p>Hello world</p>');
  });

  it('merges consecutive prose lines into ONE <p>', () => {
    // The key bug: three source lines must become one paragraph, NOT three
    const html = renderMarkdown('Line one\nLine two\nLine three');
    expect(html).toBe('<p>Line one Line two Line three</p>');
  });

  it('separates paragraphs on a blank line', () => {
    const html = renderMarkdown('First paragraph.\n\nSecond paragraph.');
    expect(html).toContain('<p>First paragraph.</p>');
    expect(html).toContain('<p>Second paragraph.</p>');
    expect((html.match(/<p>/g) ?? []).length).toBe(2);
  });

  it('trims trailing blank lines without producing empty paragraphs', () => {
    const html = renderMarkdown('Text\n\n\n');
    expect(html).toBe('<p>Text</p>');
  });

  it('renders inline bold within merged paragraphs', () => {
    const html = renderMarkdown('Start **bold** end\nContinued line');
    expect(html).toContain('<strong>bold</strong>');
    // Still just one paragraph
    expect((html.match(/<p>/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Blockquote (missing feature that caused literal `>` rendering)
// ---------------------------------------------------------------------------

describe('blockquote', () => {
  it('renders a single > line as <blockquote>', () => {
    const html = renderMarkdown('> This is quoted');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('This is quoted');
    expect(html).not.toContain('&gt;');
  });

  it('merges consecutive > lines into a single <blockquote>', () => {
    const html = renderMarkdown('> Line one\n> Line two');
    expect((html.match(/<blockquote>/g) ?? []).length).toBe(1);
    expect(html).toContain('Line one');
    expect(html).toContain('Line two');
  });

  it('preserves bold formatting inside blockquotes', () => {
    const html = renderMarkdown('> **Important**: read this');
    expect(html).toContain('<strong>Important</strong>');
    expect(html).toContain('<blockquote>');
  });

  it('preserves italic formatting inside blockquotes', () => {
    const html = renderMarkdown('> *emphasis* here');
    expect(html).toContain('<em>emphasis</em>');
  });

  it('stops collecting blockquote lines at a blank line', () => {
    const html = renderMarkdown('> Quote\n\nParagraph after');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<p>Paragraph after</p>');
  });

  it('blockquote after prose flushes the paragraph first', () => {
    const html = renderMarkdown('Prose line\n> Quote');
    expect(html).toContain('<p>Prose line</p>');
    expect(html).toContain('<blockquote>');
  });
});

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

describe('headings', () => {
  it('renders # as h1', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>');
  });

  it('renders ## as h2', () => {
    expect(renderMarkdown('## Section')).toContain('<h2>Section</h2>');
  });

  it('renders #### as h4', () => {
    expect(renderMarkdown('#### Small')).toContain('<h4>Small</h4>');
  });

  it('does not swallow prose following a heading', () => {
    const html = renderMarkdown('# Title\nFirst paragraph');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>First paragraph</p>');
  });

  it('heading flushes an open paragraph first', () => {
    const html = renderMarkdown('Open para\n# Heading');
    expect(html).toContain('<p>Open para</p>');
    expect(html).toContain('<h1>Heading</h1>');
  });
});

// ---------------------------------------------------------------------------
// Horizontal rule
// ---------------------------------------------------------------------------

describe('horizontal rule', () => {
  it('renders --- as <hr>', () => {
    expect(renderMarkdown('---')).toContain('<hr>');
  });

  it('renders *** as <hr>', () => {
    expect(renderMarkdown('***')).toContain('<hr>');
  });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe('lists', () => {
  it('renders an unordered list', () => {
    const html = renderMarkdown('- Apple\n- Banana\n- Cherry');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Apple</li>');
    expect(html).toContain('<li>Banana</li>');
    expect(html).toContain('<li>Cherry</li>');
  });

  it('renders an ordered list', () => {
    const html = renderMarkdown('1. First\n2. Second');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('<li>Second</li>');
  });

  it('list items support inline bold', () => {
    const html = renderMarkdown('- **Bold** item');
    expect(html).toContain('<strong>Bold</strong>');
  });

  it('list flushes an open paragraph first', () => {
    const html = renderMarkdown('Intro\n- Item');
    expect(html).toContain('<p>Intro</p>');
    expect(html).toContain('<li>Item</li>');
  });
});

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

describe('fenced code blocks', () => {
  it('renders a fenced code block with language class', () => {
    const html = renderMarkdown('```typescript\nconst x = 1;\n```');
    expect(html).toContain('<pre><code class="language-typescript">');
    expect(html).toContain('const x = 1;');
  });

  it('renders a fenced code block without a language tag', () => {
    const html = renderMarkdown('```\nraw code\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('raw code');
  });

  it('escapes HTML inside code blocks', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('preserves prose before and after a code block', () => {
    const html = renderMarkdown('Intro\n```\ncode\n```\nOutro');
    expect(html).toContain('<p>Intro</p>');
    expect(html).toContain('<p>Outro</p>');
  });
});

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

describe('inline formatting', () => {
  it('renders **bold**', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  it('renders __bold__', () => {
    expect(renderMarkdown('__bold__')).toContain('<strong>bold</strong>');
  });

  it('renders *italic*', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
  });

  it('renders ***bold+italic***', () => {
    expect(renderMarkdown('***bi***')).toContain('<strong><em>bi</em></strong>');
  });

  it('renders `inline code`', () => {
    expect(renderMarkdown('Use `const x`')).toContain('<code>const x</code>');
  });

  it('renders [link](url)', () => {
    const html = renderMarkdown('[React](https://react.dev)');
    expect(html).toContain('<a href="https://react.dev"');
    expect(html).toContain('React');
  });

  it('escapes HTML special chars in prose', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes & in prose', () => {
    const html = renderMarkdown('Tom & Jerry');
    expect(html).toContain('Tom &amp; Jerry');
  });
});
