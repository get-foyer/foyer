import React, { useEffect, useRef, useState } from 'react';
import type { PrimaryBriefing, ResearchResult, DocRef } from '../types';
import { topicKey } from '../types';

interface Props {
  /** The session's primary designation, or null when there's no confident pick. */
  primary: PrimaryBriefing | null | undefined;
  /** The session's briefings — the primary's body is found here by topicKey (one source of truth). */
  results: ResearchResult[];
  /** Extractive fallback inputs (shown when there's no primary yet): touched areas + matched docs. */
  touchedAreas: string[];
  contextDocs: DocRef[];
  /** Open the primary's briefing in the Research tab (reuses the shipped flow → readAt → read). */
  onOpenBriefing: (ts: number) => void;
  /** Commit a dismissal after the undo window lapses. */
  onDismiss: () => void;
  /** Retry a failed warm (error → warming). */
  onRetry: () => void;
}

/** How long the inline "dismissed · UNDO" window stays open before the dismissal commits (DR8). */
const UNDO_MS = 5000;

/**
 * PRIMARY BRIEFING strip — the one recommended read, as the integrated TOP BAND of the
 * 02 · DEEP RESEARCH module (design review DR4: a readout strip with a left status rail, NOT a
 * nested card). It is the marquee of the Live Learning Briefing.
 *
 * States (the PrimaryStatus machine + an extractive pre-primary readout + a client-only
 * dismiss-undo window):
 *
 *   (no primary, has signals) → EXTRACTIVE   WATCHING <dirs> / MATCHED <docs>, no LED, no rail
 *   warming                   → amber rail + pulsing hollow LED, reason, cites, "warming · mm:ss"
 *   ready                     → amber rail + solid glowing LED, reason, lede, cites, OPEN BRIEFING
 *   read                      → dim rail + hollow dim LED, dim reason+lede, REOPEN
 *   error                     → red rail + red LED, reason, error line, RETRY, "failed ×N"
 *   (dismissing)              → reason, "dismissed · UNDO" in the readout slot for 5s
 *
 * Amber budget (DR13): the strip owns the module's only glow source (the ready LED) plus the
 * sanctioned amber keycap. Every LED is paired with its state word in the kicker (never colour
 * alone). Citations are plain readout text, never controls (DR14). Reduced-motion gates the
 * pulse + the live tick (DR15).
 */
