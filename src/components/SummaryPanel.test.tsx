import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SummaryPanel } from './SummaryPanel';
import type { FocusEntry } from '../types';

// Stub the mermaid renderer: SummaryPanel only decides WHETHER to fold the graph in; the
// actual mermaid.render + DOMPurify pipeline is exercised by graphSanitize.test.ts (and
// mermaid needs a real layout engine jsdom doesn't have). This keeps these tests on the
// branching logic — shown / hidden / sketching.
vi.mock('./WorkflowGraph', () => ({
  WorkflowGraph: ({ graph }: { graph: string }) => <div data-testid="workflow-graph">{graph}</div>,
}));

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

type PanelProps = React.ComponentProps<typeof SummaryPanel>;

/** Render with sensible defaults; override per test. Keeps the new graph/showWorkflow props
 *  from having to be repeated in every existing case. */
function renderPanel(over: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    summary: null,
    focusHistory: [],
    status: 'ready',
    error: null,
    sessionStatus: 'working',
    graph: null,
    showWorkflow: false,
    ...over,
  };
  return render(<SummaryPanel {...props} />);
}

describe('SummaryPanel', () => {
  it('renders the latest focus entry as the current focus', () => {
    renderPanel({ focusHistory: [entry({ id: 'e-2', summary: 'latest narration' })] });
    expect(screen.getByText('latest narration')).toBeTruthy();
  });

  it('falls back to the raw summary when focusHistory is empty', () => {
    renderPanel({ summary: 'raw summary' });
    expect(screen.getByText('raw summary')).toBeTruthy();
  });

  it('hides the "Previously" section when there is ≤1 entry', () => {
    renderPanel({ focusHistory: [entry()] });
    expect(screen.queryByText('Previously')).toBeNull();
  });

  it('shows the "Previously" section with older entries grouped by turn', () => {
    renderPanel({
      focusHistory: [
        entry({ id: 'e-3', summary: 'current', turnSeq: 2, turnPrompt: 'second turn' }),
        entry({ id: 'e-2', summary: 'middle step', turnSeq: 1, turnPrompt: 'first turn' }),
        entry({ id: 'e-1', summary: 'first step', turnSeq: 1, turnPrompt: 'first turn' }),
      ],
    });
    const toggle = screen.getByRole('button', { name: /Previously/ });
    expect(toggle).toBeTruthy();

    fireEvent.click(toggle);
    const timeline = screen.getByLabelText('Earlier focus history');
    expect(within(timeline).getByText('first turn')).toBeTruthy();
    expect(within(timeline).queryByText('second turn')).toBeNull();
  });

  it('expands a focus card to reveal its full summary', () => {
    renderPanel({
      focusHistory: [
        entry({ id: 'e-2', summary: 'current' }),
        entry({ id: 'e-1', summary: 'older detailed narration' }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Previously/ }));
    const timeline = screen.getByLabelText('Earlier focus history');
    const cardHeader = within(timeline).getAllByRole('button')[0];
    fireEvent.click(cardHeader);
    expect(within(timeline).getByText('older detailed narration')).toBeTruthy();
  });

  it('shows the thinking state when working with no summary yet', () => {
    renderPanel({ status: 'idle' });
    expect(screen.getByText(/Agent is thinking/)).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Workflow fold-in (shown only when the turn warrants it)
  // -------------------------------------------------------------------------

  it('folds in the workflow graph when showWorkflow and a graph exist', () => {
    renderPanel({ summary: 'narration', showWorkflow: true, graph: 'graph LR\n  A:::goal' });
    expect(screen.getByText('Workflow')).toBeTruthy();
    expect(screen.getByTestId('workflow-graph')).toBeTruthy();
    expect(screen.queryByText(/Sketching workflow/)).toBeNull();
  });

  it('shows the "Sketching…" hint when warranted but no graph drawn yet (e.g. just after plan mode)', () => {
    renderPanel({ summary: 'narration', showWorkflow: true, graph: null });
    expect(screen.getByText('Workflow')).toBeTruthy();
    expect(screen.getByText(/Sketching workflow/)).toBeTruthy();
    expect(screen.queryByTestId('workflow-graph')).toBeNull();
  });

  it('renders NO workflow region when the turn is trivial (showWorkflow=false), even if a graph exists', () => {
    renderPanel({ summary: 'narration', showWorkflow: false, graph: 'graph LR\n  A:::goal' });
    expect(screen.queryByText('Workflow')).toBeNull();
    expect(screen.queryByTestId('workflow-graph')).toBeNull();
    expect(screen.queryByText(/Sketching workflow/)).toBeNull();
  });
});
