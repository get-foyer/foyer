import { describe, it, expect, beforeEach } from 'vitest';
import {
  toArea,
  recordTouchedPath,
  getTopAreas,
  forgetTouched,
  _resetTouchedForTest,
} from './touched.js';

beforeEach(() => {
  _resetTouchedForTest();
});

describe('toArea', () => {
  it('relativizes paths under cwd and aggregates to the dir', () => {
    expect(toArea('/repo/server/providers/codex.ts', '/repo')).toBe('server/providers');
  });

  it('caps aggregation at 3 segments', () => {
    expect(toArea('/repo/a/b/c/d/e.ts', '/repo')).toBe('a/b/c');
  });

  it('drops paths outside the cwd (no useful repo-area signal)', () => {
    expect(toArea('/tmp/scratch/x.ts', '/repo')).toBeNull();
  });

  it('drops repo-root files (dir "." carries no area)', () => {
    expect(toArea('/repo/README.md', '/repo')).toBeNull();
  });

  it('keeps relative paths as-is without a cwd', () => {
    expect(toArea('src/components/App.tsx', null)).toBe('src/components');
  });

  it('returns null for empty/garbage input', () => {
    expect(toArea('', '/repo')).toBeNull();
    expect(toArea(undefined as unknown as string, '/repo')).toBeNull();
  });
});

describe('recordTouchedPath / getTopAreas', () => {
  it('orders areas by touch count, most active first', () => {
    recordTouchedPath('s1', '/repo/src/a.ts', '/repo');
    recordTouchedPath('s1', '/repo/server/x.ts', '/repo');
    recordTouchedPath('s1', '/repo/server/y.ts', '/repo');
    expect(getTopAreas('s1')).toEqual(['server', 'src']);
  });

  it('caps the returned list at n', () => {
    for (let i = 0; i < 12; i++) recordTouchedPath('s1', `/repo/dir${i}/f.ts`, '/repo');
    expect(getTopAreas('s1', 8)).toHaveLength(8);
  });

  it('is isolated per session and forgettable', () => {
    recordTouchedPath('s1', '/repo/src/a.ts', '/repo');
    recordTouchedPath('s2', '/repo/server/b.ts', '/repo');
    expect(getTopAreas('s2')).toEqual(['server']);
    forgetTouched('s1');
    expect(getTopAreas('s1')).toEqual([]);
    expect(getTopAreas('s2')).toEqual(['server']);
  });

  it('evicts the lowest-count dir at the per-session cap (newest survives)', () => {
    // Fill 50 dirs with 2 touches each, then add a 51st with 1 touch repeatedly: the map
    // never exceeds the cap and high-count dirs survive.
    for (let i = 0; i < 50; i++) {
      recordTouchedPath('s1', `/repo/dir${i}/f.ts`, '/repo');
      recordTouchedPath('s1', `/repo/dir${i}/g.ts`, '/repo');
    }
    recordTouchedPath('s1', '/repo/newdir/f.ts', '/repo');
    const all = getTopAreas('s1', 100);
    expect(all.length).toBeLessThanOrEqual(50);
    expect(all).toContain('dir0');
  });
});
