/**
 * Shared text-processing helpers for LLM provider output.
 */
import type { SuggestedTopic, ResearchSection, ResearchLink } from '../../src/types.js';
import { topicKey } from '../../src/types.js';
import { sanitizeUrl } from '../../src/lib/url.js';

/** Caps for a single suggested topic — protects the UI and the downstream research prompt. */
const TOPIC_MAX = 120;
const REASON_MAX = 160;
/** Hard cap on how many topics we surface as chips. */
const MAX_TOPICS = 6;
/** Cap for the primary briefing's why-now line — one line on the strip (design review DR12). */
const PRIMARY_REASON_MAX = 80;

/** Caps for a parsed research briefing (defensive — the shape comes straight from an LLM). */
const LEDE_MAX = 400;
const HEADING_MAX = 120;
const MAX_SECTIONS = 12;
/** Mermaid source cap — a parse-time DoS guard before the renderer ever sees it. */
const DIAGRAM_MAX = 4000;
const MAX_SOURCES = 8;

/**
 * The shared research prompt. Asks every backend for the SAME structured documentation JSON so
 * briefing shape doesn't drift by provider. Providers that search via the model (Anthropic)
 * prepend their own "search the web" line; CLI providers get search through flags.
 *
 * The adaptive rule is load-bearing: a trivial topic must come back as ONE section with no
 * diagram. Manufactured structure is the empty-chrome failure mode.
 */
export function RESEARCH_PROMPT(topic: string): string {
  return `Produce a research briefing on: "${topic}"

Return ONLY a JSON object — no markdown code fences, no prose before or after it — with exactly this shape:
{
  "lede": "1-2 sentence plain-language summary of the whole topic",
  "sections": [
    { "heading": "Short section title", "body": "GitHub-flavored markdown", "diagram": "optional raw mermaid source" }
  ],
  "sources": [ { "title": "Source title", "url": "https://..." } ]
}

Rules:
- "lede": 1-2 sentences a reader gets the gist from in two seconds.
- "sections": use as FEW sections as the topic genuinely needs. A simple topic may be a SINGLE section. Do NOT invent sections to look thorough — empty structure is worse than none. Each "heading" is short and descriptive ("How it works", "Tradeoffs"). Each "body" is GitHub-flavored markdown: prose, lists, and a markdown TABLE when comparing options or listing specs.
- "diagram": include ONLY when a visual genuinely aids understanding (a flow, a sequence, a state machine, an architecture). Omit the field entirely when prose is clearer. When present it is RAW mermaid source — a "flowchart", "sequenceDiagram", or "stateDiagram" with at most ~8 nodes. No code fences. Quoting rule by type: in "flowchart"/"graph", wrap each node label in double quotes (e.g. A["Run tests"]); in "stateDiagram", use short bare CamelCase state names with NO quotes (e.g. [*] --> Loading), and only give a state a spaced display name via the alias form: state "Awaiting input" as Awaiting.
- "sources": cite about 5 relevant sources, each with a title and a URL.`;
}

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
 * Validate the raw `primary` field from any provider's activity output against the topics the
 * SAME response suggested. Shared by all three parse sites so the trust boundary lives in ONE
 * place (eng review D10).
 *
 * Defensive by design — the field comes straight from an LLM:
 *  - null / missing / non-object → null (a first-class outcome: no confident pick / keep current)
 *  - `topic` that doesn't match any suggested topic (by topicKey) → null. An unknown key must
 *    never reach the designation machinery — it would dangle against the chip/prefetch caches.
 *  - the CANONICAL topic text from the matched suggestion is returned (never the raw LLM string),
 *    so designation, chips, and the prefetch cache can never desync on identity.
 *  - `reason` trimmed + capped at one strip line; falls back to the suggestion's own reason.
 */
export function normalizePrimary(
  raw: unknown,
  topics: SuggestedTopic[],
): { topic: string; reason: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const topic = typeof rec.topic === 'string' ? rec.topic.trim() : '';
  if (!topic) return null;
  const key = topicKey(topic);
  const match = topics.find((t) => topicKey(t.topic) === key);
  if (!match) return null;
  const rawReason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
  const reason = (rawReason || match.reason).slice(0, PRIMARY_REASON_MAX);
  return { topic: match.topic, reason };
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
 * Normalize text for equality comparison (focus-history de-dup).
 *
 * Lower-cases, trims, and collapses all runs of whitespace to a single space so two
 * narrations that differ only in casing/spacing/line-wrapping compare equal. This is a
 * coarse guard against the activity summarizer re-emitting a near-identical "Current
 * Focus" line; meaningful-progress gating (transcript growth) is layered
 * on top of it in activity.ts.
 */
export function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Validate the `sections` field of a parsed briefing into a clean ResearchSection[]. */
function normalizeSections(raw: unknown): ResearchSection[] {
  if (!Array.isArray(raw)) return [];
  const out: ResearchSection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const body = typeof rec.body === 'string' ? rec.body.trim() : '';
    if (!body) continue; // a section with no body is noise
    const heading = typeof rec.heading === 'string' ? rec.heading.trim().slice(0, HEADING_MAX) : '';
    const section: ResearchSection = { heading, body };
    const diagram = typeof rec.diagram === 'string' ? rec.diagram.trim() : '';
    // Size guard here (parse-time DoS); type allowlist + sanitize happen in MermaidFigure.
    if (diagram && diagram.length <= DIAGRAM_MAX) section.diagram = stripFences(diagram);
    out.push(section);
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

/** Validate the `sources` field of a parsed briefing into a clean ResearchLink[]. */
function normalizeSources(raw: unknown): ResearchLink[] {
  if (!Array.isArray(raw)) return [];
  const out: ResearchLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === 'string' ? (sanitizeUrl(rec.url) ?? '') : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : url;
    out.push({ title, url });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/**
 * Parse a provider's research output into a structured briefing. The model is asked for a JSON
 * object `{ lede, sections, sources }`; this is the ONE place that parsing + validation lives,
 * shared by all three providers (the parseActivityJson pattern, generalized).
 *
 * Defensive by design — the input is raw LLM text:
 *  - strips accidental ```json fences, then tries a direct JSON.parse
 *  - if that fails, extracts the first {...last} object (handles a preamble before the JSON)
 *  - on ANY failure, or when no usable section survives validation, falls back to a SINGLE
 *    section whose body is the raw text and whose heading is the topic. `/research` must never
 *    500 on a malformed model response (cf. the claude-cli-research-500 learning).
 */
export function parseResearchSections(
  raw: string,
  topic: string,
): { lede: string; sections: ResearchSection[]; sources: ResearchLink[] } {
  const fallback = () => ({
    lede: '',
    sections: [{ heading: topic, body: raw.trim() || 'No briefing returned.' }],
    sources: [] as ResearchLink[],
  });

  const cleaned = raw
    .replace(/^```(?:json)?\r?\n?/m, '')
    .replace(/```\s*$/m, '')
    .trim();

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // Preamble or trailing prose around the JSON: extract the outermost {...}.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') return fallback();

  const sections = normalizeSections(parsed.sections);
  if (sections.length === 0) return fallback();

  const lede = typeof parsed.lede === 'string' ? parsed.lede.trim().slice(0, LEDE_MAX) : '';
  return { lede, sections, sources: normalizeSources(parsed.sources) };
}
