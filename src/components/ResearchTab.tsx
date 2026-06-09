import React, { useEffect, useMemo, useState } from 'react';
import type { ResearchResult, SuggestedTopic, Session } from '../types';
import { Markdown } from './Markdown';
import { MermaidFigure } from './MermaidFigure';
import { ResearchChips } from './ResearchChips';
import { sectionAnchors, estimateReadMinutes, serializeToMarkdown } from '../lib/research';

interface Props {
  /** This session's briefings, newest-first (binds directly to `session.research`). */
  results: ResearchResult[];
  /** The briefing currently shown in the reading pane (controlled by App). */
  selectedTs: number | null;
  onSelect: (ts: number) => void;
  /** Empty-state launcher inputs — surfaced when the tab has no briefings yet so the action
   *  (start a briefing) lives on screen, not off in the hidden Focus-view rail. */
  suggestedTopics: SuggestedTopic[];
  /** Drives the empty/cold-start copy while topics are being derived. */
  activityStatus: Session['activityStatus'];
  /** The viewed session's id — sent with a research request from the empty-state chips. */
  sessionId: string | null;
  /** Topic keys (trim+lowercase) whose research is PRIMED → amber "ready" dot on the chip. */
  primedTopics: string[];
  /** Topic keys (trim+lowercase) whose research is WARMING → pulsing amber ring on the chip. */
  warmingTopics: string[];
}

/**
 * The `04 · RESEARCH` view — a full-width reading surface for a session's briefings. Left: a
 * topic index (newest-first). Right: the selected briefing rendered as a document — a TL;DR lede,
 * an in-doc section index (when there's more than one section), sectioned prose with tables and
 * a diagram where the model judged one warranted, read-time, and copy. Selection is controlled by
 * App so it survives Focus⇄Research toggles.
 */
export function ResearchTab({
  results,
  selectedTs,
  onSelect,
  suggestedTopics,
  activityStatus,
  sessionId,
  primedTopics,
  warmingTopics,
}: Props) {
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

  // No briefings yet → a first-class, status-aware empty state. The Research tab is now always
  // available (App.tsx gates it on session existence, not briefing count), so this is a real
  // surface a user lands on — not a defensive fallback. It must give the user an action from
  // where they stand: the Focus-view Deep Research rail isn't rendered here, so surface the same
  // launcher inline rather than pointing at off-screen UI. Mirrors ResearchPanel's empty-state
  // honesty (generating / idle / no-provider); copy is tab-local by design.
  if (!selected) {
    return (
      <div
        className="research-tab research-tab--empty"
        role="tabpanel"
        id="view-panel-research"
        aria-labelledby="view-tab-research"
      >
        <ResearchTabEmpty
          suggestedTopics={suggestedTopics}
          activityStatus={activityStatus}
          sessionId={sessionId}
          primedTopics={primedTopics}
          warmingTopics={warmingTopics}
        />
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

/**
 * Empty Research tab — shown when the session has no briefings yet. Status-aware, mirroring
 * ResearchPanel's ResearchEmptyState honesty, but with one critical difference: when topics exist
 * it surfaces the launcher chips inline so the user can start a briefing from HERE. The Focus-view
 * Deep Research rail isn't rendered in this view, so a "tap a topic over there" pointer would be a
 * dead end. Order: topics → chips (the actionable state); otherwise an honest status message.
 * Copy is tab-local by design (decision D-copy) — the no-provider story is owned by App's banner.
 */
function ResearchTabEmpty({
  suggestedTopics,
  activityStatus,
  sessionId,
  primedTopics,
  warmingTopics,
}: {
  suggestedTopics: SuggestedTopic[];
  activityStatus: Session['activityStatus'];
  sessionId: string | null;
  primedTopics: string[];
  warmingTopics: string[];
}) {
  // Topics present → the launcher is the empty state. Start a briefing without leaving the tab.
  if (suggestedTopics.length > 0) {
    return (
      <div className="research-tab__empty">
        <span className="panel__empty-glyph" aria-hidden="true">
          ◱
        </span>
        <p className="research-tab__empty-msg">No briefings yet — start one below.</p>
        <ul className="research-list" aria-label="Suggested research topics">
          <ResearchChips
            suggestedTopics={suggestedTopics}
            sessionId={sessionId}
            primedTopics={primedTopics}
            warmingTopics={warmingTopics}
          />
        </ul>
      </div>
    );
  }

  // No topics yet → an honest status message (no chips to offer).
  if (activityStatus === 'generating') {
    return (
      <div className="panel__empty" aria-live="polite">
        <span className="spinner spinner--sm" />
        <p>Surfacing topics from your session…</p>
      </div>
    );
  }
  const message =
    activityStatus === 'ready'
      ? 'No research topics yet — they’ll appear as the agent works.'
      : 'Research briefings will open here as you dig into topics.';
  return (
    <div className="panel__empty">
      <span className="panel__empty-glyph">◱</span>
      <p>{message}</p>
    </div>
  );
}
