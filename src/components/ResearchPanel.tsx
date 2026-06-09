import React from 'react';
import type { ResearchResult, SuggestedTopic, Session } from '../types';
import { ResearchChips } from './ResearchChips';

interface Props {
  results: ResearchResult[];
  /** Topics auto-derived from the agent's work, shown as clickable chips. */
  suggestedTopics: SuggestedTopic[];
  /** Drives the empty/cold-start copy while topics are being derived. */
  activityStatus: Session['activityStatus'];
  /** The sessionId of the session currently being viewed. Sent with the research request so
   *  results land on the viewed session, not whichever session started last. */
  sessionId: string | null;
  /** Topic keys (trim+lowercase) whose research is PRIMED — prefetched and ready server-side, so
   *  a tap returns instantly. Drives the amber "ready" dot on the chip. */
  primedTopics: string[];
  /** Topic keys (trim+lowercase) whose research is WARMING — a speculative prefetch is in flight.
   *  Drives the pulsing amber ring that settles into the primed dot when ready. */
  warmingTopics: string[];
  /** Open the full-width Research tab on the briefing with this timestamp. */
  onOpenResearch: (ts: number) => void;
}

/**
 * Deep Research LAUNCHER (right rail of the Focus view) — ONE unified list, no second section.
 * A topic moves through the list in place rather than relocating to a separate "Ready to read" block:
 *
 *   suggested chip ──(warm)──► warming ring ──► primed dot ──(tap/resolve)──► briefing row
 *                                                                              │
 *                                            ready to read (amber) ◄───────────┘
 *                                                   │ (open in Research tab)
 *                                                   ▼
 *                                            read (dimmed, no amber)
 *
 * Order (most actionable first): unread briefings → suggested topics → read briefings. The full
 * reading surface lives in `ResearchTab`; the rail stays a launcher + "what's ready" glance.
 * Amber appears only on warming / primed / unread-ready — never on a read row — so it stays a rare
 * "live/ready" signal (DESIGN.md).
 */
export function ResearchPanel({
  results,
  suggestedTopics,
  primedTopics,
  warmingTopics,
  activityStatus,
  sessionId,
  onOpenResearch,
}: Props) {
  // results arrive newest-first; the unread/read split preserves that order within each group.
  const unread = results.filter((r) => r.readAt == null);
  const read = results.filter((r) => r.readAt != null);
  const isEmpty = suggestedTopics.length === 0 && results.length === 0;

  const briefingRow = (r: ResearchResult, isRead: boolean) => (
    <li key={r.ts}>
      <button
        type="button"
        className={`research-ready-row${isRead ? ' research-ready-row--read' : ''}`}
        onClick={() => onOpenResearch(r.ts)}
        title={`Open briefing: ${r.topic}`}
        aria-label={`${r.topic} — ${isRead ? 'read' : 'ready to read'}`}
      >
        <span
          className={`research-ready-row__dot${isRead ? ' research-ready-row__dot--read' : ''}`}
          aria-hidden="true"
        />
        <span className="research-ready-row__topic">{r.topic}</span>
        <time className="research-ready-row__ts">{new Date(r.ts).toLocaleTimeString()}</time>
      </button>
    </li>
  );

  return (
    <section className="panel research-panel">
      <h2 className="panel__title">Deep Research</h2>

      <div className="research-panel__body">
        <p className="panel__subtitle">
          Briefings ready to read, and topics to dig into while you wait.
        </p>

        {isEmpty ? (
          <ResearchEmptyState activityStatus={activityStatus} />
        ) : (
          <ul className="research-list" aria-label="Research">
            {/* Most actionable first: a briefing that's already waiting for you. */}
            {unread.map((r) => briefingRow(r, false))}

            {/* Suggested-topic launcher (shared with the empty Research tab). Renders chip <li>s
                plus a trailing error <li> in place, so the one unified list is preserved. */}
            <ResearchChips
              suggestedTopics={suggestedTopics}
              sessionId={sessionId}
              primedTopics={primedTopics}
              warmingTopics={warmingTopics}
            />

            {/* Already read — dimmed, sunk to the bottom, no amber. */}
            {read.map((r) => briefingRow(r, true))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Cold-start / empty copy for the list. The manual input box was removed, so this is the only
 * thing the user sees before any topic or briefing exists — it must be honest:
 *  - generating → topics are actively being derived (spinner)
 *  - ready      → a tick ran and produced nothing worth suggesting
 *  - idle/error → no provider yet, or summarization failed — no spinner (don't imply work)
 * Only shown when there are no topics AND no briefings (a session with briefings always renders
 * the list, never this).
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
