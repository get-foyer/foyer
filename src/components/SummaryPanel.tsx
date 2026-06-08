import React, { useLayoutEffect, useRef } from 'react';
import { Markdown } from './Markdown';
import { WorkflowGraph } from './WorkflowGraph';
import type { Session, FocusEntry } from '../types';

interface Props {
  summary: string | null;
  /** Retained focus snapshots, newest-first. Rendered as a chronological transcript
   *  (oldest at the top, newest pinned at the bottom) in the Current Focus feed. */
  focusHistory: FocusEntry[];
  status: Session['activityStatus'];
  error: string | null;
  /** Lifecycle status of the session — drives the "thinking" state before the first summary arrives. */
  sessionStatus: Session['status'] | null;
  /** The mermaid `graph LR` storyline to fold in above the narration. Null until one is drawn. */
  graph: string | null;
  /** Whether a workflow graph should be shown this turn (hybrid trigger + sticky, decided
   *  server-side via isWorkflowVisible). When false, no workflow region is rendered at all. */
  showWorkflow: boolean;
}

/**
 * Groups entries by their turn, preserving order. Fed the chronological (oldest-first)
 * list, it returns turn groups oldest-first with items oldest-first:
 *
 *   [t1,t1,t2,t3]  ──►  [{turnSeq:1,[t1,t1]}, {turnSeq:2,[t2]}, {turnSeq:3,[t3]}]
 *
 * `turnSeq` is monotonic and stamped at capture, so grouping survives `prompts` pruning.
 */
function groupByTurn(
  entries: FocusEntry[],
): { turnSeq: number; turnPrompt: string; items: FocusEntry[] }[] {
  const groups: { turnSeq: number; turnPrompt: string; items: FocusEntry[] }[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.turnSeq === e.turnSeq) last.items.push(e);
    else groups.push({ turnSeq: e.turnSeq, turnPrompt: e.turnPrompt, items: [e] });
  }
  return groups;
}

export function SummaryPanel({
  summary,
  focusHistory,
  status,
  error,
  sessionStatus,
  graph,
  showWorkflow,
}: Props) {
  // Content exists once the agent has narrated at least once (a retained entry) or a live
  // summary arrived before the first entry was appended (no-append refresh / pre-append tick).
  const hasContent = focusHistory.length > 0 || summary !== null;

  return (
    <section className="panel summary-panel">
      <h2 className="panel__title">
        Current Focus
        {status === 'generating' && hasContent && (
          <span className="panel__badge panel__badge--generating">Updating…</span>
        )}
      </h2>

      {/* Workflow storyline, folded in above the narration — shown ONLY when this turn warrants
          it (multi-phase work or plan mode). A trivial task renders no workflow region at all.
          `graph` may briefly be null while a warranted graph is still being drawn (e.g. right
          after plan mode), so we show a one-line "Sketching…" hint rather than empty chrome. */}
      {showWorkflow && (
        <div className="summary-panel__workflow">
          <span className="summary-panel__workflow-label">Workflow</span>
          {graph ? (
            <WorkflowGraph graph={graph} />
          ) : (
            <div className="summary-panel__workflow-sketching">
              <span className="spinner spinner--sm" />
              <span>Sketching workflow…</span>
            </div>
          )}
        </div>
      )}

      {hasContent ? (
        <FocusFeed
          focusHistory={focusHistory}
          summary={summary}
          working={sessionStatus === 'working'}
        />
      ) : status === 'generating' ? (
        <div className="summary-panel__generating">
          <span className="spinner" />
          <span>Summarising agent activity…</span>
        </div>
      ) : status === 'error' ? (
        <div className="summary-panel__error">
          <span className="summary-panel__error-glyph">⚠</span>
          <p className="summary-panel__error-msg">{error ?? 'Activity summary failed.'}</p>
        </div>
      ) : sessionStatus === 'working' ? (
        // Agent is working but no summary yet — show an animated thinking state
        // instead of the static "waiting" empty card so the panel looks alive.
        <div className="summary-panel__generating">
          <span className="spinner" />
          <span>Agent is thinking… summary incoming</span>
        </div>
      ) : (
        <div className="panel__empty">
          <span className="panel__empty-glyph">◱</span>
          <p>Waiting for the agent&apos;s first action…</p>
        </div>
      )}
    </section>
  );
}

/**
 * The continuous focus transcript: every retained snapshot for this session, oldest at the
 * top and newest pinned at the bottom (chat / terminal-log expectation). The feed sticks to
 * the bottom as new entries arrive, unless the user has scrolled up to read history — so an
 * incoming summary never yanks them off what they're reading. Turn dividers appear once the
 * history spans more than one turn.
 */
function FocusFeed({
  focusHistory,
  summary,
  working,
}: {
  focusHistory: FocusEntry[];
  summary: string | null;
  working: boolean;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  // Whether the feed is "stuck" to the bottom (follow-along). Starts true so the newest is in
  // view on mount; flips to false when the user scrolls up, true again when they return.
  const stickRef = useRef(true);

  const newestId = focusHistory[0]?.id ?? null;

  useLayoutEffect(() => {
    const el = feedRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [newestId, focusHistory.length, summary]);

  const handleScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // Before the first retained entry (or a no-append refresh that only moved the live text),
  // there is a summary but no FocusEntry to stamp — render it on its own, no timeline chrome.
  if (focusHistory.length === 0) {
    return (
      <div className="summary-panel__content" ref={feedRef}>
        <Markdown text={summary ?? ''} className="summary-panel__text" />
      </div>
    );
  }

  // Stored newest-first; reverse to read top-to-bottom as a chronological transcript.
  const groups = groupByTurn([...focusHistory].reverse());
  const showDividers = groups.length > 1;

  return (
    <div
      className="summary-panel__content focus-feed"
      ref={feedRef}
      onScroll={handleScroll}
      aria-label="Focus timeline"
    >
      {groups.map((g) => (
        <div className="focus-group" key={g.turnSeq}>
          {showDividers && (
            <div className="focus-group__divider">
              <span className="focus-group__turn">Turn {g.turnSeq}</span>
              <span className="focus-group__prompt" title={g.turnPrompt}>
                {g.turnPrompt}
              </span>
            </div>
          )}
          {g.items.map((entry) => {
            const live = working && entry.id === newestId;
            const ts = new Date(entry.ts);
            return (
              <article
                className={live ? 'focus-entry focus-entry--live' : 'focus-entry'}
                key={entry.id}
              >
                <div className="focus-entry__meta">
                  <time className="focus-entry__ts" dateTime={ts.toISOString()}>
                    {ts.toLocaleTimeString()}
                  </time>
                  {live && <span className="focus-entry__live">LIVE</span>}
                </div>
                {/* On a no-append refresh, `summary` moves but no new entry is stamped — show the
                    fresher live text on the live row so it never goes stale (the prop is always >=
                    focusHistory[0] in freshness). Older rows always render their stored text. */}
                <Markdown
                  text={live ? (summary ?? entry.summary) : entry.summary}
                  className="focus-entry__summary"
                />
              </article>
            );
          })}
        </div>
      ))}
    </div>
  );
}
