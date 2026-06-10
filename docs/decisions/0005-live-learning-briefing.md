# 5. Live Learning Briefing (one primary read per session)

Date: 2026-06-10
Status: Accepted

Design doc: office-hours `dennischia-feat-security-server-refactor-design-20260610` (Approach D).
Builds on [ADR 0001](0001-auto-captured-research-topics.md) (suggested topics) and
[ADR 0003](0003-background-research-prefetch.md) (prefetch / warm-before-the-tap).

## Context

Deep Research surfaced a flat list of topic chips ([ADR 0001](0001-auto-captured-research-topics.md))
and warmed them in the background ([ADR 0003](0003-background-research-prefetch.md)). But the
product promise is "turn the 3-5 minute agent wait into focused, in-context time," and a list of
equal-weight chips makes the user choose what to read — at exactly the moment their attention is
fracturing. The observed failure mode is the attention leak: during the wait the user opens browser
tabs, drifts to social media, or starts a second task and loses the thread of the first.

The sharper wedge: while the agent works, give the user **one** recommended read — the best thing to
understand right now for this exact workstream — already warming when they glance over. The chips
become secondary follow-ups. This is bounded, task-specific learning, not generic research.

## Decision

Each active session gets ONE **primary briefing** — a designation over the existing research
machinery, selected by the activity LLM, warmed in the background, rendered as the integrated top
band of the `02 · DEEP RESEARCH` module.

1. **Primary is a designation, not a new object** (eng review D8). `Session.primary =
{ topic, reason, status, since, readyMs, failures, docs }` points at a topic; the briefing BODY
   lives in `research[]` under the same `topicKey`, and read-state is the shared `readAt`. One
   source of truth — the strip is a view over existing structures, never a parallel copy.

2. **The LLM picks; a pure module decides** (eng review D6, design DR7). `summarizeActivity` returns
   a `primary` proposal alongside `summary`/`topics`; `normalizePrimary` validates it against the
   same response's topics (an unknown/hallucinated topic → null, never reaches designation). The
   pure `server/ranking.ts` `decidePrimary` applies the **sticky rule**: keep the current primary
   unless the model proposes a _different_ topic (the meaningful-shift signal); `null` means keep.
   A READ primary demotes to a read row on the next pick (read is not terminal). Dismissed topics
   are never re-proposed.

3. **Per-session warming with a global cap** (eng review D3/D17). Unlike the chip loop
   (viewed-session-only, single-flight), the PRIMARY of every active session warms so the
   glance-over works for sessions you are not watching. Bounded by a global concurrency cap
   (`FOYER_PRIMARY_WARM_CONCURRENCY`, default 2), glance-priority queue order (viewed first, then
   working newest-first), each runner yielding to its session's live summary. Per-warm
   time-to-ready is logged (the starvation metric) and frozen onto the designation as `readyMs`.
   Completion is the SAME path as a tap: `addResearch` + `research_result`, then the designation
   flips ready (`primary` SSE event).

4. **Honest degraded states** (eng review D7, design DR8/DR9). `null` primary is a first-class
   outcome (no strip; the extractive readout shows true local data — touched areas + matched docs —
   when there's something real, otherwise nothing). Two warm failures → an error readout with a
   manual retry, never an eternal ring. A "NOT USEFUL" dismiss excludes the topic for the session,
   logs the rejection (`dismissals.jsonl`, the dogfood usefulness signal), and promotes the
   next-ranked candidate.

5. **Restored touched-areas signal, server-side only** (eng review D4/D14). The Live Files panel
   stays removed; only the DATA returns. `server/touched.ts` aggregates PostToolUse file paths to
   directory level in memory (no per-tool-call I/O); the summarize tick is the flush point.

6. **Pluggable doc discovery, local v1** (eng review D5/D20). `server/docsources/` defines a
   `DocSource` interface; `LocalDirSource` snippet-indexes the session repo's docs (default-on —
   repo content already reaches the provider) plus user-configured external dirs
   (`FOYER_DOC_DIRS`, explicit per-source consent + a UI egress note). Only title + first-paragraph
   snippets leave the machine; full bodies never enter a prompt. A local top-K keyword preselection
   (`ranking.selectSnippets`, ≤8 on summarize ticks / ≤30 on briefing calls) bounds the hot-path
   token cost regardless of index size. MCP-backed SaaS sources are the designed-for follow-up
   (TODOS.md).

7. **The strip is a readout band, not a card** (design DR4). It is the module's top band with a
   3px left status rail and one hairline divider, never a bordered card nested in the bordered
   module. Precedence comes from position + rail + type weight. The reason line is always the LLM's
   specific why-now (no static subtitle); citations are plain readout text (not controls);
   per-state tabular readouts (warming = live elapsed, ready = frozen time-to-ready, error =
   failure count). Amber budget: the strip owns the module's only glow (the ready LED) plus the
   sanctioned amber keycap; every LED is paired with its state word.

## Consequences

- The product moment works: prompt an agent, glance at Foyer, the one recommended read is already
  there (or warming). Multi-session warming makes it work across parallel agents, bounded by the
  cap; the time-to-ready log tells us whether cap=2 actually holds the wait window before we raise
  it.
- Quality is the bet (deliberately untested in v1, eng review D12): briefing specificity is judged
  by dogfooding, with the dismissal log as the structured signal. A golden-fixture eval is a
  captured follow-up, triggered if prompt iteration starts churning.
- The strip changes DESIGN.md: two new system rules — "one glow source per module" and "an LED is
  always paired with its state word" (decisions log 2026-06-10).
- Old session files load fine: the new `Session` fields are optional and default to absent/null.
  Old-shape provider output (no `primary` field) parses unchanged (`normalizePrimary(undefined)` →
  null) — a guarded regression.
- Accepted residuals: cap starvation at 5+ simultaneous sessions is _measured_, not prevented
  (raise the cap on evidence); a doc snippet can mislead when the decisive detail is mid-document.

Key files: `server/touched.ts`, `server/docsources/{index,local}.ts`, `server/ranking.ts`,
`server/dismissals.ts`, `server/state.ts` (primary mutators), `server/prefetch.ts`
(`schedulePrimaryWarm`), `server/activity.ts` (signal-gather → rank → designate),
`server/providers/{index,text,codex,claudeCli,anthropicApi}.ts` + `schema/activity.schema.json`,
`server/app.ts` (`/primary/dismiss`, `/primary/retry`), `server/sse.ts`/`index.ts` (wiring),
`src/types.ts`, `src/App.tsx`, `src/components/{PrimaryBriefingStrip,ResearchPanel}.tsx`,
`src/styles.css`. Tests: `server/{touched,ranking,primary.state,primary.prefetch,integration}.test.ts`,
`server/docsources/local.test.ts`, `server/providers/primary.text.test.ts`,
`src/components/PrimaryBriefingStrip.test.tsx`, `src/App.reducer.test.ts`.
