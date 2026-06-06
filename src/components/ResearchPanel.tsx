import React, { useState } from 'react';
import type { ResearchResult, SuggestedTopic, Session } from '../types';
import { Markdown } from './Markdown';

interface Props {
  results: ResearchResult[];
  /** Topics auto-derived from the agent's work, shown as clickable chips. */
  suggestedTopics: SuggestedTopic[];
  /** Drives the empty/cold-start copy while topics are being derived. */
  activityStatus: Session['activityStatus'];
  /** The sessionId of the session currently being viewed. Sent with the research request so
   *  results land on the viewed session, not whichever session started last. */
  sessionId: string | null;
}

export function ResearchPanel({ results, suggestedTopics, activityStatus, sessionId }: Props) {
  // Topics with a research call in flight from THIS panel — keyed by topic string so a
  // chip stays disabled (and a double-click is a no-op) until its result lands via SSE.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const handleResearch = async (topic: string) => {
    if (pending.has(topic)) return; // double-click guard
    setPending((prev) => new Set(prev).add(topic));
    setError(null);

    try {
      const res = await fetch('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, sessionId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Success — the result arrives via the SSE research_result event, which removes
      // this chip from suggestedTopics. Leave it in `pending` so it can't be re-clicked
      // during the frame before the parent re-renders without it.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Re-enable the chip so the user can retry.
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(topic);
        return next;
      });
    }
  };

  return (
    <section className="panel research-panel">
      <h2 className="panel__title">Deep Research</h2>
      <p className="panel__subtitle">
        Topics from your session — tap one to read up while you wait.
      </p>

      {suggestedTopics.length > 0 && (
        <ul className="research-topics" aria-label="Suggested research topics">
          {suggestedTopics.map((t) => {
            const isPending = pending.has(t.topic);
            return (
              <li key={t.topic}>
                <button
                  type="button"
                  className="research-chip"
                  onClick={() => handleResearch(t.topic)}
                  disabled={isPending}
                  title={t.reason}
                >
                  <span className="research-chip__topic">{t.topic}</span>
                  {t.reason && <span className="research-chip__reason">{t.reason}</span>}
                  {isPending && <span className="spinner spinner--sm research-chip__spinner" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {suggestedTopics.length === 0 && <ResearchEmptyState activityStatus={activityStatus} />}

      {error && (
        <p className="research-panel__error" role="alert">
          ⚠ {error}
        </p>
      )}

      <div className="research-results" aria-live="polite" aria-label="Research results">
        {results.map((r) => (
          <ResearchCard key={r.ts} result={r} />
        ))}
      </div>
    </section>
  );
}

/**
 * Cold-start / empty copy for the chip area. The manual input box was removed, so this
 * is the only thing the user sees before topics arrive — it must be honest:
 *  - generating → topics are actively being derived (spinner)
 *  - ready      → a tick ran and produced nothing worth suggesting
 *  - idle/error → no provider yet, or summarization failed — no spinner (don't imply work)
 */
function ResearchEmptyState({ activityStatus }: { activityStatus: Session['activityStatus'] }) {
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
      : 'Research topics appear here as the agent works.';
  return (
    <div className="panel__empty">
      <span className="panel__empty-glyph">◱</span>
      <p>{message}</p>
    </div>
  );
}

function ResearchCard({ result }: { result: ResearchResult }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <article className="research-card">
      <button
        className="research-card__header"
        onClick={() => setExpanded((v) => !v)}
        type="button"
        aria-expanded={expanded}
      >
        <span className="research-card__topic">{result.topic}</span>
        <span className="research-card__toggle" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="research-card__body">
          <Markdown text={result.summary} className="research-card__summary" />
          {result.links.length > 0 && (
            <ul className="research-card__links">
              {result.links.map((link, i) => (
                <li key={i}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="research-card__link"
                  >
                    {link.title || link.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <time className="research-card__ts">{new Date(result.ts).toLocaleTimeString()}</time>
        </div>
      )}
    </article>
  );
}
