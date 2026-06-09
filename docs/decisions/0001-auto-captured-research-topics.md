# 1. Auto-captured research topics (suggest-and-click)

Date: 2026-06-05
Status: Accepted

## Context

The Deep Research panel required a waiting user to type a research topic into a text box
before they could learn anything. That is friction at the worst moment: Foyer exists to
turn agent wait-time into useful time, and a blank input box is a cold start that competes
with the very context-switch we are trying to prevent.

We already had everything needed to remove that friction:

- `provider.research(topic)` works on all three backends (Codex, Claude CLI, Anthropic API).
- `summarizeActivity(ctx)` already feeds the agent's prompt, file edits, and transcript tail
  to the LLM and parses structured JSON (`{summary}`) behind cost guards
  (single-flight, 8s debounce, skip-if-unchanged).

## Decision

Derive research topics automatically from the agent's work and present them as clickable
chips; remove the manual input box entirely.

1. **Topics ride the existing `summarizeActivity` call.** We widened its output to
   `{summary, topics}` (`SuggestedTopic = {topic, reason}`) rather than adding a
   separate LLM call. Zero extra cost/latency, reuses all orchestration. Topic extraction
   is inference-only — no web search (the web search stays in `research()`).
   - One prompt change (`buildActivityPrompt`) and one shared parser (`normalizeTopics` in
     `server/providers/text.ts`) cover all three providers.
   - `previousTopics` is fed back each tick (mirroring `previousGraph`) so chips stay stable
     unless the focus shifts.

2. **Interaction is suggest-and-click.** Chips carry a one-line `reason` (provenance).
   Clicking runs the existing `research()`. No auto-research, no "research all".

3. **Server-side in-flight guard against a click/tick race.** A chip's research runs
   5-30s; an activity tick during that window must not re-surface the same topic (it isn't
   in `session.research` yet). `server/state.ts` keeps a per-session, server-only Set of
   in-flight research topics (never serialized to client or disk). `setActivity` excludes
   topics that are already researched OR in flight; `/research` no-ops if a `(session,
topic)` is already running; `addResearch` clears the flag and drops the chip.

4. **No manual input box.** Suggestions are the only entry point. A custom-topic escape
   hatch and a "research all" batch were explicitly cut.

## Consequences

- New friction removed: topics surface from real work, one click to a briefing.
- The panel needs honest empty states (the box is gone): generating (spinner),
  ready-but-empty, and idle/no-provider (no spinner — don't imply work).
- All three providers stay in lockstep via the shared prompt + `normalizeTopics`.
- Persistence of topics/research across restarts is a separate, sequenced change
  (see the session-persistence decision) and is NOT part of this one.
- Trade-off accepted: chips regenerate each activity tick. Churn is mitigated by
  `previousTopics` (stability) + the in-flight/researched filters.

Key files: `src/types.ts`, `server/providers/{index,text,codex,claudeCli,anthropicApi}.ts`,
`server/providers/schema/activity.schema.json`, `server/state.ts`, `server/activity.ts`,
`server/index.ts`, `src/App.tsx`, `src/components/ResearchPanel.tsx`.
