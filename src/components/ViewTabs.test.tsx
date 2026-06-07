import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewTabs } from './ViewTabs';

describe('ViewTabs', () => {
  it('renders both tabs with the active one marked aria-selected', () => {
    render(<ViewTabs view="focus" hasUnseenResearch={false} onSelect={() => {}} />);
    const focus = screen.getByRole('tab', { name: /focus/i });
    const research = screen.getByRole('tab', { name: /research/i });
    expect(focus.getAttribute('aria-selected')).toBe('true');
    expect(research.getAttribute('aria-selected')).toBe('false');
    // Roving tabindex: only the active tab is in the tab order.
    expect(focus.getAttribute('tabindex')).toBe('0');
    expect(research.getAttribute('tabindex')).toBe('-1');
  });

  it('shows the amber ready dot only when there is unseen research', () => {
    const { rerender, container } = render(
      <ViewTabs view="focus" hasUnseenResearch={false} onSelect={() => {}} />,
    );
    expect(container.querySelector('.view-tab__ready-dot')).toBeNull();
    rerender(<ViewTabs view="focus" hasUnseenResearch={true} onSelect={() => {}} />);
    expect(container.querySelector('.view-tab__ready-dot')).not.toBeNull();
    // Announced to assistive tech.
    expect(screen.getByLabelText(/new research ready/i)).toBeTruthy();
  });

  it('clicking a tab calls onSelect with that view', () => {
    const onSelect = vi.fn();
    render(<ViewTabs view="focus" hasUnseenResearch onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('tab', { name: /research/i }));
    expect(onSelect).toHaveBeenCalledWith('research');
  });

  it('ArrowRight from Focus selects Research (automatic activation)', () => {
    const onSelect = vi.fn();
    render(<ViewTabs view="focus" hasUnseenResearch={false} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: /focus/i }), { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('research');
  });

  it('ArrowLeft wraps from Focus back to Research', () => {
    const onSelect = vi.fn();
    render(<ViewTabs view="focus" hasUnseenResearch={false} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: /focus/i }), { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenCalledWith('research');
  });
});
