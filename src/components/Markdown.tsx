import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../lib/markdown';

interface Props {
  text: string;
  className?: string;
}

/**
 * Renders LLM-generated markdown as sanitized HTML.
 * Uses DOMPurify (already a project dependency) to strip any unsafe markup.
 */
export function Markdown({ text, className }: Props) {
  const html = useMemo(() => {
    const raw = renderMarkdown(text);
    return DOMPurify.sanitize(raw, {
      // Allow target/_blank links (DOMPurify strips target by default)
      ADD_ATTR: ['target', 'rel'],
    });
  }, [text]);

  return (
    <div
      className={['markdown', className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
