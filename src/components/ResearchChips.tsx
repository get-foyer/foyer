import React, { useState } from 'react';
import type { SuggestedTopic } from '../types';

interface Props {
  /** Topics auto-derived from the agent's work, shown as clickable chips. */
  suggestedTopics: SuggestedTopic[];
  /** The sessionId the research request lands on. */
  sessionId: string | null;
  /** Topic keys (trim+lowercase) whose research is PRIMED — prefetched + ready server-side, so a
   *  tap returns instantly. Drives the amber "ready" dot. */
  primedTopics: string[];
  /** Topic keys (trim+lowercase) whose research is WARMING — a speculative prefetch is in flight.
   *  Drives the pulsing hollow amber ring that fills into the primed dot when ready. */
  warmingTopics: string[];
}

/**
 * The suggested-topic LAUNCHER — one clickable chip per topic the agent surfaced. Tapping a chip
 * POSTs /research; the result arrives over SSE and the parent drops the topic from `suggestedTopics`.
 *
 * Renders a FRAGMENT of `<li>` items (no wrapping `<ul>`) so callers can place the chips inside
 * their own list: the Focus-rail ResearchPanel interleaves them in one unified list (unread
 * briefings → chips → read), and the empty Research tab wraps them in a standalone `.research-list`.
 * The trailing error `<li>` surfaces a failed request right beside the chips.
 *
 * Amber appears only on the primed dot / warming ring (already-shipped "ready/live" signals); the
 * chip's blue `--accent` hover stays the "interactive" cue, so amber stays pure signal (DESIGN.md).
 */
export function ResearchChips({ suggestedTopics, sessionId, primedTopics, warmingTopics }: Props) {
  const primed = new Set(primedTopics);
  const warming = new Set(warmingTopics);
  // Topics with a research call in flight from THIS launcher — keyed by topic string so a chip
  // stays disabled (and a double-click is a no-op) until its result lands via SSE.
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
      // Success — the result arrives via the SSE research_result event, which removes this chip
      // from suggestedTopics. Leave it in `pending` so it can't be re-clicked during the frame
      // before the parent re-renders without it.
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
    <>
      {suggestedTopics.map((t) => {
        const isPending = pending.has(t.topic);
        const key = t.topic.trim().toLowerCase();
        // Primed = research already warmed in the background → this tap is instant.
        const isPrimed = !isPending && primed.has(key);
        // Warming = a speculative prefetch is in flight right now (settles into primed).
        const isWarming = !isPending && !isPrimed && warming.has(key);
        const status = isPrimed ? 'ready' : isWarming ? 'warming' : null;
        return (
          <li key={t.topic}>
            <button
              type="button"
              className="research-chip"
              onClick={() => handleResearch(t.topic)}
              disabled={isPending}
              title={status ? `${t.reason} · ${status}` : t.reason}
              aria-label={status ? `${t.topic} — ${status}` : undefined}
            >
              <span className="research-chip__topic">{t.topic}</span>
              {t.reason && <span className="research-chip__reason">{t.reason}</span>}
              {isPrimed && (
                <span
                  className="research-chip__primed"
                  aria-hidden="true"
                  title="Ready — tap is instant"
                />
              )}
              {isWarming && (
                <span
                  className="research-chip__warming"
                  aria-hidden="true"
                  title="Warming — prefetching in the background"
                />
              )}
              {isPending && <span className="spinner spinner--sm research-chip__spinner" />}
            </button>
          </li>
        );
      })}
      {error && (
        <li className="research-list__error" role="alert">
          ⚠ {error}
        </li>
      )}
    </>
  );
}
