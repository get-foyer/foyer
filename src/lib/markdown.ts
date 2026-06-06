/**
 * Minimal markdown-to-HTML renderer for LLM-generated content.
 *
 * Covers the subset the model outputs: headings (h1–h4), bold, italic,
 * inline code, fenced code blocks, blockquotes, unordered/ordered lists,
 * links, horizontal rules, and paragraphs.
 *
 * Consecutive prose lines are merged into a single <p> (standard markdown
 * semantics). A blank line separates paragraphs.
 *
 * Output must be passed through DOMPurify before setting as innerHTML.
 */

/** Escape HTML special chars (used before inline substitutions). */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Apply inline formatting to an already-escaped string. */
function inline(text: string): string {
  return (
    text
      // Bold + italic: ***text***
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      // Italic: *text* or _text_
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      // Inline code: `code`
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Links: [title](url)
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      )
      // Bare URLs
      .replace(
        /(^|[\s(])(https?:\/\/[^\s)>\]]+)/g,
        '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
      )
  );
}

/** Render a list block (ul or ol) from already-escaped bullet lines. */
function renderList(lines: string[], ordered: boolean): string {
  const tag = ordered ? 'ol' : 'ul';
  const items = lines
    .map((l) => {
      const text = l.replace(/^(\s*(?:\d+\.|-|\*|\+)\s+)/, '');
      return `<li>${inline(text)}</li>`;
    })
    .join('\n');
  return `<${tag}>\n${items}\n</${tag}>`;
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const output: string[] = [];
  let i = 0;

  /** Paragraph line buffer — flushed on any block-level element or blank line. */
  const paraLines: string[] = [];

  function flushPara(): void {
    if (paraLines.length > 0) {
      output.push(`<p>${paraLines.join(' ')}</p>`);
      paraLines.length = 0;
    }
  }

  while (i < lines.length) {
    const raw = lines[i];

    // Fenced code block
    if (/^```/.test(raw)) {
      flushPara();
      const lang = raw.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(esc(lines[i]));
        i++;
      }
      i++; // skip closing ```
      const langAttr = lang ? ` class="language-${esc(lang)}"` : '';
      output.push(`<pre><code${langAttr}>${codeLines.join('\n')}</code></pre>`);
      continue;
    }

    const escaped = esc(raw);

    // Headings
    const hMatch = escaped.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      flushPara();
      const level = hMatch[1].length;
      output.push(`<h${level}>${inline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(---+|\*\*\*+|___+)\s*$/.test(raw)) {
      flushPara();
      output.push('<hr>');
      i++;
      continue;
    }

    // Blockquote — collect consecutive > lines into one <blockquote>
    if (/^>\s?/.test(raw)) {
      flushPara();
      const bqLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        bqLines.push(esc(lines[i].replace(/^>\s?/, '')));
        i++;
      }
      const inner = bqLines.map((l) => `<p>${inline(l)}</p>`).join('\n');
      output.push(`<blockquote>\n${inner}\n</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(raw)) {
      flushPara();
      const listLines = [raw];
      i++;
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        listLines.push(lines[i]);
        i++;
      }
      output.push(renderList(listLines.map(esc), false));
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(raw)) {
      flushPara();
      const listLines = [raw];
      i++;
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        listLines.push(lines[i]);
        i++;
      }
      output.push(renderList(listLines.map(esc), true));
      continue;
    }

    // Blank line → flush current paragraph
    if (raw.trim() === '') {
      flushPara();
      i++;
      continue;
    }

    // Prose line → accumulate into paragraph buffer (merged on flush)
    paraLines.push(inline(escaped));
    i++;
  }

  // Flush any remaining paragraph
  flushPara();

  return output.join('\n');
}
