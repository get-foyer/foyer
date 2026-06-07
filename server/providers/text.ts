/**
 * Shared text-processing helpers for LLM provider output.
 */
import type { SuggestedTopic } from '../../src/types.js';

/** Caps for a single suggested topic — protects the UI and the downstream research prompt. */
const TOPIC_MAX = 120;
const REASON_MAX = 160;
/** Hard cap on how many topics we surface as chips. */
const MAX_TOPICS = 6;

/**
 * Normalize the raw `topics` field from any provider's activity output into a clean
 * SuggestedTopic[]. Shared by all three providers (parseActivityJson for claude/anthropic,
 * and codex's inline parse) so the validation lives in ONE place.
 *
 * Defensive by design — the field comes straight from an LLM:
 *  - non-array (missing, null, object, string) → []
 *  - items missing a non-empty string `topic` OR `reason` are dropped
 *  - `topic`/`reason` are trimmed and length-capped
 *  - at most MAX_TOPICS items returned
 */
export function normalizeTopics(raw: unknown): SuggestedTopic[] {
  if (!Array.isArray(raw)) return [];
  const out: SuggestedTopic[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const topic = typeof rec.topic === 'string' ? rec.topic.trim() : '';
    const reason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
    if (!topic || !reason) continue;
    out.push({ topic: topic.slice(0, TOPIC_MAX), reason: reason.slice(0, REASON_MAX) });
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

/**
 * Strip markdown code fences from LLM-generated mermaid output.
 *
 * Handles:
 *  - Single or nested ```mermaid / ``` fence pairs (iterates until stable)
 *  - Fences with or without a trailing newline (LF or CRLF)
 *  - Leading prose preamble ("Here is the diagram:", etc.) that appears
 *    before the first recognised mermaid keyword — strips everything up to
 *    (but not including) that keyword
 *
 * Does NOT modify the mermaid body itself.
 */
export function stripFences(code: string): string {
  let s = code.trim();

  // Iteratively strip wrapping fence pairs — handles double-wrapped output
  // that the model occasionally produces.
  let prev: string;
  do {
    prev = s;
    s = s
      .replace(/^```(?:mermaid)?\r?\n?/, '')
      .replace(/```\s*$/, '')
      .trim();
  } while (s !== prev);

  // Strip any leading prose preamble before the mermaid diagram keyword.
  // Recognised opening keywords (subset of https://mermaid.js.org/intro/):
  //   graph, flowchart, sequenceDiagram, gantt, classDiagram, stateDiagram,
  //   erDiagram, journey, pie, mindmap, timeline, xychart-beta
  const mermaidKeywords =
    /^(graph\s|flowchart\s|sequenceDiagram|gantt|classDiagram|stateDiagram|erDiagram|journey|pie|mindmap|timeline|xychart-beta)/m;
  const idx = s.search(mermaidKeywords);
  if (idx > 0) {
    s = s.slice(idx).trim();
  }

  return s;
}

/**
 * Normalize a provider's raw `graph` field into either a clean mermaid string or `null`.
 *
 * `null` is a FIRST-CLASS answer: it means "this work does not warrant a workflow graph" (a
 * single-step task, a quick Q&A, trivial linear work). The dashboard then shows no workflow
 * region at all instead of a thin one-node placeholder. Shared by all three providers so the
 * "when is there no workflow" rule lives in ONE place (this replaced the old per-provider
 * `?? FALLBACK_GRAPH` triplication).
 *
 * Returns null when: the field is missing/non-string, empty, whitespace-only, or reduces to
 * empty after fence-stripping. Otherwise returns the fence-stripped mermaid (which KEEPS the
 * intentional `:::goal`/`:::active` classDefs that drive the active-step highlight).
 */
export function normalizeGraph(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw.trim()) return null;
  const stripped = stripFences(raw);
  return stripped.trim() ? stripped : null;
}

/**
 * Normalize text for equality comparison (focus-history de-dup).
 *
 * Lower-cases, trims, and collapses all runs of whitespace to a single space so two
 * narrations that differ only in casing/spacing/line-wrapping compare equal. This is a
 * coarse guard against the activity summarizer re-emitting a near-identical "Current
 * Focus" line; meaningful-progress gating (transcript growth / new touchpoint) is layered
 * on top of it in activity.ts.
 */
export function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}
