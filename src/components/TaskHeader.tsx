import React, { useEffect, useState } from 'react';
import type { Session } from '../types';
import type { ConnectionStatus } from '../hooks/useSSE';

interface Props {
  session: Session | null;
  connectionStatus: ConnectionStatus;
  provider: string | null;
}

export function TaskHeader({ session, connectionStatus, provider }: Props) {
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
    // Intentionally depend on specific scalar values, not the session reference, to avoid
    // re-creating the interval when unrelated fields update (e.g. touchPoints, research).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, session?.startedAt, session?.finishedAt]);

  if (!session) {
    return (
      <header className="task-header task-header--idle">
        <div className="task-header__idle">
          <span className="task-header__icon">🚪</span>
          <span className="task-header__waiting">Waiting for an agent task…</span>
          <span className="task-header__hint">
            Start a Claude Code session and submit a prompt.
          </span>
        </div>
        <div className="task-header__meta">
          <ConnectionBadge status={connectionStatus} />
          {provider && <ProviderChip provider={provider} />}
        </div>
      </header>
    );
  }

  return (
    <header className={`task-header task-header--${session.status}`}>
      <div className="task-header__content">
        <div className="task-header__left">
          <StatusBadge status={session.status} reason={session.waitingReason} />
          <div className="task-header__text">
            <p className="task-header__prompt">{session.prompt}</p>
            {session.status === 'waiting' && session.waitingReason && (
              <p className="task-header__waiting-reason">{session.waitingReason}</p>
            )}
          </div>
        </div>
        <div className="task-header__right">
          {elapsed && <span className="task-header__duration">{elapsed}</span>}
          {session.prompts.length > 1 && (
            <span className="task-header__turn" title={session.prompts.join('\n')}>
              Turn {session.prompts.length}
            </span>
          )}
          <span className="task-header__session" title={session.sessionId}>
            {session.sessionId.slice(0, 8)}
          </span>
          <ConnectionBadge status={connectionStatus} />
          {provider && <ProviderChip provider={provider} />}
        </div>
      </div>
    </header>
  );
}

function StatusBadge({
  status,
  reason,
}: {
  status: 'working' | 'waiting' | 'done';
  reason?: string | null;
}) {
  return (
    <span
      className={`status-badge status-badge--${status}`}
      title={status === 'waiting' && reason ? reason : undefined}
    >
      {status === 'working' ? (
        <>
          <span className="status-badge__dot" aria-hidden="true" />
          Working
        </>
      ) : status === 'waiting' ? (
        <>
          <span className="status-badge__dot" aria-hidden="true" />
          Needs you
        </>
      ) : (
        <>✓ Done</>
      )}
    </span>
  );
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const labels: Record<ConnectionStatus, string> = {
    connecting: 'Connecting…',
    connected: 'Live',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
  };
  return (
    <span
      className={`conn-badge conn-badge--${status}`}
      role="status"
      aria-live="polite"
      aria-label={`Connection status: ${labels[status]}`}
    >
      <span className="conn-badge__dot" aria-hidden="true" />
      {labels[status]}
    </span>
  );
}

function ProviderChip({ provider }: { provider: string }) {
  return <span className="provider-chip">{provider}</span>;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
