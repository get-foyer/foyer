import React, { useEffect, useId, useRef, useState } from 'react';

interface Props {
  /** Whether this session is currently pinned — toggles the single menu item's label/action. */
  pinned: boolean;
  /** Short session id, for accessible labels. */
  shortId: string;
  onPin: () => void;
  onUnpin: () => void;
}

/** Popover control methods aren't in every installed lib.dom version — narrow locally. */
type PopoverEl = HTMLDivElement & {
  togglePopover?: () => void;
  hidePopover?: () => void;
};

/**
 * Per-row "⋯" options menu, built on the native Popover API (Baseline 2026) instead of a
 * hand-rolled portal. Why native:
 *
 *   - The popover renders in the TOP LAYER, so it escapes the sidebar's `overflow-y:auto`
 *     + the row's `overflow:hidden` with zero JS — the exact clip a portal was needed for.
 *   - Light-dismiss (click-outside), Escape, focus-return to the trigger, and
 *     one-menu-open-at-a-time all come from the platform for free.
 *   - CSS anchor positioning (styles.css) places + flips it; the unique anchor name is passed
 *     as a CSS custom property so each row's menu anchors to its own trigger.
 *
 * The `popover` attribute is set imperatively (not as a JSX prop) so this doesn't depend on the
 * installed React DOM typings; `.session-menu` is `display:none` by default, so there's no flash
 * before the effect runs. We still own the ARIA menu semantics (the Popover API is display-only):
 * role=menu/menuitem, aria-haspopup/expanded, focus-first-item on open, and ArrowUp/Down.
 */
export function SessionMenu({ pinned, shortId, onPin, onUnpin }: Props) {
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const rawId = useId();
  const safe = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const menuId = `session-menu-${safe}`;
  // Unique dashed-ident anchor name, carried as a custom property so the same value lands on both
  // the trigger (anchor-name) and the popover (position-anchor) — see styles.css.
  const anchorStyle = { '--sm-anchor': `--sm-${safe}` } as React.CSSProperties;

  useEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    pop.setAttribute('popover', 'auto');
    // The Popover API toggles via the `toggle` event. Mirror its state for aria-expanded + the
    // "keep the trigger visible while its menu is open" styling, and focus the first item on open.
    const onToggle = (e: Event) => {
      const isOpen = (e as Event & { newState?: string }).newState === 'open';
      setOpen(isOpen);
      if (isOpen) pop.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    };
    pop.addEventListener('toggle', onToggle);
    return () => pop.removeEventListener('toggle', onToggle);
  }, []);

  const toggleMenu = () => (popRef.current as PopoverEl | null)?.togglePopover?.();

  const runAndClose = (fn: () => void) => {
    fn();
    (popRef.current as PopoverEl | null)?.hidePopover?.();
  };

  // ArrowUp/Down cycle menu items (one today; ready for growth). Escape is handled natively.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(
      popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const cur = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <>
      <button
        type="button"
        className={`session-tab__menu${open ? ' session-tab__menu--open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Session options ${shortId}`}
        onClick={toggleMenu}
        style={anchorStyle}
      >
        ⋯
      </button>
      <div
        ref={popRef}
        id={menuId}
        role="menu"
        tabIndex={-1}
        aria-label={`Session ${shortId} options`}
        className="session-menu"
        style={anchorStyle}
        onKeyDown={onMenuKeyDown}
      >
        {pinned ? (
          <button
            type="button"
            role="menuitem"
            className="session-menu__item"
            onClick={() => runAndClose(onUnpin)}
          >
            Unpin session
          </button>
        ) : (
          <button
            type="button"
            role="menuitem"
            className="session-menu__item"
            onClick={() => runAndClose(onPin)}
          >
            Pin session
          </button>
        )}
      </div>
    </>
  );
}
