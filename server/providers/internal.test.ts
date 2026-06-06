import { describe, it, expect } from 'vitest';
import {
  isSelfOriginatedHook,
  FOYER_INTERNAL_DIR_PREFIX,
  FOYER_INTERNAL_SENTINEL,
} from './internal.js';

describe('isSelfOriginatedHook', () => {
  it('returns true when cwd contains the internal dir prefix', () => {
    expect(isSelfOriginatedHook({ cwd: `/tmp/${FOYER_INTERNAL_DIR_PREFIX}abc123` })).toBe(true);
  });

  it('returns true when cwd contains the prefix deeper in the path', () => {
    expect(
      isSelfOriginatedHook({ cwd: `/var/folders/xy/${FOYER_INTERNAL_DIR_PREFIX}xyz789/work` }),
    ).toBe(true);
  });

  it('returns true when prompt contains the sentinel', () => {
    expect(isSelfOriginatedHook({ prompt: `${FOYER_INTERNAL_SENTINEL}\nYou are narrating…` })).toBe(
      true,
    );
  });

  it('returns true when both cwd and prompt match', () => {
    expect(
      isSelfOriginatedHook({
        cwd: `/tmp/${FOYER_INTERNAL_DIR_PREFIX}xyz`,
        prompt: `${FOYER_INTERNAL_SENTINEL}\nSome prompt`,
      }),
    ).toBe(true);
  });

  it('returns false for a real user prompt with a normal cwd', () => {
    expect(
      isSelfOriginatedHook({
        cwd: '/home/user/myproject',
        prompt: 'Fix the authentication bug',
      }),
    ).toBe(false);
  });

  it('returns false when cwd is undefined and prompt is undefined', () => {
    expect(isSelfOriginatedHook({})).toBe(false);
  });

  it('returns false when cwd is defined but does not contain the prefix', () => {
    expect(isSelfOriginatedHook({ cwd: '/tmp/unrelated-dir', prompt: 'Build the graph' })).toBe(
      false,
    );
  });

  it('returns false when prompt is defined but does not contain the sentinel', () => {
    expect(
      isSelfOriginatedHook({ cwd: '/home/user/project', prompt: 'You are narrating something' }),
    ).toBe(false);
  });

  it('is case-sensitive — a partial prefix match in cwd does not trigger', () => {
    // 'foyer-' appears but the full prefix 'foyer-internal-' does not
    expect(isSelfOriginatedHook({ cwd: '/tmp/foyer-claude-abc123' })).toBe(false);
  });

  it('is case-sensitive — a partial sentinel in prompt does not trigger', () => {
    expect(
      isSelfOriginatedHook({ prompt: 'foyer-internal-something but not the real sentinel' }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constant value sanity checks — if these change the guard silently breaks
// ---------------------------------------------------------------------------

describe('marker constants', () => {
  it('FOYER_INTERNAL_DIR_PREFIX is a non-empty string', () => {
    expect(typeof FOYER_INTERNAL_DIR_PREFIX).toBe('string');
    expect(FOYER_INTERNAL_DIR_PREFIX.length).toBeGreaterThan(0);
  });

  it('FOYER_INTERNAL_SENTINEL is a non-empty string', () => {
    expect(typeof FOYER_INTERNAL_SENTINEL).toBe('string');
    expect(FOYER_INTERNAL_SENTINEL.length).toBeGreaterThan(0);
  });

  it('FOYER_INTERNAL_DIR_PREFIX does not contain the sentinel (no accidental cross-match)', () => {
    expect(FOYER_INTERNAL_DIR_PREFIX).not.toContain(FOYER_INTERNAL_SENTINEL);
  });
});
