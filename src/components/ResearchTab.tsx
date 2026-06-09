import React, { useEffect, useMemo, useState } from 'react';
import type { ResearchResult } from '../types';
import { Markdown } from './Markdown';
import { MermaidFigure } from './MermaidFigure';
import { sectionAnchors, estimateReadMinutes, serializeToMarkdown } from '../lib/research';

interface Props {
  /** This session's briefings, newest-first (binds directly to `session.research`). */
  results: ResearchResult[];
  /** The briefing currently shown in the reading pane (controlled by App). */
  selectedTs: number | null;
  onSelect: (ts: number) => void;
}

/**
 * The `04 · RESEARCH` view — a full-width reading surface for a session's briefings. Left: a
 * topic index (newest-first). Right: the selected briefing rendered as a document — a TL;DR lede,
 * an in-doc section index (when there's more than one section), sectioned prose with tables and
 * a diagram where the model judged one warranted, read-time, and copy. Selection is controlled by
 * App so it survives Focus⇄Research toggles.
 */
export function ResearchTab({ results, selectedTs, onSelect }: Props) {
  const selected = results.find((r) => r.ts === selectedTs) ?? results[0] ?? null;

  const anchors = useMemo(() => (selected ? sectionAnchors(selected.sections) : []), [selected]);
  const readMin = useMemo(
    () => (selected ? estimateReadMinutes(selected.sections, selected.lede) : 0),
    [selected],
  );

  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const t = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(t);
  }, [copyState]);
  // Reset the copy affordance when switching briefings.
  useEffect(() => setCopyState('idle'), [selectedTs]);

  // App only mounts this once results exist; stay safe if that ever changes.
  if (!selected) {
    return (
      <div
        className="research-tab research-tab--empty"
        role="tabpanel"
        id="view-panel-research"
        aria-labelledby="view-tab-research"
      >
        <div className="panel__empty">
          <span className="panel__empty-glyph">◱</span>
          <p>No briefings yet — tap a topic in Deep Research to start reading.</p>
        </div>
      </div>
    );
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(serializeToMarkdown(selected));
      setCopyState('ok');
    } catch {
      setCopyState('fail');
    }
  };

  const onJump = (slug: string) => {
    document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const copyLabel =
    copyState === 'ok' ? 'Copied ✓' : copyState === 'fail' ? 'Copy failed' : 'Copy markdown';

  return (
    <div
      className="research-tab"
      role="tabpanel"
      id="view-panel-research"
      aria-labelledby="view-tab-research"
    >
      <nav className="research-tab__index" aria-label="Briefings">
        <p className="research-tab__index-title">Briefings</p>
        <ul className="research-tab__index-list">
          {results.map((r) => {
            const isSel = r.ts === selected.ts;
            return (
              <li key={r.ts}>
                <button
                  type="button"
                  className={`research-tab__index-item${
                    isSel ? ' research-tab__index-item--selected' : ''
                  }`}
                  aria-current={isSel ? 'true' : undefined}
                  onClick={() => onSelect(r.ts)}
                >
                  <span className="research-tab__index-topic">{r.topic}</span>
                  <time className="research-tab__index-ts">
                    {new Date(r.ts).toLocaleTimeString()}
                  </time>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <article className="research-tab__reading" aria-live="polite">
        <header className="research-tab__reading-head">
          <div className="research-tab__reading-headline">
            <h1 className="research-tab__reading-topic">{selected.topic}</h1>
            <div className="research-tab__reading-meta">
              <span className="research-tab__readtime">~{readMin} min read</span>
              <button type="button" className="research-tab__copy" onClick={onCopy}>
                {copyLabel}
              </button>
            </div>
          </div>
          <time className="research-tab__reading-ts">{new Date(selected.ts).toLocaleString()}</time>
        </header>

        {selected.lede && <Markdown text={selected.lede} className="research-tab__lede" />}

        {anchors.length >= 2 && (
          <nav className="research-tab__sections" aria-label="Sections in this briefing">
            {anchors.map((a, i) => (
              <button
                key={a.slug}
                type="button"
                className="research-tab__section-link"
                onClick={() => onJump(a.slug)}
              >
                <span className="research-tab__section-idx">{String(i + 1).padStart(2, '0')}</span>
                <span className="research-tab__section-name">{a.heading}</span>
              </button>
            ))}
          </nav>
        )}

        {selected.sections.map((s, i) => (
          <section key={anchors[i].slug} id={anchors[i].slug} className="research-tab__section">
            {s.heading && selected.sections.length > 1 && (
              <h2 className="research-tab__section-heading">{s.heading}</h2>
            )}
            <Markdown text={s.body} className="research-tab__summary" />
            {s.diagram && <MermaidFigure diagram={s.diagram} />}
          </section>
        ))}

        {selected.links.length > 0 && (
          <section className="research-tab__sources">
            <h2 className="research-tab__sources-title">Sources</h2>
            <ol className="research-tab__sources-list">
              {selected.links.map((link, i) => (
                <li key={i}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="research-tab__source-link"
                  >
                    {link.title || link.url}
                  </a>
                </li>
              ))}
            </ol>
          </section>
        )}
      </article>
    </div>
  );
}
