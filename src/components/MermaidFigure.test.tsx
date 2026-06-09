import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// mermaid needs a layout engine jsdom lacks; stub render so the guard logic is what's under test.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg><text>ok</text></svg>' }),
  },
}));

import { MermaidFigure } from './MermaidFigure';

describe('MermaidFigure input guards (untrusted LLM diagrams)', () => {
  it('renders a figure for an allowed diagram type', () => {
    const { container } = render(<MermaidFigure diagram={'flowchart LR\n  A-->B'} />);
    expect(container.querySelector('figure.research-figure')).not.toBeNull();
  });

  it('renders nothing for a disallowed diagram type (e.g. gantt)', () => {
    const { container } = render(<MermaidFigure diagram={'gantt\n  title X'} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for an oversized diagram (parse-time DoS guard)', () => {
    const huge = 'flowchart LR\n' + 'A-->B\n'.repeat(2000);
    const { container } = render(<MermaidFigure diagram={huge} />);
    expect(container.firstChild).toBeNull();
  });

  it('strips a model-emitted %%{init}%% directive but still renders an allowed diagram', () => {
    const withInit = '%%{init: {"theme":"dark"}}%%\nflowchart LR\n  A-->B';
    const { container } = render(<MermaidFigure diagram={withInit} />);
    expect(container.querySelector('figure.research-figure')).not.toBeNull();
  });
});
