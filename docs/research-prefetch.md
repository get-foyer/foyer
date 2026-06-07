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
- **Done-session chips don't prefetch.** The client stops polling `/activity` when a session
  isn't `working`, so a session's _final_ topics never trigger a warm; those chips fall back to
  the live path. The feature targets the wait, and the user has returned by the time it's done.
