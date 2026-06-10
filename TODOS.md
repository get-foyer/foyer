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

## Codex research-tier: give research its own reasoning effort

- **What:** Split the codex provider's single `FAST_FLAGS` so `research()` uses its own
  `RESEARCH_FLAGS` (`model_reasoning_effort=medium`, env-overridable via `FOYER_CODEX_RESEARCH_EFFORT`),
  instead of sharing the low-effort tier with the high-frequency `summarizeActivity` call.
  Mirrors the Claude side, where research is pinned to Sonnet while the summariser stays on Haiku.
- **Why:** Research is low-frequency, user-initiated, and its briefing is the thing the user actually
  reads — synthesis quality matters more than for the trivial hot-path calls. Codex research currently
  runs at `low` effort (same as the trivial calls), so the briefing quality is capped.
- **Pros:** Better codex briefings; full symmetry with the Claude provider's per-call-type tiering.
- **Cons:** Higher cost/latency per codex research call; the quality gain is unvalidated (codex research
  already works, this is polish, not a bug fix).
- **Context:** `FAST_FLAGS` is at `server/providers/codex.ts:47`; both calls (`summarizeActivity`,
  `research`) currently spread it. Only `research()` should switch to `RESEARCH_FLAGS`. The Claude
  analog shipped in the `claudeCli.ts` research-timeout fix
  (`RESEARCH_MODEL` + `FOYER_CLAUDE_CLI_RESEARCH_MODEL`). ~15m human / ~5m CC.
- **Depends on / blocked by:** None. Independent polish.

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

## Fix the `handleTranscriptChange` interleaving race

- **What:** In the transcript turn-end watcher, `m.lastWatchedOffset` is updated _after_ the
  `await readTranscriptFrom(...)` (`server/activity.ts`, in `handleTranscriptChange`). Two rapid
  `fs.watch` `change` events can interleave at that await: both read from the same stale offset,
  double-process the overlapping content, and the offset can regress. Fix by updating the offset
  before the await (or guarding the handler with an in-flight flag per session).
- **Why:** Correctness of the turn-end / ESC-interrupt detector. Today the damage is bounded —
  `finishSession` is status-guarded and idempotent, so a double-process just re-detects the same
  turn end harmlessly — which is why it's deferred, not fixed now.
- **Pros:** Removes a real race from the watcher; makes the offset bookkeeping trustworthy if the
  watcher is ever extended.
- **Cons:** Concurrency-correctness work on a path that is benign today; needs a test that simulates
  interleaved change events.
- **Context:** Surfaced by the Codex outside voice during the live-summary-poll review. The poll fix
  deliberately does NOT depend on this watcher (it polls transcript size instead), so this is isolated
  cleanup. `handleTranscriptChange` is in `server/activity.ts`. ~20m human / ~6m CC.
- **Depends on / blocked by:** None. Independent of the live size-poll (shipped separately).

## Global cap on concurrent summarisation calls

- **What:** `run()`'s single-flight is per-session, not global. With many simultaneously `working`
  sessions all growing their transcripts, the 5s live size-poll (`runLiveSummaryPass`) can fan out up
  to N concurrent `provider.summarizeActivity` calls each tick. Add a global concurrency cap / queue
  if this ever matters.
- **Why:** Protects a local CLI provider (each call spawns a `claude -p` / `codex exec` subprocess)
  from being swamped when many agents run at once.
- **Pros:** Predictable provider load under heavy multi-session use.
- **Cons:** Pure speculation for a solo-dev tool — realistic concurrent-working-session counts are
  1-3, and the pre-existing PostToolUse path already has the same per-session-only property. Premature
  to build now.
- **Context:** Surfaced as a failure mode in the live-summary-poll eng review (accepted, deferred).
  Would live alongside the single-flight guard in `server/activity.ts`. Trigger to act: provider
  slowness observed with many concurrent sessions. ~1-2h human / ~20m CC.
- **Update (2026-06-10, ADR 0005):** a reference implementation of exactly this pattern now exists —
  the per-session PRIMARY-warm pump in `server/prefetch.ts` (`schedulePrimaryWarm` /
  `pumpPrimaryWarms`) enforces a global concurrency cap (`FOYER_PRIMARY_WARM_CONCURRENCY`, default 2)
  with glance-priority ordering. The summarisation fan-out (`runLiveSummaryPass`) is still uncapped;
  copy that pump shape if it ever needs the same guard.
