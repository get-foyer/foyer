import React from 'react';
import type { Session } from '../types';
import { JumpToLive } from './JumpToLive';
import { SessionMenu } from './SessionMenu';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  /** Server's most-recently-prompted session — drives the FOLLOW catch-up affordance. */
  liveSessionId: string | null;
  /** Whether the view auto-tracks live prompts ('follow') or is pinned to a tab ('held'). */
  followMode: 'follow' | 'held';
  unseenSessionIds: string[];
  /** Resume following + jump to the live session. */
  onFollow: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Pin a session to the top of the sidebar / remove the pin (server-persisted). */
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
}

/** Monochrome pushpin marker for a pinned row (NOT an emoji — see DESIGN.md). The SVG is
 *  aria-hidden; an adjacent visually-hidden label carries the meaning for screen readers, so
 *  pinned-ness is never conveyed by the glyph/colour alone. */
function PinGlyph() {
  return (
    <span className="session-tab__pin-glyph">
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M16 9V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"
        />
      </svg>
      <span className="visually-hidden">Pinned</span>
    </span>
  );
}

export function SessionTabs({
  sessions,
  activeSessionId,
  liveSessionId,
  followMode,
  unseenSessionIds,
  onFollow,
  onSelect,
  onClose,
  onPin,
  onUnpin,
}: Props) {
  // Held AND a different (visible) session is live → there's a channel to catch up to.
  // (Following is the silent default — no control. The pill is the only re-engage affordance.)
  const liveSession =
    followMode === 'held' && liveSessionId !== null && liveSessionId !== activeSessionId
      ? (sessions.find((s) => s.sessionId === liveSessionId) ?? null)
      : null;

  // `sessions` arrives pinned-first (server getAllSessions + the client pin/unpin reducer both
  // run sortPinnedFirst). The pinned/unpinned boundary is the first unpinned row; show a register
  // divider there only when both groups are non-empty (firstUnpinnedIdx > 0).
  const firstUnpinnedIdx = sessions.findIndex((s) => s.pinnedAt == null);

  return (
    <nav className="app__sidebar" aria-label="Agent sessions">
      {/* Persistent aria-live region (zero footprint when empty) so the pill is announced
          when it appears; the pill itself renders only when there's somewhere to jump. */}
      <div className="jump-to-live-region" aria-live="polite">
        {liveSession && (
          <JumpToLive liveLabel={liveSession.prompt || 'A session'} onFollow={onFollow} />
        )}
      </div>
      {sessions.length === 0 ? (
        <p className="app__sidebar-empty">No sessions yet</p>
      ) : (
        sessions.map((session, idx) => {
          const isActive = session.sessionId === activeSessionId;
          const isUnseen = unseenSessionIds.includes(session.sessionId);
          const isPinned = session.pinnedAt != null;
          const shortId = session.sessionId.slice(0, 8);
          const showDivider = idx === firstUnpinnedIdx && firstUnpinnedIdx > 0;

          return (
            <React.Fragment key={session.sessionId}>
              {showDivider && <div className="session-tab__pin-divider" role="separator" />}
              <div className="session-tab-row">
                {/* Tab select button — the main clickable area */}
                <button
                  type="button"
                  className={`session-tab${isActive ? ' session-tab--active' : ''}`}
                  aria-current={isActive ? 'true' : undefined}
                  title={session.prompt}
                  onClick={() => onSelect(session.sessionId)}
                >
                  {/* Pinned marker — leading, before the status dot */}
                  {isPinned && <PinGlyph />}

                  {/* Status dot */}
                  {session.status === 'working' ? (
                    <span
                      className="session-tab__dot session-tab__dot--working"
                      aria-hidden="true"
                    />
                  ) : session.status === 'waiting' ? (
                    <span
                      className="session-tab__dot session-tab__dot--waiting"
                      aria-label="needs your input"
                      role="status"
                    />
                  ) : session.status === 'interrupted' ? (
                    <span
                      className="session-tab__dot session-tab__dot--interrupted"
                      aria-label="interrupted by a restart"
                      role="status"
                    >
                      ⚠
                    </span>
                  ) : (
                    <span className="session-tab__dot session-tab__dot--done" aria-hidden="true">
                      ✓
                    </span>
                  )}

                  <span className="session-tab__body">
                    <span className="session-tab__prompt">{session.prompt}</span>
                    <span className="session-tab__id">{shortId}</span>
                  </span>

                  {/* Unseen indicator */}
                  {isUnseen && (
                    <span className="session-tab__unseen" aria-label="new activity" role="status" />
                  )}
                </button>

                {/* Options (⋯) menu — pin/unpin. Sits next to the close button. */}
                <SessionMenu
                  pinned={isPinned}
                  shortId={shortId}
                  onPin={() => onPin(session.sessionId)}
                  onUnpin={() => onUnpin(session.sessionId)}
                />

                {/* Close button — separate sibling (not nested) to avoid invalid HTML */}
                <button
                  type="button"
                  className="session-tab__close"
                  aria-label={`Close session ${shortId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(session.sessionId);
                  }}
                >
                  ×
                </button>
              </div>
            </React.Fragment>
          );
        })
      )}
    </nav>
  );
}
