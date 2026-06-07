# TODOS

Deferred work, captured with enough context to pick up cold.

## Temp-peek + lock follow mode

- **What:** A hybrid follow model on top of the shipped hard-hold: clicking a tab is a
  _temporary_ peek that your next prompt auto-releases (resumes follow), PLUS a lock control
  for a _hard_ hold that survives new prompts.
- **Why:** Under pure hard-hold (current behavior), you must click FOLLOW after every peek to
  resume tracking your live terminal. If that feels tedious in daily use, the hybrid removes the
  friction while keeping an explicit lock for when you really want to pin a view.
- **Pros:** Lower friction for the common "glance then keep working" loop; keeps an escape hatch.
- **Cons:** A third follow state + extra UI to reason about on a single-user dashboard; only worth
  it if hard-hold proves annoying in practice.
- **Context:** Builds directly on the `followMode` machine in `src/App.tsx` (the `active`/`follow`/
  `select` reducer cases) and `FollowControl`. From devex-review decision D-hold (option C, declined
  in favor of pure hard-hold for v1). ~½ day human / ~1h CC.
- **Depends on / blocked by:** The "Follow the live channel" feature (shipped in this PR).

## Watch: hidden trivial turns extending the workflow storyline

- **What:** When a turn is trivial (workflow hidden), the summarizer still gets `previousGraph`
  fed back and _could_ append a low-value phase node, so a later multi-phase turn shows a slightly
  noisy storyline. Watch for this in dogfooding; if it appears, gate graph-extension on
  `showWorkflow` (don't feed `previousGraph` / don't accept new nodes on a hidden turn).
- **Why:** Keeps the storyline a clean glanceable fingerprint. Deferred because the prompt already
  forbids tool-call nodes and returns null for trivial work, and the 6-node cap bounds any noise —
  so the real-world risk is low and a guard now would be premature.
- **Pros:** Removes a possible source of storyline clutter at its root.
- **Cons:** Extra branching + tests in the hot summarize path for a problem that may never occur.
- **Context:** From ADR 0004 (conditional workflow graph). The decision logic lives in
  `setActivity` (`server/state.ts`) and the prompt in `buildActivityPrompt` (`server/providers/codex.ts`).
  Trigger to act: storyline shows nodes that don't correspond to substantive phases. ~1h human / ~15m CC.
- **Depends on / blocked by:** ADR 0004 (shipped in this PR). Needs dogfooding evidence first.

## Auto-surface waiting / permission sessions

- **What:** Optionally move the view to a background session that becomes blocked on you (permission
  prompt / idle), instead of only lighting the waiting dot + unseen badge.
- **Why:** When you're idle and a background agent needs input, auto-surfacing it cuts the time the
  agent sits blocked.
- **Pros:** Less wasted agent wait time; turns the dashboard into an attention router, not just a
  follower.
- **Cons:** Different concern from interaction-recency focus; needs a "don't yank while I'm actively
  prompting elsewhere" guard or it fights the follow model.
- **Context:** Would hook the `waiting` path (`server/hooks.ts` onNotification → `broadcast('waiting')`)
  to an opt-in client behavior, distinct from the `active` focus signal. Deliberately a non-goal of
  the "Follow the live channel" feature. ~1 day human / ~1-2h CC.
- **Depends on / blocked by:** The follow/hold model (shipped); should not override an explicit hold.