- **Depends on / blocked by:** None.

## Touch-reachable session controls (⋯ and ×)

- **What:** A touch-reachable way to open the per-row options (`⋯`) menu and the close (`×`)
  button. Both are hover-revealed (`opacity:0` until `.session-tab-row:hover`), so on a tablet /
  touch laptop with no hover they can't be reached — which means pinning and closing are
  unreachable on touch.
- **Why:** Pinning (ADR 0004) and closing are useful actions that are simply unavailable without a
  mouse. The hover-reveal keeps rows calm per DESIGN.md ("controls recede"), the right default for
  the terminal-native, mouse-driven user, but it shouldn't be the _only_ path.
- **Pros:** Pin/close work on touch; no silent dead-ends on tablets.
- **Cons:** Adds persistent chrome (always-visible controls) or a long-press handler that fights
  "controls recede" — likely over-building for a near-entirely mouse-driven local dashboard.
- **Context:** Both controls live in `SessionTabs.tsx` (`.session-tab__menu`, `.session-tab__close`)
  and share the `.session-tab-row:hover { opacity:1 }` reveal in `src/styles.css`. Options when it
  matters: keep the controls visible under `@media (pointer: coarse)`, or add a long-press
  affordance. From plan-eng-review D3 (deferred in favour of the mouse-driven happy path). ~2h
  human / ~25m CC.
- **Depends on / blocked by:** Session pinning (shipped, ADR 0004). Needs evidence the dashboard is
  actually used on touch devices before it's worth the chrome.

## Cover the reconnect-replay + menu-open paths CI can't reach

- **What:** Add tests for two interaction surfaces the current suite structurally cannot reach:
  (a) `SessionMenu` open/close + `aria-expanded` mirroring + focus-first + ArrowUp/Down cycling —
  jsdom has no Popover API (`togglePopover` is undefined), so `SessionTabs.test.tsx` only reaches
  menu items via `{ hidden: true }`; (b) `server/sse.ts` reconnect replay — there is no `sse.test.ts`,
  so the `getPrimedTopics`/`getWarmingTopics` re-light loops on connect are emit-untested (the client
  reducer for those events IS covered in `App.reducer.test.ts`). Also worth a thin `POST /prefetch`
  and `/pin` route test (400/503/pin-vs-unpin branch).
- **Why:** These are the glue where a silent regression ships green. The replay is the documented
  "single source of truth" for re-lighting dots/rings after a reconnect/restart.
- **Pros:** Closes the two confidence-9 coverage gaps from the pinning/warming review.
- **Cons:** Popover-in-jsdom needs `togglePopover`/`hidePopover` stubs + a synthetic `toggle` event;
  some ceremony for a local single-user tool.
- **Context:** Surfaced by the eng review of this PR (testing specialist). `SessionMenu.tsx:45-79`,
  `server/sse.ts:31-74`, `server/index.ts` route handlers. ~1-2h human / ~20m CC.
- **Update (2026-06-10, ADR 0005):** part (b) — server-side SSE reconnect replay — is now covered by
  `server/integration.test.ts` (a fresh `/events` connection re-derives primary state from the
  snapshot, over a real HTTP stream). The primed/warming chip re-light loops still lack a dedicated
  emit test, and part (a) — the `SessionMenu` Popover-in-jsdom gap — remains untouched.
- **Depends on / blocked by:** None. Pure test addition.

## MCP-backed DocSource for SaaS doc tools (Notion / Linear / Jira / Confluence)

- **What:** One MCP client implementing the `DocSource` interface (`server/docsources/`) so briefing
  doc-discovery can reach cloud doc tools through MCP servers the user already runs — search-at-warm-time,
  snippet-only results — instead of four bespoke connectors.
- **Why:** Live Learning Briefing v1 (ADR 0005) indexes local files only. Most engineering teams keep
  ADRs/notes in Notion, Linear, Jira, or Confluence; local-only caps the briefing wedge at solo/indie
  repos.
- **Pros:** One client covers all four tools; auth lives in the user's MCP server config, not Foyer
  code; no bespoke connector suite (rejected as ocean-scope in the eng review).
- **Cons:** Per-server search-tool-name mapping isn't standardised; headless OAuth for some MCP servers
  is fiddly; cloud content reaching the LLM provider needs the per-source consent + egress-note model
  (D20) extended before launch.
