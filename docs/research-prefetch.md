# North Star — Background Research Prefetch

> The durable "why" for research prefetch. Point-in-time implementation decisions live in
> [ADR 0003](decisions/0003-background-research-prefetch.md); this is the ideal end-state every
> decision serves.

## "The briefing is already there."

By the time you wonder about a topic, the answer is already waiting. Research warms in the
background during the agent's wait, so tapping a suggested-topic chip is a **reveal**, not a
**request**. Foyer never makes you wait twice — once for the agent, then again for the
research. The wait itself is the prefetch window.

## Five principles (the tie-breakers when designs conflict)

1. **The tap is a reveal, not a fetch.** A primed tap shows content effectively instantly
   (<150ms to first paint). If a tap still spins, prefetch failed at its one job.
2. **Speculative, never presumptuous.** We _warm_, we don't _auto-publish_. Results stay
   hidden until the user asks (preserves [ADR 0001](decisions/0001-auto-captured-research-topics.md)'s
   suggest-and-click). No "research all," no results the user didn't choose.
3. **The live channel always wins.** Prefetch is background work that _yields_ to the thing
   the user is actually watching (the live activity summary). Never slow the primary signal to
   warm a speculative briefing. (Yielding is at the boundary — see Known limitations.)
4. **Spend the wait, not the user's trust.** Prefetch spends real provider/credit budget on
   topics that may never be tapped. Keep it bounded (viewed session, top-N) and always
   sheddable — `FOYER_PREFETCH_TOPICS=0` restores pure reactive behavior. Cost discipline is a
   feature, not an afterthought; v1 logs `attempted / hit / consumed / wasted` so the spend is
   visible.
5. **Felt first, shown second.** Speed is the product; the amber "primed" dot is the honest
   readout that the instrument is ready — a signal, never decoration (per `DESIGN.md`).

## Anti-goals

- Auto-researching every topic (the "research all" ADR 0001 deliberately cut).
- Degrading live summaries to warm a briefing.
- Unbounded or global speculative spend.
- A primed dot that lies — claiming "ready" when the cache is cold, expired, or gone.

## How it works (one paragraph)

The `/activity` poll is the only server-side signal of which session you're viewing. When it
fires, the top `FOYER_PREFETCH_TOPICS` suggested topics for that session are queued into a
single global, single-flight warm-loop (`server/prefetch.ts`) that runs one `provider.research`
at a time, yielding while a summary is in flight and superseding to whichever session you most
recently viewed. Warmed results sit in a server-only cache — never `addResearch`, never the
`inFlightResearch` guard — so the chip stays visible and the result stays hidden. On tap,
`resolveAndStoreResearch` serves the warmed result instantly (or runs live on a miss), then
stores + broadcasts exactly as before. A `research_primed` SSE event lights the chip's amber
dot; the client rebuilds its dot set from the reconnect replay so a dot can never go stale.

## Known limitations (v1, accepted)

- **Mid-research summary overlap.** Yielding is at the boundary only — a summary that starts
  after a research subprocess has spawned will overlap it. Single-flight + short summaries keep
  this to one-vs-one and rare.
- **Done-session chips don't prefetch.** ~~The client stops polling `/activity` when a session
  isn't `working`, so a session's _final_ topics never trigger a warm; those chips fall back to
  the live path.~~ **Resolved 2026-06-08** ([ADR 0003 addendum](decisions/0003-background-research-prefetch.md)):
  warming is decoupled from summarising — a `waiting` or `done` session with chips warms once via
  a prefetch-only `POST /prefetch` trigger, so its final topics light up too.

## Addendum — 2026-06-10: the primary briefing layer (ADR 0005)

The chip warm-loop above stays exactly as described — viewed-session-only, single-flight, the
secondary follow-up surface. On top of it, [ADR 0005](decisions/0005-live-learning-briefing.md)
adds a recommendation layer: each active session gets ONE **primary briefing** — the best thing to
read right now — selected by the activity LLM and warmed in the background so it's already there
when you glance over.

Two things make the primary's warming different from the chip loop, and they are deliberate:

- **Per-active-session fan-out, not viewed-only.** The glance-over moment must work for the
  sessions you are _not_ watching, so every active session's primary warms. The fan-out is bounded
  by a global concurrency cap (`FOYER_PRIMARY_WARM_CONCURRENCY`, default 2) with glance-priority
  ordering (viewed session first, then working newest-first), and each runner still yields to its
  own session's live summary — the ADR 0003 latency rule is preserved per session.
- **Completion is the same data path as a tap.** A warmed primary lands via `addResearch` +
  `research_result` (a real unread briefing, one source of truth), and the designation flips to
  `ready` (a `primary` SSE event). The chip loop's hidden-cache trick is for speculative chips that
  may never be tapped; the primary is the recommended read, so its briefing is materialised.

Per-warm time-to-ready is logged (the starvation metric) and shown on the strip as `ready · mm:ss`.
Whether cap=2 actually holds the 3-5 minute wait window at 5+ simultaneous sessions is an open
question the metric exists to answer before the cap is raised.
