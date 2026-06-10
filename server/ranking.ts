/**
 * Ranking — the pure decision core of the Live Learning Briefing.
 *
 * PURE by design (design review 7A): no imports of state/prefetch/fs. Candidates + signals in,
 * decisions out. activity.ts gathers the inputs and applies the outputs.
 *
 *   doc index ──┐
 *   touched ────┼─► selectSnippets (local top-K keyword overlap, D13: ≤8 on summarize ticks,
 *   prompt ─────┘                   ≤30 on briefing calls — bounds the hot path's token cost)
 *
 *   LLM proposal ──┐
 *   current primary┼─► decidePrimary (sticky, D6/DR7: keep unless the LLM proposes a different
 *   dismissed ─────┘                  pick; read primaries demote on the next pick; dismissed
 *                                     topics are never re-proposed)
 */
import type { SuggestedTopic, PrimaryBriefing } from '../src/types.js';
import { topicKey } from '../src/types.js';
import type { DocSnippet } from './docsources/index.js';

/** Snippet budget on the hot summarize-tick path (eng review D13). */
export const TICK_SNIPPET_BUDGET = 8;
/** Snippet budget on the once-per-primary briefing/research path (eng review D13). */
export const BRIEFING_SNIPPET_BUDGET = 30;

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'in',
  'to',
  'for',
  'on',
  'with',
  'is',
  'are',
  'be',
  'it',
  'this',
  'that',
  'as',
  'at',
  'by',
  'from',
  'into',
  'how',
  'what',
  'why',
  'when',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

export interface RankSignals {
  /** Dir areas the agent's tool calls touched (touched.ts top areas). */
  touchedAreas: string[];
  /** Free text grounding the task — typically the current prompt (+ optionally topic texts). */
  promptText: string;
}

/**
 * Local top-K preselection: cheap keyword overlap between the session's signals and each doc's
 * title/path/snippet. ~1ms string work that keeps the doc payload entering ANY prompt constant
 * regardless of how many doc dirs the user configures (eng review D13).
 */
export function selectSnippets(index: DocSnippet[], signals: RankSignals, k: number): DocSnippet[] {
  if (index.length === 0 || k <= 0) return [];
  const queryTokens = tokenize(signals.promptText + ' ' + signals.touchedAreas.join(' '));
  const scored = index.map((doc) => {
    const docTokens = tokenize(`${doc.title} ${doc.path} ${doc.snippet}`);
    let score = 0;
    for (const t of queryTokens) if (docTokens.has(t)) score++;
    // Touched-area path affinity is the strongest signal: a doc whose path shares a segment with
    // a touched dir is about the code being edited right now.
    for (const area of signals.touchedAreas) {
      for (const seg of area.toLowerCase().split('/')) {
        if (seg.length >= 3 && doc.path.toLowerCase().includes(seg)) score += 2;
      }
    }
    return { doc, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.doc.mtime - a.doc.mtime)
    .slice(0, k)
    .map((s) => s.doc);
}

/** A validated primary proposal from the LLM (parse-site validated against candidates). */
export interface PrimaryProposal {
  topic: string;
  reason: string;
}

export type PrimaryDecision =
  | { action: 'keep' }
  | { action: 'designate'; topic: string; reason: string };

export interface DecidePrimaryArgs {
  /** The session's current designation (undefined/null = none). */
  current: PrimaryBriefing | null | undefined;
  /** The LLM's validated proposal this tick (null = no confident pick / keep current). */
  proposal: PrimaryProposal | null;
  /** topicKeys the user dismissed this session — never re-proposed (eng review D18). */
  dismissedKeys: ReadonlySet<string>;
}

/**
 * The sticky-primary rule (eng D6 + design DR7):
 *  - no proposal → keep whatever exists (stickiness; the LLM saw the current primary and chose
 *    not to move — proposing a DIFFERENT topic is the meaningful-shift signal).
 *  - proposal same as current → keep (no churn, no re-warm).
 *  - proposal different → designate. This covers every status: warming/error are replaced
 *    (generation invalidation discards the in-flight warm), ready-unread is superseded (its
 *    briefing stays as an unread row), and READ demotes to a read row (DR7 — read is not
 *    terminal; the anti-yank guarantee only protects unread/open reading, which `read` is past).
 *  - dismissed topics are never designated.
 */
export function decidePrimary(args: DecidePrimaryArgs): PrimaryDecision {
  const { current, proposal, dismissedKeys } = args;
  if (!proposal) return { action: 'keep' };
  const key = topicKey(proposal.topic);
  if (dismissedKeys.has(key)) return { action: 'keep' };
  if (current && topicKey(current.topic) === key) return { action: 'keep' };
  return { action: 'designate', topic: proposal.topic, reason: proposal.reason };
}

/**
 * After a dismiss: promote the next-ranked candidate (suggestion order is the model's ranking)
 * that isn't dismissed and isn't the just-dismissed topic. Null when the queue is empty — the
 * strip falls back to the extractive readout (design review DR8: never a blank).
 */
export function nextPrimaryAfterDismiss(
  candidates: SuggestedTopic[],
  dismissedKeys: ReadonlySet<string>,
): SuggestedTopic | null {
  for (const c of candidates) {
    if (!dismissedKeys.has(topicKey(c.topic))) return c;
  }
  return null;
}