- **Context:** Live Learning Briefing eng review D5/D20 (2026-06-10). The `DocSource` seam is designed
  for this: `list()/search → { path-or-url, title, snippet, mtime }`. Reactive search-at-warm-time
  (derive 2-3 queries from session topics), never workspace pre-indexing. ~1-2 weeks human / ~half-day CC.
- **Depends on / blocked by:** `DocSource` interface + per-source consent model (shipped in ADR 0005).

## Re-entry packet at turn end (Approach C)

- **What:** When an agent stops or blocks, show a short "get back in" packet: what changed, what you
  were learning, what to review, the next decision.
- **Why:** Directly attacks "I forgot what this task was." Approach C in the Live Learning Briefing
  design doc; the Codex outside voice argued re-entry (not reading) may be the real attention-leak fix.
  The documented pivot path if briefing dogfooding shows status-glancing dominates reading.
- **Pros:** Reuses the turn-end watcher, activity summaries, touched-areas signal, and primary
  lifecycle from ADR 0005; more action-oriented than passive reading.
- **Cons:** Drifts toward review tooling where larger platforms are also moving; depends on reliable
  transcript/diff interpretation.
- **Context:** Design doc Approach C + eng review D23 (2026-06-10). Trigger to act: dogfooding shows
  primary briefings unread while status glances dominate. ~1 week human / ~2-3h CC.
- **Depends on / blocked by:** Live Learning Briefing (shipped, ADR 0005).

## Sidebar briefing-ready mark (evidence-gated)

- **What:** A monochrome, shape-based "briefing ready" mark on sidebar session rows (pin precedent:
  neutral glyph + visually-hidden label — never amber, since sidebar amber = live).
- **Why:** ADR 0005 shows the primary strip only for the viewed session; a background session's ready
  briefing is invisible until you switch. Warm-on-switch carries the multi-session value for now, but
  if ready briefings keep being discovered late, the glance story needs this mark.
- **Pros:** Full across-the-desk glance story for multi-session warming; amber stays pure.
- **Cons:** A fourth sidebar row mark (live dot, unseen badge, pin) — row-noise risk, which is why
  it's evidence-gated.
- **Context:** Design review D6 (2026-06-10). Trigger to act: dogfooding shows missed-ready
  frustration. ~3h human / ~20m CC.
- **Depends on / blocked by:** Live Learning Briefing (shipped, ADR 0005).

## Clickable doc citations (open-in-editor, security-gated)

- **What:** Make the primary strip's cited-doc references (plain readout text in v1) clickable —
  opening the doc via a new endpoint that resolves ONLY through the `DocSource` index.
- **Why:** The natural strip→doc jump. Deliberately deferred because a path-opening endpoint on the
  localhost server is a real security surface: index-only resolution, no raw paths, origin-guarded,
  its own threat-model pass. **Do not build this casually.**
- **Pros:** One-click from "read this" to reading it.
- **Cons:** New server attack surface; needs path-validation + threat-model work exceeding the feature
  itself.
- **Context:** Design review D14 (2026-06-10) — citations ship as non-interactive readouts to honour
  "never a dead control" without smuggling in an unreviewed endpoint. Trigger: dogfooding shows
  strip→doc friction. ~half-day human / ~30m CC incl. tests.
- **Depends on / blocked by:** `DocSource` index (shipped, ADR 0005); blocked by its own security review.

## Popover API fallback for unsupported browsers

- **What:** `SessionMenu` toggles the native Popover imperatively (`popRef.current?.togglePopover?.()`),
  which silently no-ops where the Popover API is absent — leaving the ⋯ menu (pin/unpin) unopenable.
  Add a feature-detect (`'popover' in HTMLElement.prototype`) with a JS-toggled `.session-menu`
  display + manual outside-click/Escape fallback.
- **Why:** ADR 0004 deliberately bet on Baseline-2026 Popover support, which is correct for the
  terminal-native user on a current browser — but a hard no-op is a silent dead-end on anything older.
- **Pros:** Pin/unpin never silently dead; keeps the native path for the common case.
- **Cons:** Re-implements light-dismiss/focus-return that the platform gives for free; likely
  over-building unless an unsupported browser actually shows up. Revisit only if it does.
- **Context:** From the pinning review (frontend specialist). `src/components/SessionMenu.tsx:39-79`.
  ~2h human / ~25m CC.
- **Depends on / blocked by:** Session pinning (shipped, ADR 0004).
