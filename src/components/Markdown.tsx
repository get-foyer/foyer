import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  text: string;
  className?: string;
}

// External links open in a new tab with noopener/noreferrer — react-markdown does not add
// target/rel itself, and the old custom renderer did. `node` is destructured out so it never
// reaches the DOM element.
const components: Components = {
  a({ node: _node, href, children, ...props }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

/**
 * Renders LLM-generated GitHub-flavored markdown (prose, lists, tables, code) for the
 * narration, plan, and research surfaces.
 *
 * react-markdown escapes raw HTML by default and we deliberately do NOT enable `rehype-raw`,
 * so untrusted model output cannot inject HTML or scripts — no DOMPurify pass is needed on the
 * markdown path. Diagrams are NOT interleaved here; research renders them separately via
 * MermaidFigure (from the structured `section.diagram` field).
 */
export function Markdown({ text, className }: Props) {
  return (
    <div className={['markdown', className].filter(Boolean).join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
