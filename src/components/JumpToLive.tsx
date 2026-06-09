import React from 'react';

interface Props {
  /** Human label for the live session (its latest prompt, or a fallback). */
  liveLabel: string;
  /** Jump to the live session + resume following. */
  onFollow: () => void;
}

/**
 * "Jump to live" pill — the single re-engage affordance, shown ONLY when you've pinned a tab
 * (held) and a different session has since gone live. Mirrors the universal chat/log
 * "jump to present" pattern: following is the silent default, and this appears only when
 * you're behind. The whole pill is one always-actionable button (it never renders in a
 * disabled state). Clicking it jumps to the live session and resumes following.
 *
 *   ↓ "fix the header spacing"
 *     IS LIVE — JUMP
 *
 * Render it inside an `aria-live="polite"` region (see SessionTabs) so screen readers
 * announce it when it appears. Amber = the live signal (`--working`, forward-maps to the
 * Instrument `--signal`); the entrance animation is gated behind `prefers-reduced-motion`.
 */
export function JumpToLive({ liveLabel, onFollow }: Props) {
  return (
    <button
      type="button"
      className="jump-to-live"
      onClick={onFollow}
      aria-label={`Jump to the live session: ${liveLabel}`}
    >
      <span className="jump-to-live__arrow" aria-hidden="true">
        ↓
      </span>
      <span className="jump-to-live__label">
        <span className="jump-to-live__name">{liveLabel}</span>
        <span className="jump-to-live__hint">is live — Jump</span>
      </span>
    </button>
  );
}
