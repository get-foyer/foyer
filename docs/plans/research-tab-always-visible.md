# Plan — Always show the Research tab + first-class empty state

## Intent

Today the Focus / Research view-tab strip only appears once the active session has at
least one briefing (`App.tsx:658` — `showViewTabs = research.length > 0`). Make the
Research tab always available for an open session, and give it a designed empty state
instead of the current dead-code fallback.

## What already exists

- **The empty state is already written but unreachable.** `ResearchTab.tsx:41-55` renders
  a `research-tab--empty` branch ("No briefings yet — tap a topic in Deep Research to start
  reading"). It's dead code because App never mounts the Research view without briefings.
- **`.research-tab--empty` CSS already exists** (`styles.css:1308`) — centered flex.
- **`.panel__empty` / `.panel__empty-glyph` styling** (`styles.css:764`) — the `◱` glyph,
  `--text-dim` / `--text-muted`, centered. Reuse as-is.
- **The right-rail launcher already varies by activity status** — `ResearchPanel`'s
  `ResearchEmptyState` (`ResearchPanel.tsx:188-207`) already does the generating / ready /
  idle three-way honesty. The tab empty state should mirror it, not reinvent it.
- **View tab a11y is already correct** — `ViewTabs` is a WAI-ARIA automatic-activation
  tablist (roving tabindex, arrow/Home/End). The empty `ResearchTab` branch already carries
  `role="tabpanel"` + `aria-labelledby`.

## The core problem this plan must solve

The existing empty-state CTA — "tap a topic in Deep Research" — points at the Deep Research
launcher, which lives in the **right rail of the Focus view**. That rail is NOT rendered when
you're standing in the Research view. So the empty state instructs the user to tap something
that isn't on screen. A dead-end CTA. "Add an empty state" is really "make this state
reachable, honest, and actionable from where the user is standing."

## Design (Instrument-true)

Gate change: `showViewTabs = !!activeSession` (always-on per open session, not gated on
briefings). Tabs never render over the no-session shell.

Empty Research tab = a status-aware first-class state, mirroring `ResearchEmptyState`'s
three branches, placed in the full-width reading surface:

### Variant 1 — has suggested topics, no briefings (the common case)

```
┌─ FOCUS ─┬─ RESEARCH ────────────────────────────────────────────┐  view-tabs (RESEARCH
│         │▔▔▔▔▔▔▔▔▔                                                │  active: amber underline,
├─────────┴────────────────────────────────────────────────────────┤  existing .view-tab--active)
│                                                                    │
│                          ◱                          (--text-dim)   │
│              No briefings yet — start one below.    (--text-muted) │
│                                                                    │
│     ┌────────────────┐ ┌─────────────────┐ ┌───────────────┐      │  reuse research-chip
│     │ vite ssr config●│ │ react hydration │ │ esbuild vs ……  │      │  ● existing primed amber
│     └────────────────┘ └─────────────────┘ └───────────────┘      │    dot (no NEW amber)
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

The chips are the same `research-chip` launcher already used in the right rail, surfaced here
so the action lives on screen. No on-screen duplication: the rail isn't rendered in this view.

### Variant 2 — generating (topics being derived)

```
│                       ⟳  (spinner spinner--sm)                     │
│              Surfacing topics from your session…                   │
```

### Variant 3 — idle / no provider / ran-but-empty (honest signpost, no chips)

```
│                          ◱                                         │
│  provider missing → "Research is off until an LLM provider is set  │
│                      up — run `foyer setup`."                      │
│  idle/ready-empty → "Briefings open here as you dig into topics.   │
│                      Topics appear as the agent works."            │
```

### Invariants

- **No new amber.** Glyph stays `--text-dim`; only the existing primed/warming chip dots
  (already-shipped "ready/live" signals) carry amber. The Research tab's own amber underline
  (active channel) and the unseen ready-dot (never true at zero briefings) are unchanged.
- **Status never by colour alone** — every state pairs glyph/spinner + words (DESIGN.md a11y).
- Empty state collapses to a single centered `panel__empty` (no index column when there's
  nothing to index) — current `.research-tab--empty` behaviour, kept.

## NOT in scope

- Redesigning the right-rail Deep Research launcher — untouched.
- The full-width reading surface layout (index + article) — only the empty branch changes.
- Light theme — dark-first ships; tokens already remap.

## Resolved decisions (design review)

| #   | Decision                                    | Choice                                      | Why                                                                                                                                                                                                |
| --- | ------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D3  | Empty-state primary action (topics present) | **Surface `research-chip` launcher inline** | Old CTA pointed at the right-rail launcher, hidden in the Research view — a dead-end. Chips on screen make the action self-contained. No on-screen duplication (rail isn't rendered in this view). |
| D4  | Tab visibility gate                         | **`showViewTabs = !!activeSession`**        | "Always show" taken literally. Defensible against the Instrument ethos because the chips decision means the tab is never a dead control — it's always a launcher or an honest status readout.      |
| —   | New amber?                                  | **None**                                    | Glyph stays `--text-dim`; only the already-shipped primed/warming chip dots carry amber. Keeps amber pure signal.                                                                                  |
| —   | Mockup format                               | **Token-true ASCII** (above)                | Instrument system is already canonical in `styles.css`; the AI generator doesn't know IBM Plex / warm-umber / corner-ticks.                                                                        |

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~10min / CC: ~3min)** — `App.tsx` — Flip the view-tab gate to always-on
  - Surfaced by: Pass 7 / D4 — `showViewTabs = (research.length ?? 0) > 0` → `!!activeSession`
  - Files: `src/App.tsx:658` (and verify the now-redundant `&& showViewTabs` guard on `view` at :659-660 and `focusPanelProps` at :662-664 still behave — tabpanel role is now always correct)
  - Verify: open a fresh session with no research → Focus + Research tabs both show; `npm test` (ViewTabs/App tests green)

- [ ] **T2 (P1, human: ~45min / CC: ~10min)** — `ResearchTab.tsx` — Make the empty branch a status-aware first-class state
  - Surfaced by: Pass 2 / D3 — replace the single flat "tap a topic in Deep Research" message (`ResearchTab.tsx:41-55`) with three variants mirroring `ResearchEmptyState` (`ResearchPanel.tsx:188-207`): (1) has topics → lede + inline `research-chip` launcher, (2) generating → spinner, (3) idle/no-provider → honest signpost. Pass `suggestedTopics`, `activityStatus`, `sessionId`, `primedTopics`, `warmingTopics`, and the research POST handler through to `ResearchTab` (or extract the chip list into a shared component used by both panels).
  - Files: `src/components/ResearchTab.tsx`, `src/App.tsx` (new props at the `ResearchTab` render site ~:793), possibly extract `src/components/ResearchChips.tsx` from `ResearchPanel`
  - Verify: empty Research tab with topics shows clickable chips that start a briefing; provider-missing shows `foyer setup` copy; generating shows spinner; no NEW amber introduced

- [ ] **T3 (P2, human: ~15min / CC: ~5min)** — `ResearchTab.test.tsx` — Cover the three empty variants
  - Surfaced by: Pass 2 — the empty branch was dead code with no live test; it's now reachable
  - Files: `src/components/ResearchTab.test.tsx`
  - Verify: tests assert chips render in the topics case, spinner in generating, signpost in idle/no-provider; `npm test`

- [ ] **T4 (P3, human: ~5min / CC: ~2min)** — `DESIGN.md` — Add a Decisions Log row
  - Surfaced by: CLAUDE.md rule — visual change to an always-on tab + empty state needs a logged decision
  - Files: `DESIGN.md` (Decisions Log)
  - Verify: row records always-on Research tab + chips-in-empty-state + amber-stays-pure rationale

_No new tasks from Pass 4 (AI Slop) — one build guardrail noted (no decorative illustration), no separate task._

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status                | Findings                                     |
| ------------- | --------------------- | ------------------------------- | ---- | --------------------- | -------------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 1    | CLEAR (2026-06-07)    | not run for this plan; small UI change       |
| Codex Review  | `/codex review`       | Independent 2nd opinion         | 0    | —                     | not run (focused scope chosen)               |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 0    | NOT RUN for this plan | required gate before ship                    |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 1    | CLEAR                 | score 5/10 → 9/10, 4 decisions, 0 unresolved |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 0    | —                     | n/a (internal dashboard)                     |

- **UNRESOLVED:** 0
- **VERDICT:** DESIGN CLEARED (9/10). Eng review required before implementation — this plan adds props threading from `App.tsx` into `ResearchTab` (T2), which eng review should validate. Run `/plan-eng-review` next.
