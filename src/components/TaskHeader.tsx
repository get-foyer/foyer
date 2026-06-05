import React, { useEffect, useState } from 'react';
import type { Session } from '../types';

interface Props {
  session: Session | null;
}

export function TaskHeader({ session }: Props) {
  const [elapsed, setElapsed] = useState<string>('');

  useEffect(() => {
    if (!session || session.status === 'done') {
      if (session?.finishedAt && session.startedAt) {
        const total = session.finishedAt - session.startedAt;
        setElapsed(formatDuration(total));
      }
      return;
    }

    // Tick while working
    const tick = () => setElapsed(formatDuration(Date.now() - session.startedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [session?.status, session?.startedAt, session?.finishedAt]);

  if (!session) {
    return (
      <header className="task-header task-header--idle">
        <div className="task-header__idle">
          <span className="task-header__icon">🚪</span>
          <span className="task-header__waiting">Waiting for an agent task…</span>
          <span className="task-header__hint">Start a Claude Code session and submit a prompt.</span>
        </div>
      </header>
    );
  }

  return (
    <header className={`task-header task-header--${session.status}`}>
      <div className="task-header__content">
        <div className="task-header__left">
          <StatusBadge status={session.status} />
          <p className="task-header__prompt">{session.prompt}</p>
        </div>
        <div className="task-header__right">
          {elapsed && <span className="task-header__duration">{elapsed}</span>}
          <span className="task-header__session" title={session.sessionId}>
            {session.sessionId.slice(0, 8)}
          </span>
        </div>
      </div>
    </header>
  );
}

function StatusBadge({ status }: { status: 'working' | 'done' }) {
  return (
    <span className={`status-badge status-badge--${status}`}>
      {status === 'working' ? (
        <>
          <span className="status-badge__dot" />
          Working
        </>
      ) : (
        <>✓ Done</>
      )}
    </span>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
