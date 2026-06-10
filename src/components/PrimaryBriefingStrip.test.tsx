import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PrimaryBriefingStrip } from './PrimaryBriefingStrip';
import type { PrimaryBriefing, ResearchResult } from '../types';

const briefing = (topic: string, over: Partial<ResearchResult> = {}): ResearchResult => ({
  topic,
  lede: `Lede for ${topic}.`,
  sections: [{ heading: topic, body: 'body' }],
  links: [],
  ts: 1000,
  readAt: null,
  ...over,
});

const primary = (over: Partial<PrimaryBriefing> = {}): PrimaryBriefing => ({
  topic: 'DNS rebinding guard',
  reason: 'the session is editing server/security hooks',
  status: 'ready',
  since: 0,
  readyMs: 12000,
  ...over,
});

function renderStrip(props: Partial<React.ComponentProps<typeof PrimaryBriefingStrip>> = {}) {
  return render(
    <PrimaryBriefingStrip
      primary={primary()}
      results={[briefing('DNS rebinding guard')]}
      touchedAreas={[]}
      contextDocs={[]}
      onOpenBriefing={() => {}}
      onDismiss={() => {}}
      onRetry={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('PrimaryBriefingStrip — states', () => {
  it('extractive: no primary but signals exist → WATCHING/MATCHED, no LED', () => {
    renderStrip({
      primary: null,
      touchedAreas: ['server/providers'],
      contextDocs: [{ path: 'docs/a.md', title: 'ADR 3' }],
    });
    expect(screen.getByText(/watching/i)).toBeInTheDocument();
    expect(screen.getByText('server/providers')).toBeInTheDocument();
    expect(screen.getByText('ADR 3')).toBeInTheDocument();
    expect(screen.queryByText(/Primary Briefing/)).not.toBeInTheDocument();
  });

  it('renders nothing when there is no primary and no signals (DR9 boundary)', () => {
    const { container } = renderStrip({ primary: null, touchedAreas: [], contextDocs: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('ready: shows reason, lede, the OPEN BRIEFING keycap, and frozen time-to-ready', () => {
    const onOpen = vi.fn();
    renderStrip({ primary: primary(), onOpenBriefing: onOpen });
    expect(screen.getByText('the session is editing server/security hooks')).toBeInTheDocument();
    expect(screen.getByText('Lede for DNS rebinding guard.')).toBeInTheDocument();
    expect(screen.getByText(/Primary Briefing · Ready/)).toBeInTheDocument();
    expect(screen.getByText('ready · 00:12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OPEN BRIEFING' }));
    expect(onOpen).toHaveBeenCalledWith(1000);
  });

  it('warming: reason shown, no keycap, live elapsed readout', () => {
    renderStrip({ primary: primary({ status: 'warming', readyMs: null }), results: [] });
    expect(screen.getByText(/Primary Briefing · Warming/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OPEN BRIEFING' })).not.toBeInTheDocument();
    expect(screen.getByText(/^warming · /)).toBeInTheDocument();
  });

  it('read: dim, REOPEN instead of OPEN, no dismiss, no time readout', () => {
    renderStrip({
      primary: primary({ status: 'read' }),
      results: [briefing('DNS rebinding guard', { readAt: 2000 })],
    });
    expect(screen.getByRole('button', { name: 'REOPEN' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Not Useful/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/ready · /)).not.toBeInTheDocument();
  });

  it('error: RETRY fires onRetry, shows failure count, no eternal ring', () => {
    const onRetry = vi.fn();
    renderStrip({ primary: primary({ status: 'error', failures: 2 }), results: [], onRetry });
    expect(screen.getByText('failed ×2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'RETRY' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('PrimaryBriefingStrip — dismiss with 5s undo (DR8)', () => {
  it('commits the dismissal only after the undo window lapses', () => {
    const onDismiss = vi.fn();
    renderStrip({ onDismiss });
    fireEvent.click(screen.getByRole('button', { name: /Dismiss primary briefing/ }));
    // Undo window open — not committed yet.
    expect(screen.getByText(/dismissed/)).toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('UNDO cancels the pending dismissal', () => {
    const onDismiss = vi.fn();
    renderStrip({ onDismiss });
    fireEvent.click(screen.getByRole('button', { name: /Dismiss primary briefing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'UNDO' }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    // Back to the dismiss control.
    expect(screen.getByRole('button', { name: /Dismiss primary briefing/ })).toBeInTheDocument();
  });

  it('has an accessible label naming the dismissed topic', () => {
    renderStrip();
    expect(
      screen.getByRole('button', {
        name: 'Dismiss primary briefing: DNS rebinding guard — not useful',
      }),
    ).toBeInTheDocument();
  });
});
