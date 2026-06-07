import React, { useRef } from 'react';

export type SessionView = 'focus' | 'research';

interface Props {
  /** Which view of the active session is showing. */
  view: SessionView;
  /** True when the Research tab has briefings the user hasn't opened yet → amber ready dot. */
  hasUnseenResearch: boolean;
  onSelect: (view: SessionView) => void;
}

/**
 * View switcher across the top of the main area: which VIEW of the active session you're
 * looking at — FOCUS (the live agent) or RESEARCH (the full-width reading surface). Distinct
 * from the left sidebar, which picks WHICH session.
 *
 * No module-index numbers here: these are views, not modules (FOCUS bundles modules
 * 01·Current Focus / 02·Workflow / 03·Touch Points; RESEARCH is 04). DESIGN.md's channel-strip
 * indices belong on the panel headers inside each view, not on the view tabs.
 *
 * Amber uses the shipped `--working` token, which forward-maps to the Instrument `--signal`
 * accent when that palette swap lands (see DESIGN.md) — same precedent as FollowControl.
 */
const TABS: { view: SessionView; label: string }[] = [
  { view: 'focus', label: 'Focus' },
  { view: 'research', label: 'Research' },
];

export function ViewTabs({ view, hasUnseenResearch, onSelect }: Props) {
  const refs = useRef<Record<SessionView, HTMLButtonElement | null>>({
    focus: null,
    research: null,
  });

  // Automatic-activation tablist: arrow / Home / End move focus AND select (WAI-ARIA
  // tabs pattern). Roving tabindex keeps a single tab stop.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const order = TABS.map((t) => t.view);
    const i = order.indexOf(view);
    let next: SessionView | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = order[(i + 1) % order.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = order[(i - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    if (next && next !== view) {
      e.preventDefault();
      onSelect(next);
      refs.current[next]?.focus();
    }
  };

  return (
    <div className="view-tabs" role="tablist" aria-label="Session view">
      {TABS.map((t) => {
        const active = t.view === view;
        return (
          <button
            key={t.view}
            ref={(el) => {
              refs.current[t.view] = el;
            }}
            type="button"
            role="tab"
            id={`view-tab-${t.view}`}
            aria-selected={active}
            aria-controls={`view-panel-${t.view}`}
            tabIndex={active ? 0 : -1}
            className={`view-tab${active ? ' view-tab--active' : ''}`}
            onClick={() => onSelect(t.view)}
            onKeyDown={onKeyDown}
          >
            <span className="view-tab__label">{t.label}</span>
            {t.view === 'research' && hasUnseenResearch && (
              <span className="view-tab__ready-dot" role="status" aria-label="new research ready" />
            )}
          </button>
        );
      })}
    </div>
  );
}
