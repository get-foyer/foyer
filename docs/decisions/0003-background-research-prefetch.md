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

## Addendum — 2026-06-08: warm in `waiting`/`done`, not just `working`

Extends §2, lifting the accepted limitation in Consequences ("done-session final topics aren't
warmed … the client stops polling `/activity` when not `working`"). In practice the viewed
session is usually `waiting` (paused for permission) or `done` — the prime read-window — so
gating warming on `working` meant the amber dot rarely appeared at all.

Warming is now **decoupled from summarising**. `/activity` still does both for `working`
sessions (summarising tracks live activity). A new prefetch-only endpoint, `POST /prefetch`,
runs the warming half _without_ `summarizeNow`; the client fires it one-shot per
(session, status, topic-set) when it lands on a `waiting`/`done` session that has chips. We did
not reuse `/activity` for idle sessions on purpose: `run()`'s skip-if-unchanged guard doesn't
cover sessions with no transcript path, so re-polling `/activity` could re-summarise finished
work and burn provider calls. Warming itself is unchanged — still idempotent, single-flight,
top-N-capped, back-off-guarded, and `FOYER_PREFETCH_TOPICS=0` still fully disables it.

Added files/changes: `server/index.ts` (`/prefetch` route), `src/App.tsx` (idle-warm effect).

## Addendum — 2026-06-08: live summarisation via a server-side transcript size-poll

Records a change to the **summarise trigger model** (the other half of the split this ADR drew
between summarising and warming). Until now, `summariseActivity` fired only on Claude Code hooks
(`UserPromptSubmit`, `PostToolUse` on `Write|Edit|MultiEdit`, `ExitPlanMode`, `Stop`) or the 30s
`/activity` poll for the _viewed_ tab. Claude Code emits **no hook for assistant text messages**, so
when the agent produced a text response (reasoning, explaining, answering) without a file-writing
tool call, nothing told the server to re-read the transcript — the Current Focus panel froze until
the next tool call or the coarse viewed-tab poll. Users "stared at old data."

Fix: a 4th trigger — `startLiveSummaryPoll()` in `server/activity.ts`. Every `LIVE_POLL_MS` (5s) it
iterates all `working` sessions with a known transcript path and, if the transcript file grew since
the last summary, fires `run()`. It reuses the existing `startStaleSessionWatcher` loop shape
(factored into a shared `eachWorkingSessionWithTranscript` generator) and `run()`'s existing cost
guards (skip-if-unchanged, single-flight). A cheap byte-size growth pre-check in the pass guards the
start-of-session window where the transcript file briefly doesn't exist, so it never fires
empty-context calls.

Why a poll and not the existing `fs.watch` (`handleTranscriptChange`): an engineering review with a
Codex outside voice found the watcher too fragile to build a trigger on — `recordTranscriptPath`
restarts it at EOF on every call (dropping entries written in the gap), it may never start for a
pure-text turn (no retry if the file is absent at `UserPromptSubmit`), and a trailing debounce can
starve under continuous writes. The poll sidesteps all three and leaves `fs.watch` as the turn-end /
ESC-interrupt detector it already is. Consequence: every `working` session now re-summarises on
transcript growth even when unviewed (consistent with the existing PostToolUse path, and the point of
a glanceable focus history); bounded by the per-session skip-if-unchanged + single-flight guards.

Added files/changes: `server/activity.ts` (`LIVE_POLL_MS`, `eachWorkingSessionWithTranscript`,
`runLiveSummaryPass`, `startLiveSummaryPoll`), `server/index.ts` (start the poll),
`server/activity.test.ts`.

## Addendum — 2026-06-08: surface the in-flight warm (`research_warming`)

Extends §5 ("honest primed signal"). Until now the only client-visible prefetch state was the
terminal `ready` one (the amber primed dot); the `queued → running → ready` lifecycle never
surfaced "being pre-fetched right now," so a user watching a chip got no feedback during the
~20s warm. We now broadcast a `research_warming` SSE event — `{ active: true }` when an entry
enters `running`, `{ active: false }` when it leaves `running` (success **or** failure/stale),
so the signal can never get stuck lit. Single-flight means at most one topic is `running`
server-wide, keeping the signal rare (amber stays "signal, not paint").

The client tracks `warmingTopics` as an exact sibling of `primedTopics` — same
reset-on-`snapshot` + post-snapshot replay discipline (`getWarmingTopics` injected into
`sse.ts`, mirroring `getPrimedTopics`). On `research_primed` the client settles the ring into
the dot atomically (independent of the trailing `active: false`). Visual: a pulsing **hollow
amber ring** that fills into the solid primed dot — distinct from primed by **shape**, so it
survives `prefers-reduced-motion` (DESIGN.md decisions-log 2026-06-08).

Added files/changes: `server/prefetch.ts` (`research_warming` broadcasts, `getWarmingTopics`),
`server/sse.ts` (warming replay), `server/index.ts` (wire `setWarmingTopicsProvider`),
`src/types.ts` (`SseType`), `src/App.tsx` (`warmingTopics` reducer state),
`src/components/ResearchPanel.tsx`, `src/styles.css` (`.research-chip__warming`).

## Addendum (2026-06-08): one unified list + server-owned read state

The rail had two stacked regions — suggested-topic chips and a separate "Ready to read" block of
completed briefings. They are now **one list** in a single section (no second header), ordered
unread-ready → suggested → read; row state, not a label, carries the "it's ready to read" message.

This also fixed a signal leak: the old ready-list kept its amber dot on a briefing forever, even
after it was read, eroding "amber = rare live/ready signal" (§5, "honest primed signal"). To make
"ready to read" honest we added server-owned read state: `ResearchResult.readAt` (mirroring
`pinnedAt` / ADR 0004 — optimistic client dispatch + write-through `POST /research/read` +
`flushNow` + reconcile on next snapshot, no SSE). An unread briefing shows a solid amber dot at full
strength; once opened it dims (`--text-dim`) with a **hollow dim ring (no amber)** and sinks to the
bottom — distinct by shape AND colour, reusing the warming/primed shape language so it never relies
on colour alone. "Read" is defined as "shown in the Research tab", marked by one client effect that
covers rail taps, the primed instant-reveal, and tab switches uniformly.

Added/changed: `src/types.ts` (`ResearchResult.readAt`), `server/state.ts` (`markResearchRead`,
`flushNow`), `server/index.ts` (`POST /research/read`), `src/App.tsx` (`mark_research_read` action,
`postKeepalive` helper, `persistResearchRead`, mark-read effect),
`src/components/ResearchPanel.tsx` (unified list), `src/styles.css` (`.research-list`,
`.research-ready-row--read`).
