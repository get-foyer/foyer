import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SummaryPanel } from './SummaryPanel';
import type { FocusEntry } from '../types';

function entry(over: Partial<FocusEntry> = {}): FocusEntry {
  return {
    id: 'e-1',
    summary: 'doing a thing',
    ts: 1_700_000_000_000,
    turnSeq: 1,
    turnPrompt: 'the goal',
    ...over,
  };
}

describe('SummaryPanel', () => {
  it('renders the latest focus entry as the current focus', () => {
    render(
      <SummaryPanel
        summary={null}
        focusHistory={[entry({ id: 'e-2', summary: 'latest narration' })]}
        status="ready"
        error={null}
        sessionStatus="working"
      />,
    );
    expect(screen.getByText('latest narration')).toBeTruthy();
  });

  it('falls back to the raw summary when focusHistory is empty', () => {
    render(
      <SummaryPanel
        summary="raw summary"
        focusHistory={[]}
        status="ready"
        error={null}
        sessionStatus="working"
      />,
    );
    expect(screen.getByText('raw summary')).toBeTruthy();
  });

  it('hides the "Previously" section when there is ≤1 entry', () => {
    render(
      <SummaryPanel
        summary={null}
        focusHistory={[entry()]}
        status="ready"
        error={null}
        sessionStatus="working"
      />,
    );
    expect(screen.queryByText('Previously')).toBeNull();
  });

  it('shows the "Previously" section with older entries grouped by turn', () => {
    render(
      <SummaryPanel
        summary={null}
        focusHistory={[
          entry({ id: 'e-3', summary: 'current', turnSeq: 2, turnPrompt: 'second turn' }),
          entry({ id: 'e-2', summary: 'middle step', turnSeq: 1, turnPrompt: 'first turn' }),
          entry({ id: 'e-1', summary: 'first step', turnSeq: 1, turnPrompt: 'first turn' }),
        ]}
        status="ready"
        error={null}
        sessionStatus="working"
      />,
    );
    // toggle is present (2 older entries beyond the current)
    const toggle = screen.getByRole('button', { name: /Previously/ });
    expect(toggle).toBeTruthy();

    // expand the timeline
    fireEvent.click(toggle);
    const timeline = screen.getByLabelText('Earlier focus history');
    // the turn divider for the older turn shows its prompt text
    expect(within(timeline).getByText('first turn')).toBeTruthy();
    // current ("second turn") is rendered on top, not inside the Previously timeline
    expect(within(timeline).queryByText('second turn')).toBeNull();
  });

  it('expands a focus card to reveal its full summary', () => {
    render(
      <SummaryPanel
        summary={null}
        focusHistory={[
          entry({ id: 'e-2', summary: 'current' }),
          entry({ id: 'e-1', summary: 'older detailed narration' }),
        ]}
        status="ready"
        error={null}
        sessionStatus="working"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Previously/ }));
    const timeline = screen.getByLabelText('Earlier focus history');
    // collapsed: full body not shown yet; click the card header (timestamp button) to expand
    const cardHeader = within(timeline).getAllByRole('button')[0];
    fireEvent.click(cardHeader);
    expect(within(timeline).getByText('older detailed narration')).toBeTruthy();
  });

  it('shows the thinking state when working with no summary yet', () => {
    render(
      <SummaryPanel
        summary={null}
        focusHistory={[]}
        status="idle"
        error={null}
        sessionStatus="working"
      />,
    );
    expect(screen.getByText(/Agent is thinking/)).toBeTruthy();
  });
});
