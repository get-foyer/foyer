import React from 'react';
import type { Session } from '../types';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  unseenSessionIds: string[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function SessionTabs({
  sessions,
  activeSessionId,
  unseenSessionIds,
  onSelect,
  onClose,
}: Props) {
  return (
    <nav className="app__sidebar" aria-label="Agent sessions">
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
