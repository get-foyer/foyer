/**
 * Touched-areas signal — which parts of the repo the agent is working in.
 *
 * Restored server-side only (the Live Files PANEL stays removed — 2026-06-09 decision): this is
 * the DATA signal that feeds primary-briefing ranking and the strip's extractive WATCHING readout,
 * not a UI log of file operations.
 *
 *   PostToolUse hook ──recordTouchedPath──▶ in-memory per-session dir counts (pure map update,
 *                                            no I/O — the hook path stays non-blocking)
 *   summarize tick   ──getTopAreas───────▶ Session.touchedAreas (persisted via setActivity's
 *                                            existing write — eng review D14: flush rides the tick,
 *                                            never per tool call)
 *
 * Aggregation is at the DIRECTORY level (max 3 path segments, relative to the session cwd when
 * possible): ranking needs "server/providers", not 400 file paths. Counts are capped per session;
 * the lowest-count dir is evicted at the cap so a long session can't grow unbounded.
 */
import { relative, dirname, isAbsolute, sep } from 'path';

/** Max distinct dirs tracked per session (lowest-count evicted beyond this). */
const MAX_DIRS = 50;
/** Max path segments an aggregated area keeps ("a/b/c/d/e.ts" → "a/b/c"). */
const MAX_SEGMENTS = 3;

// sessionId -> dir -> touch count
const counts = new Map<string, Map<string, number>>();

/**
 * Reduce a touched file path to its aggregation dir: relative to `cwd` when the path is inside
 * it, then the dirname, capped at MAX_SEGMENTS. Returns null for paths that carry no useful
 * area signal (repo root itself, traversal escapes, empty).
 */
export function toArea(filePath: string, cwd: string | null | undefined): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  let p = filePath;
  if (cwd && isAbsolute(p)) {
    const rel = relative(cwd, p);
    // Outside the session's repo (or a traversal): keep only an in-repo signal — out-of-repo
    // touches (tmp files, global config) say nothing about which repo area the task lives in.
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    p = rel;
  }
  const dir = dirname(p);
  if (!dir || dir === '.' || dir === sep) return null;
  const segments = dir.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;
  return segments.slice(0, MAX_SEGMENTS).join('/');
}

/** Record one touched file path for a session. Pure in-memory map update — safe on the hook path. */
export function recordTouchedPath(
  sessionId: string,
  filePath: string,
  cwd: string | null | undefined,
): void {
  const area = toArea(filePath, cwd);
  if (!area) return;
  let m = counts.get(sessionId);
  if (!m) {
    m = new Map();
    counts.set(sessionId, m);
  }
  m.set(area, (m.get(area) ?? 0) + 1);
  if (m.size > MAX_DIRS) {
    // Evict the single lowest-count dir — O(n) on a tiny capped map, only at the cap boundary.
    let minKey: string | null = null;
    let min = Infinity;
    for (const [k, v] of m) {
      if (v < min) {
        min = v;
        minKey = k;
      }
    }
    if (minKey !== null) m.delete(minKey);
  }
}

/** The session's top-N touched areas, most-active first. Read at summarize time (the flush). */
export function getTopAreas(sessionId: string, n = 8): string[] {
  const m = counts.get(sessionId);
  if (!m) return [];
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([dir]) => dir);
}

/** Forget a session's counters (session dropped from the live window). */
export function forgetTouched(sessionId: string): void {
  counts.delete(sessionId);
}

/** Clear all state. Tests only. */
export function _resetTouchedForTest(): void {
  counts.clear();
}
