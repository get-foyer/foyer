import React from 'react';
import type { Session } from '../types';
import { JumpToLive } from './JumpToLive';

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
}: Props) {
  // Held AND a different (visible) session is live → there's a channel to catch up to.
  // (Following is the silent default — no control. The pill is the only re-engage affordance.)
  const liveSession =
    followMode === 'held' && liveSessionId !== null && liveSessionId !== activeSessionId
      ? (sessions.find((s) => s.sessionId === liveSessionId) ?? null)
      : null;

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
        sessions.map((session) => {
          const isActive = session.sessionId === activeSessionId;
          const isUnseen = unseenSessionIds.includes(session.sessionId);
          const shortId = session.sessionId.slice(0, 8);

          return (
            <div key={session.sessionId} className="session-tab-row">
              {/* Tab select button — the main clickable area */}
              <button
                type="button"
                className={`session-tab${isActive ? ' session-tab--active' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                title={session.prompt}
                onClick={() => onSelect(session.sessionId)}
              >
                {/* Status dot */}
                {session.status === 'working' ? (
                  <span className="session-tab__dot session-tab__dot--working" aria-hidden="true" />
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
          );
        })
      )}
    </nav>
  );
}
