import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  it('renders the latest focus entry', () => {
    renderPanel({ focusHistory: [entry({ id: 'e-2', summary: 'latest narration' })] });
    expect(screen.getByText('latest narration')).toBeTruthy();
  });

  it('falls back to the raw summary when focusHistory is empty', () => {
    renderPanel({ summary: 'raw summary' });
    expect(screen.getByText('raw summary')).toBeTruthy();
  });

  it('shows every summary at once — no "Previously" toggle, no per-card expand', () => {
    renderPanel({
      focusHistory: [
        entry({ id: 'e-3', summary: 'current', turnSeq: 2, turnPrompt: 'second turn' }),
        entry({ id: 'e-2', summary: 'middle step', turnSeq: 1, turnPrompt: 'first turn' }),
        entry({ id: 'e-1', summary: 'first step', turnSeq: 1, turnPrompt: 'first turn' }),
      ],
    });
    // No interaction required: every summary is visible up front.
    expect(screen.getByText('current')).toBeTruthy();
    expect(screen.getByText('middle step')).toBeTruthy();
    expect(screen.getByText('first step')).toBeTruthy();
    // The collapsible "Previously" control is gone.
    expect(screen.queryByText('Previously')).toBeNull();
  });

  it('renders entries oldest → newest with turn dividers when history spans turns', () => {
    const { container } = renderPanel({
      focusHistory: [
        entry({ id: 'e-3', summary: 'newest', ts: 3, turnSeq: 2, turnPrompt: 'second turn' }),
        entry({ id: 'e-2', summary: 'middle', ts: 2, turnSeq: 1, turnPrompt: 'first turn' }),
        entry({ id: 'e-1', summary: 'oldest', ts: 1, turnSeq: 1, turnPrompt: 'first turn' }),
      ],
    });
    const texts = Array.from(container.querySelectorAll('.focus-entry__summary')).map((n) =>
      n.textContent?.trim(),
    );
    expect(texts).toEqual(['oldest', 'middle', 'newest']);
    // Both turn dividers are shown inline (chronological: first turn, then second).
    expect(screen.getByText('first turn')).toBeTruthy();
    expect(screen.getByText('second turn')).toBeTruthy();
  });

  it('omits turn dividers when all entries belong to one turn', () => {
    const { container } = renderPanel({
      focusHistory: [
        entry({ id: 'e-2', summary: 'second', turnSeq: 1, turnPrompt: 'only turn' }),
        entry({ id: 'e-1', summary: 'first', turnSeq: 1, turnPrompt: 'only turn' }),
      ],
    });
    expect(container.querySelector('.focus-group__divider')).toBeNull();
  });

  it('marks only the newest entry live while the session is working', () => {
    const { container } = renderPanel({
      sessionStatus: 'working',
      focusHistory: [
        entry({ id: 'e-2', summary: 'now', ts: 2 }),
        entry({ id: 'e-1', summary: 'before', ts: 1 }),
      ],
    });
    const live = container.querySelectorAll('.focus-entry--live');
    expect(live.length).toBe(1);
    expect(live[0].textContent).toContain('now');
  });

  it('shows the fresher live summary on the live row when a no-append refresh outpaced the stored entry', () => {
    // setActivity always advances `summary` but only stamps a new FocusEntry on real progress; on a
    // no-append refresh the live text outruns focusHistory[0], so the live row must follow `summary`.
    renderPanel({
      sessionStatus: 'working',
      summary: 'fresh live text',
      focusHistory: [
        entry({ id: 'e-2', summary: 'stale newest', ts: 2 }),
        entry({ id: 'e-1', summary: 'older entry', ts: 1 }),
      ],
    });
    expect(screen.getByText('fresh live text')).toBeTruthy(); // live row follows the prop
    expect(screen.getByText('older entry')).toBeTruthy(); // older rows keep their stored text
    expect(screen.queryByText('stale newest')).toBeNull();
  });

  it('marks no entry live once the session is done', () => {
    const { container } = renderPanel({ sessionStatus: 'done', focusHistory: [entry()] });
    expect(container.querySelectorAll('.focus-entry--live').length).toBe(0);
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
