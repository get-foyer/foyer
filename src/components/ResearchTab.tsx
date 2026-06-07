import React from 'react';
import type { ResearchResult } from '../types';
import { Markdown } from './Markdown';

interface Props {
  /** This session's briefings, newest-first (binds directly to `session.research`). */
  results: ResearchResult[];
  /** The briefing currently shown in the reading pane (controlled by App). */
  selectedTs: number | null;
  onSelect: (ts: number) => void;
}

/**
 * The `04 · RESEARCH` view — a full-width reading surface for a session's briefings, the
 * inverse of the cramped 360px rail card it replaces. Left: a topic index (newest-first).
 * Right: the selected briefing given room to breathe. Selection is controlled by App so it
 * survives Focus⇄Research toggles and so a rail "ready" row can open a specific briefing.
 */
export function ResearchTab({ results, selectedTs, onSelect }: Props) {
  const selected = results.find((r) => r.ts === selectedTs) ?? results[0] ?? null;

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
          <h1 className="research-tab__reading-topic">{selected.topic}</h1>
          <time className="research-tab__reading-ts">{new Date(selected.ts).toLocaleString()}</time>
        </header>

        <Markdown text={selected.summary} className="research-tab__summary" />

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
