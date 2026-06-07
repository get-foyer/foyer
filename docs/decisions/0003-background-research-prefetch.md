# 3. Background research prefetch (warm the cache before the tap)

Date: 2026-06-06
Status: Accepted

North star: [docs/research-prefetch.md](../research-prefetch.md)

## Context

Deep Research was reactive. A suggested-topic chip ([ADR 0001](0001-auto-captured-research-topics.md))
ran `provider.research(topic)` only on tap — a web-search + synthesis call that spawns a CLI
subprocess (Claude CLI / Codex) or hits the Anthropic API and takes ~20s. That ~20s tap-to-result
gap is dead time at exactly the moment Foyer exists to eliminate: the agent's wait.

ADR 0001 deliberately cut a "research all" batch for cost: eagerly materializing every topic into
visible, persisted results spends budget on briefings the user never reads. Eliminating the tap
latency reopens that cost question, so it needs its own decision rather than a quiet reversal.

## Decision

Speculatively **warm a hidden cache** of research results for the top-N topics of the _viewed_
session, so a tap is a reveal, not a request. This is **not** "research all":

1. **Prefetch-to-cache, results stay hidden.** A server-only, in-memory cache
   (`server/prefetch.ts`) holds warmed results WITHOUT calling `addResearch` and WITHOUT touching
   the `inFlightResearch` guard — so the chip stays visible and the result stays hidden until the
   user taps. On tap, `resolveAndStoreResearch` serves the warmed result instantly (or runs live
   on a miss), then stores + broadcasts `research_result` exactly as the legacy path did. The
   client path is unchanged.

2. **Driven off the `/activity` poll (the only "viewed session" signal).** `activeSessionId` means
   "last _started_," not "last _viewed_." The 30s `/activity` poll carries the viewed `sessionId`,
   so prefetch is triggered there and scoped to that session — which also bounds cost.

3. **One global single-flight warm-loop.** At most one speculative `provider.research` runs
   server-wide. It yields while a summary is in flight (`isSummarizing`), supersedes to the
   most-recently-viewed session, and carries a per-session generation token so a late result for a
   closed / reopened / superseded session is discarded. A user tap always bypasses the loop.

4. **Bounded and sheddable.** `FOYER_PREFETCH_TOPICS` (default 3) caps depth; `=0` fully restores
   ADR 0001's reactive behavior — making this a strict superset, not a replacement. A
   consecutive-failure back-off stops re-spawning against a down provider. v1 logs
   `attempted / hit / consumed / wasted` so the speculative spend is visible.

5. **Honest "primed" signal.** A `research_primed` SSE event lights an amber dot on warmed chips.
   The client resets its primed set on every `snapshot` and rebuilds it from a post-snapshot
   replay (injected into `sse.ts` to avoid an `sse → prefetch` cycle), so a dot can never outlive
   the server-side cache it reflects.

This **augments** ADR 0001 (§2 suggest-and-click, §4 no research-all); it does not supersede it.

## Consequences

- Tapping a warmed chip is effectively instant; the ~20s latency only remains on a cache miss
  (live fallback, unchanged behavior).
- Real cost: prefetch spends provider/credit budget on topics that may never be tapped. Mitigated
  by viewed-session-only scope, the top-N cap, single-flight, TTL eviction, and the `=0` off
  switch. The v1 counters exist to decide whether default-on earns its cost.
- Ephemeral by design: warmed results are never persisted (like `inFlightResearch`); a tap
  persists normally. A restart loses the cache — acceptable, and the client's snapshot-reset keeps
  dots honest.
- Known limitations (accepted): yielding is at the boundary (a summary starting mid-research
  overlaps it), and done-session final topics aren't warmed (the client stops polling `/activity`
  when not `working`). See the North Star doc.

Key files: `server/prefetch.ts` (+ `prefetch.test.ts`), `server/config.ts`, `server/state.ts`
(`topicKey`), `server/activity.ts` (`isSummarizing`), `server/index.ts`, `server/sse.ts`,
`src/types.ts`, `src/App.tsx`, `src/hooks/useSSE.ts`, `src/components/ResearchPanel.tsx`,
`src/styles.css`.
