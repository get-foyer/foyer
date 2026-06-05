import React, { useState } from 'react';
import type { ResearchResult } from '../types';

interface Props {
  results: ResearchResult[];
}

export function ResearchPanel({ results }: Props) {
  const [topic, setTopic] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = topic.trim();
    if (!t || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: t }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      // Success — result arrives via SSE (research_result event) so we just clear
      setTopic('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel research-panel">
      <h2 className="panel__title">Deep Research</h2>
      <p className="panel__subtitle">Stay in flow — look something up while you wait.</p>

      <form className="research-form" onSubmit={handleSubmit}>
        <input
          className="research-form__input"
          type="text"
          placeholder="e.g. React useTransition hook, Mermaid graph syntax…"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={loading}
        />
        <button className="research-form__button" type="submit" disabled={!topic.trim() || loading}>
          {loading ? <span className="spinner spinner--sm" /> : 'Research'}
        </button>
      </form>

      {error && <p className="research-panel__error">⚠ {error}</p>}

      {results.length === 0 && !error && (
        <p className="panel__empty">Results will appear here.</p>
      )}

      <div className="research-results">
        {results.map((r) => (
          <ResearchCard key={r.ts} result={r} />
        ))}
      </div>
    </section>
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
      >
        <span className="research-card__topic">{result.topic}</span>
        <span className="research-card__toggle">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="research-card__body">
          <p className="research-card__summary">{result.summary}</p>
          {result.links.length > 0 && (
            <ul className="research-card__links">
              {result.links.map((link, i) => (
                <li key={i}>
                  <a href={link.url} target="_blank" rel="noreferrer noopener" className="research-card__link">
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
