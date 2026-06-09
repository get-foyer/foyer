import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResearchChips } from './ResearchChips';
import type { SuggestedTopic } from '../types';

const topics: SuggestedTopic[] = [
  { topic: 'React useTransition', reason: 'used in App.tsx' },
  { topic: 'Mermaid graph LR', reason: 'drawing the workflow' },
];

/** ResearchChips renders <li> items (a fragment), so wrap it in a <ul> for valid DOM. */
function renderChips(props: Partial<React.ComponentProps<typeof ResearchChips>> = {}) {
  return render(
    <ul className="research-list">
      <ResearchChips
        suggestedTopics={topics}
        sessionId="s1"
        primedTopics={[]}
        warmingTopics={[]}
        {...props}
      />
    </ul>,
  );
}

beforeEach(() => {
  // Default: a fetch that never resolves, so we can observe the pending state.
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ResearchChips — launcher', () => {
  it('renders one chip per suggested topic, with the provenance reason', () => {
    renderChips();
    expect(screen.getByText('React useTransition')).toBeTruthy();
    expect(screen.getByText('used in App.tsx')).toBeTruthy();
    expect(screen.getByText('Mermaid graph LR')).toBeTruthy();
  });

  it('renders nothing actionable when there are no topics', () => {
    renderChips({ suggestedTopics: [] });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('clicking a chip POSTs /research with the topic + sessionId and disables it', () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    renderChips();
    const chip = screen.getByText('React useTransition').closest('button')!;
    fireEvent.click(chip);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/research');
    expect(JSON.parse(opts.body)).toEqual({ topic: 'React useTransition', sessionId: 's1' });
    expect(chip.disabled).toBe(true);
  });

  it('double-click only fires one research request (pending guard)', () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    renderChips();
    const chip = screen.getByText('React useTransition').closest('button')!;
    fireEvent.click(chip);
    fireEvent.click(chip);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows an error and re-enables the chip when research fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'provider exploded' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderChips();
    const chip = screen.getByText('React useTransition').closest('button')!;
    fireEvent.click(chip);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('provider exploded');
    expect(chip.disabled).toBe(false); // retryable
  });
});

describe('ResearchChips — primed (prefetched) dot', () => {
  it('renders an amber primed dot on a chip whose research is warmed', () => {
    const { container } = renderChips({ primedTopics: ['react usetransition'] });
    const primedChip = screen.getByText('React useTransition').closest('button')!;
    expect(primedChip.querySelector('.research-chip__primed')).toBeTruthy();
    expect(primedChip.getAttribute('aria-label')).toBe('React useTransition — ready');
    // Exactly one chip is primed.
    expect(container.querySelectorAll('.research-chip__primed').length).toBe(1);
  });

  it('renders no dot on a non-primed chip', () => {
    renderChips({ primedTopics: ['react usetransition'] });
    const coldChip = screen.getByText('Mermaid graph LR').closest('button')!;
    expect(coldChip.querySelector('.research-chip__primed')).toBeNull();
  });

  it('a pending (tapped) chip shows the spinner, not the primed dot', () => {
    renderChips({ primedTopics: ['react usetransition'] });
    const chip = screen.getByText('React useTransition').closest('button')!;
    fireEvent.click(chip); // fetch never resolves → stays pending
    expect(chip.querySelector('.research-chip__primed')).toBeNull();
    expect(chip.querySelector('.research-chip__spinner')).toBeTruthy();
  });
});

describe('ResearchChips — warming (in-flight prefetch) ring', () => {
  it('renders a warming ring (not the primed dot) on a chip being prefetched', () => {
    const { container } = renderChips({ warmingTopics: ['react usetransition'] });
    const chip = screen.getByText('React useTransition').closest('button')!;
    expect(chip.querySelector('.research-chip__warming')).toBeTruthy();
    expect(chip.querySelector('.research-chip__primed')).toBeNull();
    expect(chip.getAttribute('aria-label')).toBe('React useTransition — warming');
    expect(container.querySelectorAll('.research-chip__warming').length).toBe(1);
  });

  it('primed wins over warming if a topic is somehow in both (ready beats in-flight)', () => {
    renderChips({
      primedTopics: ['react usetransition'],
      warmingTopics: ['react usetransition'],
    });
    const button = screen.getByText('React useTransition').closest('button')!;
    expect(button.querySelector('.research-chip__primed')).toBeTruthy();
    expect(button.querySelector('.research-chip__warming')).toBeNull();
  });

  it('a pending (tapped) chip shows the spinner, not the warming ring', () => {
    renderChips({ warmingTopics: ['react usetransition'] });
    const chip = screen.getByText('React useTransition').closest('button')!;
    fireEvent.click(chip); // fetch never resolves → stays pending
    expect(chip.querySelector('.research-chip__warming')).toBeNull();
    expect(chip.querySelector('.research-chip__spinner')).toBeTruthy();
  });
});