export function PrimaryBriefingStrip({
  primary,
  results,
  touchedAreas,
  contextDocs,
  onOpenBriefing,
  onDismiss,
  onRetry,
}: Props) {
  const [dismissing, setDismissing] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel a pending dismiss if the designation changes underneath us (server superseded it, or
  // the component unmounts). The undo window is purely local — the POST fires only on lapse.
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);
  const primaryTopicKey = primary ? topicKey(primary.topic) : null;
  useEffect(() => {
    // A new/changed designation invalidates an in-progress undo window.
    if (dismissing) {
      setDismissing(false);
      if (undoTimer.current) clearTimeout(undoTimer.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryTopicKey]);

  const beginDismiss = () => {
    setDismissing(true);
    undoTimer.current = setTimeout(() => {
      setDismissing(false);
      onDismiss();
    }, UNDO_MS);
  };
  const undo = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setDismissing(false);
  };

  // No primary → the extractive readout (true local data, no LLM, no LED). Renders only when
  // there's something real to show (DR9 boundary: touched ≥ 1 OR matched ≥ 1); otherwise nothing.
  if (!primary) {
    if (touchedAreas.length === 0 && contextDocs.length === 0) return null;
    return (
      <div className="primary-strip primary-strip--extractive">
        <p className="primary-strip__watch">
          {touchedAreas.length > 0 && (
            <span className="primary-strip__watch-row">
              <span className="primary-strip__watch-k">watching</span>
              {touchedAreas.slice(0, 3).join(' · ')}
            </span>
          )}
          {contextDocs.length > 0 && (
            <span className="primary-strip__watch-row">
              <span className="primary-strip__watch-k">matched</span>
              {contextDocs
                .slice(0, 3)
                .map((d) => d.title || d.path)
                .join(' · ')}
            </span>
          )}
        </p>
      </div>
    );
  }

  const matched = primaryTopicKey
    ? results.find((r) => topicKey(r.topic) === primaryTopicKey)
    : undefined;
  const status = primary.status;
  const railClass =
    status === 'error'
      ? 'primary-strip--rail-error'
      : status === 'read'
        ? 'primary-strip--rail-dim'
        : 'primary-strip--rail';

  // State word always accompanies the LED (DR13 — never colour alone).
  const stateWord =
    status === 'warming'
      ? 'Warming'
      : status === 'ready'
        ? 'Ready'
        : status === 'read'
          ? 'Read'
          : 'Failed';

  return (
    <section className={`primary-strip ${railClass}`} aria-label="Primary briefing">
      <div className="primary-strip__kicker">
        <LedFor status={status} />
        <span className="primary-strip__label">Primary Briefing · {stateWord}</span>
      </div>

      {/* Reason is ALWAYS the LLM's specific why-now (DR12 — no static subtitle). */}
      <p
        className={`primary-strip__reason${status === 'read' ? ' primary-strip__reason--dim' : ''}`}
        title={primary.reason}
      >
        {primary.reason}
      </p>

      {/* Body lede only once there's a briefing (ready/read). Warming/error have no body yet. */}
      {matched && (status === 'ready' || status === 'read') && matched.lede && (
        <p className={`primary-strip__lede${status === 'read' ? ' primary-strip__lede--dim' : ''}`}>
          {matched.lede}
        </p>
      )}

      {status === 'error' && (
        <p className="primary-strip__error">briefing failed · provider error</p>
      )}

      {/* Cited docs — plain readout text, never controls (DR14). */}
      {primary.docs && primary.docs.length > 0 && status !== 'error' && (
        <p className="primary-strip__cites">{primary.docs.map((d) => d.path).join(' · ')}</p>
      )}

      <div className="primary-strip__foot">
        {status === 'ready' && matched && (
          <button
            type="button"
            className="primary-strip__keycap"
            onClick={() => onOpenBriefing(matched.ts)}
          >
            OPEN BRIEFING
          </button>
        )}
        {status === 'read' && matched && (
          <button
            type="button"
            className="primary-strip__keycap primary-strip__keycap--ghost"
            onClick={() => onOpenBriefing(matched.ts)}
          >
            REOPEN
          </button>
        )}
        {status === 'error' && (
          <button
            type="button"
            className="primary-strip__keycap primary-strip__keycap--ghost"
            onClick={onRetry}
          >
            RETRY
          </button>
        )}

        {/* Dismiss is a recessive action-row control (DR8), never the keycap's tier; never on a
            read primary (the next pick demotes it). */}
        {status !== 'read' &&
          (dismissing ? (
            <span className="primary-strip__readout primary-strip__readout--undo" role="status">
              dismissed ·{' '}
              <button type="button" onClick={undo}>
                UNDO
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="primary-strip__dismiss"
              onClick={beginDismiss}
              aria-label={`Dismiss primary briefing: ${primary.topic} — not useful`}
            >
              Not Useful
            </button>
          ))}

        {!dismissing && <PrimaryReadout primary={primary} />}
      </div>
    </section>
  );
}

/** The status LED. Shape carries meaning beyond colour (DR13/DR15): solid glow = ready (the
 *  module's only glow), hollow pulsing = warming, hollow dim = read, solid red = error. */
function LedFor({ status }: { status: PrimaryBriefing['status'] }) {
  const cls =
    status === 'ready'
      ? 'primary-strip__led primary-strip__led--ready'
      : status === 'warming'
        ? 'primary-strip__led primary-strip__led--warming'
        : status === 'read'
          ? 'primary-strip__led primary-strip__led--read'
          : 'primary-strip__led primary-strip__led--error';
  return <span className={cls} aria-hidden="true" />;
}

/**
 * The right-aligned tabular readout — per-state time semantics (DR11):
 *   warming → live elapsed since warm start (mm:ss; reduced-motion stops the tick)
 *   ready   → frozen time-to-ready (the D17 metric, surfaced)
 *   read    → no time readout (the row demotes soon — subtraction default)
 *   error   → failure count
 */
function PrimaryReadout({ primary }: { primary: PrimaryBriefing }) {
  const { status, since, readyMs, failures } = primary;
  const elapsed = useLiveElapsed(status === 'warming' ? since : null);

  if (status === 'warming') {
    return <span className="primary-strip__readout">warming · {fmt(elapsed)}</span>;
  }
  if (status === 'ready' && readyMs != null) {
    return <span className="primary-strip__readout">ready · {fmt(readyMs)}</span>;
  }
  if (status === 'error') {
    return <span className="primary-strip__readout">failed ×{failures ?? 1}</span>;
  }
  return null;
}

/** mm:ss from a ms duration (tabular). */
function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Live elapsed-since-`start` in ms, ticking every second. Gated under prefers-reduced-motion:
 * we still show a value, it just doesn't animate (one render, no interval) — DR15.
 */
function useLiveElapsed(start: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (start == null) return;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setNow(Date.now());
    if (reduced) return; // honour reduced-motion: a static readout, no ticking
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [start]);
  return start == null ? 0 : now - start;
}
