import React, { useState } from 'react';
import { Markdown } from './Markdown';
import { WorkflowGraph } from './WorkflowGraph';
import type { Session, FocusEntry } from '../types';

interface Props {
  summary: string | null;
  /** Retained focus snapshots, newest-first. `focusHistory[0]` is the current focus; the rest
   *  populate the collapsible "Previously" timeline. */
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
 * Groups consecutive newest-first entries by their turn, preserving order:
 *
 *   [t3,t3,t2,t1]  ──►  [{turnSeq:3,[t3,t3]}, {turnSeq:2,[t2]}, {turnSeq:1,[t1]}]
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

/** First non-empty line of a markdown summary, lightly de-marked, for the collapsed preview. */
function firstLine(md: string): string {
  const line = md.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.replace(/^[#>\-*\s]+/, '').trim();
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
  // Prefer the latest retained entry; fall back to the raw `summary` (e.g. before the first
  // entry is appended, or a no-append refresh that still updated the live text).
  const current = focusHistory[0]?.summary ?? summary;
  const previously = focusHistory.slice(1);

  return (
    <section className="panel summary-panel">
      <h2 className="panel__title">
        Current Focus
        {status === 'generating' && current !== null && (
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

      {current !== null ? (
        <div className="summary-panel__content">
          <Markdown text={current} className="summary-panel__text" />
        </div>
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

      {previously.length > 0 && <FocusHistory entries={previously} />}
    </section>
  );
}

/** Collapsible "Previously" timeline of older focus snapshots, grouped by turn. */
function FocusHistory({ entries }: { entries: FocusEntry[] }) {
  const [open, setOpen] = useState(false);
  const groups = groupByTurn(entries);

  return (
    <div className="summary-panel__history">
      <button
        className="summary-panel__history-toggle"
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
      >
        <span>Previously</span>
        <span className="summary-panel__history-count">{entries.length}</span>
        <span className="summary-panel__history-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="focus-timeline" aria-label="Earlier focus history">
          {groups.map((g) => (
            <div className="focus-group" key={g.turnSeq}>
              <div className="focus-group__divider">
                <span className="focus-group__turn">Turn {g.turnSeq}</span>
                <span className="focus-group__prompt" title={g.turnPrompt}>
                  {g.turnPrompt}
                </span>
              </div>
              {g.items.map((entry) => (
                <FocusCard key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FocusCard({ entry }: { entry: FocusEntry }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(entry.ts);

  return (
    <article className="focus-card">
      <button
        className="focus-card__header"
        onClick={() => setExpanded((v) => !v)}
        type="button"
        aria-expanded={expanded}
      >
        <time className="focus-card__ts" dateTime={ts.toISOString()}>
          {ts.toLocaleTimeString()}
        </time>
        {!expanded && <span className="focus-card__preview">{firstLine(entry.summary)}</span>}
        <span className="focus-card__toggle" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="focus-card__body">
          <Markdown text={entry.summary} className="focus-card__summary" />
        </div>
      )}
    </article>
  );
}
