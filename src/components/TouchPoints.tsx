import React, { useRef, useEffect } from 'react';
import type { TouchPoint } from '../types';

interface Props {
  touchPoints: TouchPoint[];
}

const TOOL_COLORS: Record<string, string> = {
  Write: 'tp-tool--write',
  Edit: 'tp-tool--edit',
  MultiEdit: 'tp-tool--edit',
  Bash: 'tp-tool--bash',
  Read: 'tp-tool--read',
};

export function TouchPoints({ touchPoints }: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  // Auto-scroll to the top (newest first) when new items arrive
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [touchPoints.length]);

  return (
    <section className="panel touch-panel">
      <h2 className="panel__title">
        Live Files
        {touchPoints.length > 0 && <span className="panel__count">{touchPoints.length}</span>}
      </h2>

      {touchPoints.length === 0 ? (
        <div className="panel__empty">
          <span className="panel__empty-glyph">◱</span>
          <p>No file activity yet.</p>
          <span className="panel__hint">File operations appear here as the agent works.</span>
        </div>
      ) : (
        <ul className="tp-list" ref={listRef}>
          {touchPoints.map((tp, i) => (
            <li key={`${tp.ts}-${tp.path}`} className={`tp-item ${i === 0 ? 'tp-item--new' : ''}`}>
              <span className={`tp-tool ${TOOL_COLORS[tp.tool] ?? 'tp-tool--other'}`}>
                {tp.tool}
              </span>
              <span className="tp-path" title={tp.path}>
                {shortenPath(tp.path)}
              </span>
              <span className="tp-ts">{formatTime(tp.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function shortenPath(p: string): string {
  // Show last 3 segments for readability
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-3).join('/');
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
