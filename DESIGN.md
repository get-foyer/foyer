# Design System — Foyer Lobby · "Instrument"

> **Read this before any visual or UI change.** Every color, font, spacing, radius,
> and motion value below is canonical. Do not deviate without explicit approval; if
> you do, add a row to the Decisions Log at the bottom.

---

## Product Context

- **What this is:** A local dashboard that turns Claude Code's 3–5 min agent waits into
  focused, in-context time. Hooks stream session events to `localhost:4317`; the UI
  renders the current task, a live "what the agent is doing now" summary, a workflow
  graph, live file touch points, and a deep-research panel.
- **Who it's for:** Developers running Claude Code / Codex — terminal-native power users.
- **Space:** Developer tools / agent observability.
- **Project type:** Local web-app dashboard (Vite 6 + React 18, runs beside a terminal).

## The Memorable Thing

**Serious instrument — designed for the glance, not the click.**

Foyer Lobby is the _instrument cluster for your agent_: a warm-black control panel of
fine monospace labels and tabular readouts, with a single signal-amber LED that lights
up only when work is happening — legible at a glance from across the desk.

This reframes the whole product. Almost every dev dashboard is built for _operating_
(click, configure, navigate) and converges on blue-on-cold-black. Foyer Lobby is the rare
tool you **watch while waiting**, so it's built like a control panel: status is the hero,
the controls recede, and run-state reads from peripheral vision.

**Every design choice must serve this.** When in doubt: is this a readout or a signal? If
it's neither, it's decoration — cut it.

## Aesthetic Direction

- **Direction:** Industrial / Instrument (control-room meets precision synth panel).
- **Decoration level:** Intentional — the "decoration" is technical-drawing language
  (module index labels, hairline register rules, corner ticks, tabular readouts), never
  ornament. No gradients-as-paint, no blobs, no glassmorphism.
- **Mood:** Calm, precise, "on." Like a mixing desk or cockpit — everything has its place,
  nothing shouts, but the live channel glows.
- **Reference north stars:** Teenage Engineering (fine technical microtype, one signal
  color, precise grid), Warp (warm restraint, dense terminal product), Linear (calm
  density, color reserved for data/status), Ghostty (terminal-native chrome).

---

## Typography

One industrial superfamily — **IBM Plex** — does everything. Mono and Sans are siblings,
so they harmonize by construction. This replaces Mona Sans entirely (kills the GitHub tell).

| Role                                          | Font              | Notes                                                          |
| --------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| Wordmark, hero readouts, big numerals         | **IBM Plex Mono** | 500–600 weight; `tabular-nums`; the instrument-cluster voice   |
| Module labels / UI chrome                     | **IBM Plex Mono** | 11px, **uppercase**, `letter-spacing: 0.13em`                  |
| Data — file paths, timestamps, counts, code   | **IBM Plex Mono** | always `font-variant-numeric: tabular-nums` for readouts       |
| Body prose — summary, research, plan markdown | **IBM Plex Sans** | the one place we relax into a sans so paragraphs don't fatigue |

- **Loading:** Google Fonts.
  `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap`
  (Add `<link rel="preconnect">` to `fonts.googleapis.com` + `fonts.gstatic.com`.)
- **Font stacks:**
  ```css
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  ```
- **Scale (px):**

  | Token   | Size   | Use                                      |
  | ------- | ------ | ---------------------------------------- |
  | display | 28–40  | hero duration readout (mono, tabular)    |
  | h1      | 18     | markdown h1                              |
  | h2      | 16     | markdown h2                              |
  | prompt  | 14.5   | task header prompt                       |
  | body    | 14     | prose, summaries                         |
  | label   | 11     | module labels (mono, uppercase, +0.13em) |
  | data    | 11–12  | paths, timestamps (mono, tabular)        |
  | micro   | 9.5–10 | counts, ts, badges (mono)                |

- **Line-height:** prose 1.6–1.72; data/labels 1.2–1.4.

---

## Color

Restrained, near-monochrome **warm-dark + one signal accent**. Color is signal, not paint.
The single strongest differentiator: **warm umber-ink canvas, not GitHub's cold blue-black.**

### Dark (default — the design)

```css
/* Canvas — warm umber-ink enclosure */
--bg: #0e0c0a;
--surface: #17130e; /* module face */
--surface-2: #211b14; /* raised: inputs, tags, chips */
--border: #2c2620; /* hairline */
--border-2: #3d352c; /* stronger hairline / focus rings / corner ticks */

/* Text — warm paper-white */
--text: #f3eee4;
--dim: #a79c8b;
--muted: #7c7264; /* ≥4.5:1 on --bg — keep AA when changing */

/* SIGNAL — the one amber LED (the brand accent) */
--signal: #ffb020;
--signal-hi: #ffc44d; /* hover / glow peak */
--signal-glow: rgba(255, 176, 32, 0.5);

/* Status spectrum (instrument-coded) */
--working: #ffb020; /* = signal: in-progress / live channel */
--waiting: #ff6a3d; /* hotter orange-red: blocked on user */
--done: #4ade9e; /* phosphor green (NOT GitHub green) */
--error: #ff5c5c;
--link: #6fd0dc; /* quiet phosphor cyan — interactive, keeps amber pure as "signal" */

/* Primary action — a backlit keycap */
--primary: #ffb020;
--on-primary: #1a1206; /* dark text on amber */

/* Tool-tag hues — desaturated, label-like (not candy) */
--t-write: #4ade9e; /* green  */
--t-edit: #6fd0dc; /* cyan   */
--t-bash: #ffb020; /* amber  */
--t-read: #b79cf0; /* muted violet */
```

### Light (draft — fast-follow, not yet shipped)

Tokens are structured so light is a clean semantic remap (a warm-paper enclosure, same
amber signal). Captured here so it's ready; **dark-first ships now.**

```css
[data-theme='light'] {
  --bg: #f4eee3;
  --surface: #fbf7ef;
  --surface-2: #ece4d5;
  --border: #ddd3c0;
  --border-2: #c8bba2;
  --text: #211b12;
  --dim: #6b6253;
  --muted: #8a8170;
  --signal: #c87000;
  --signal-hi: #e08400; /* darker amber for AA on paper */
  --working: #c87000;
  --waiting: #d8501c;
  --done: #1f9d63;
  --error: #cf3b3b;
  --link: #1c7e8c;
  --primary: #c87000;
  --on-primary: #fff6e8;
  --t-write: #1f9d63;
  --t-edit: #1c7e8c;
  --t-bash: #c87000;
  --t-read: #6e52c8;
}
```

### Usage rules

- **Amber is rare and means "signal."** Use it for: the live/working state, the active
  graph node, the focus ring, the primary action, the ON-AIR bezel, module index numbers.
  Never as a fill or a background wash beyond ~4–13% tints.
- **Interactive ≠ amber.** Links/info use `--link` cyan so amber stays pure signal.
- **Color carries hierarchy only via status.** Text hierarchy comes from weight + size +
  the `text / dim / muted` ramp, not hue.
- **Contrast:** keep all text ≥ 4.5:1 (AA) on its background; `--muted` is the floor.

---

## Spacing

- **Base unit:** 4px. (Instruments are tight and precise; 8px reads too loose for this density.)
- **Density:** compact-but-breathing — generous _outer_ margins (16–18px), tight _inner_
  data rows (6–8px).
- **Scale:** `2 · 4 · 8 · 12 · 16 · 24 · 32 · 48`.

## Layout

- **Approach:** grid-disciplined. Keep the existing strong bones — session sidebar (~232px)
  · task-header readout strip · main column + right rail (`minmax(0,1fr) / 380px`).
- **Panels are "modules."** Each module header is a channel strip:
  `<amber index> · <UPPERCASE MONO NAME> · <count/badge right-aligned>` —
  `01 · CURRENT FOCUS`, `02 · TOUCH POINTS`, `03 · RESEARCH`.
- **Module detailing:** 1px hairline border + small `border-2` **corner ticks** (top-left /
  top-right L-marks) for the technical-drawing feel.
- **Max content width:** dashboard fills the viewport; do not center-cap.
- **Border radius (crisp — a deliberate break from the old soft 6px):**
  ```css
  --radius-sm: 2px; /* tags, inputs, chips */
  --radius: 4px; /* modules, panels, buttons */
  --radius-lg: 6px; /* rare, large surfaces only */
  /* full 9999px reserved for status dots only */
  ```

## Motion

- **Approach:** minimal / mechanical. Instruments don't bounce.
- **Defaults:** 120–160ms fades, `ease-out` (or linear for "readout updating" feel). No spring.
- **The ONE signature:** a slow ~2s amber **breathing pulse** on the live channel
  (working status LED, active graph node, live session dot) + the **ON-AIR lit bezel**
  (a thin amber hairline glow across the top of the whole frame while the agent is working,
  so run-state reads from peripheral vision).
- **Touch points** stream in with a fast ~200ms slide — a readout incrementing, not a flourish.
- **Easing tokens:** enter `ease-out` · exit `ease-in` · move `ease-in-out`.
- **Duration tokens:** micro 50–100ms · short 120–160ms · medium 200–300ms · pulse ~2000ms.
- **Always honor `prefers-reduced-motion`** (the existing CSS already disables pulses/spinners/slides).

## Instrument Detailing (the signature kit)

These are what make it read as a purpose-built instrument, not a reskinned web app:

1. **Module index labels** — `01·02·03·04` in amber + uppercase mono name (channel strips).
2. **Hairline register system** — 1px warm rules between modules; small corner ticks.
3. **The ON-AIR lit bezel** — amber top-hairline glow + header LED while working.
4. **Tabular everything** — durations, timestamps, counts, the `mm:ss` readout in tabular mono.
5. **Warm-black enclosure** — faint top vignette so the canvas reads like an anodized body.

---

## Accessibility

- Maintain WCAG **AA** (4.5:1) for all text; the existing `--muted` was tuned for this — re-verify
  after any palette change, especially on the warm canvas.
- `:focus-visible` → 2px `--signal` outline, 2px offset.
- All motion gated behind `prefers-reduced-motion: reduce`.
- Status is never conveyed by color alone — pair every status color with a label/glyph
  (badge text, ✓ on done, LED + word).

## Implementation Notes

- The app already uses CSS custom properties in `src/styles.css` — this is a **token swap +
  structural detailing**, not a rewrite. Map old → new vars:
  `--bg/--surface/--surface-2/--border/--border-light → border-2`, `--text/--text-dim/--text-muted`,
  `--accent → --link` (cyan) and **promote `--working` amber to `--signal`** as the brand accent,
  `--primary/--primary-hover → amber keycap`, tool tags `--write/--edit/--bash/--read → --t-*`,
  `--radius 6px → 4px`, `--font-sans → IBM Plex split into --font-mono / --font-sans`.
- Swap the font `<link>` in `index.html` (remove `@fontsource/mona-sans`, add IBM Plex).
- Add module index labels to each `.panel__title`, the corner ticks, and the ON-AIR bezel
  (`.app::before` amber hairline, shown only in working state).

---

## Decisions Log

| Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-06-05 | Adopted the "Instrument" design system (bold departure from GitHub Primer)                                                                                                                                                                                                                                                                                                                                                | Current UI was a GitHub-Primer clone with no identity of its own; `/design-consultation` + research (Warp/Linear/TE/Ghostty) + a faithful rendered preview                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-06-05 | Warm umber-black canvas (`#0E0C0A`), not cold blue-black                                                                                                                                                                                                                                                                                                                                                                  | Strongest, cheapest differentiator from the blue-on-black dev-tool sea; reads as an instrument enclosure                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-06-05 | One signal-amber accent (`#FFB020`), cyan for links                                                                                                                                                                                                                                                                                                                                                                       | Color = signal, not paint; amber as a lit LED is the ownable signature; cyan keeps amber pure                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-06-05 | IBM Plex Mono + IBM Plex Sans (chose over Geist single-mono, Martian two-mono, JetBrains)                                                                                                                                                                                                                                                                                                                                 | One industrial superfamily → guaranteed harmony + genuine control-room heritage; picked from a rendered 4-system specimen                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-06-05 | Crisp 2/4px radius (from soft 6px) + ON-AIR lit bezel signature                                                                                                                                                                                                                                                                                                                                                           | Reinforces "precise instrument"; bezel serves the glance-from-across-the-desk core job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-06-05 | Dark-first; light theme captured as draft fast-follow                                                                                                                                                                                                                                                                                                                                                                     | Tool lives beside a terminal — dark is home; best effort-to-quality ratio, tokens structured for a clean light add                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-06-06 | "Jump to live" pill (supersedes the FOLLOW / HELD control)                                                                                                                                                                                                                                                                                                                                                                | "Follow the live channel": following is the silent default; a contextual amber pill ("↓ <session> is live — Jump") appears at the top of the sidebar only when a tab is held and a different session goes live (chat "jump to present" pattern). Replaced the persistent FOLLOW/HELD control, which tested as confusing (one widget = status light + toggle + jump button; disabled-vs-enabled affordance; "HELD" jargon). Reuses `--working` amber pending the Instrument `--signal` swap; entrance gated behind `prefers-reduced-motion`.                              |
| 2026-06-06 | Amber "primed" dot on a research chip with a warmed (prefetched) result                                                                                                                                                                                                                                                                                                                                                   | Signal-amber = "ready/live": a 6px dot tells the user at a glance which taps are instant (background prefetch, ADR 0003). A readout, not decoration. The chip's blue `--accent` hover stays the "interactive" cue so amber stays pure signal; reuses `--amber` pending the Instrument `--signal` swap.                                                                                                                                                                                                                                                                   |
| 2026-06-07 | "01 · CURRENT FOCUS" renders a continuous chronological focus-timeline (oldest at top, newest pinned at the bottom, live entry carries the amber rule + "LIVE" label, stick-to-bottom auto-scroll) instead of "latest summary big + older snapshots hidden behind a collapsed Previously toggle".                                                                                                                         | User could not follow the session's accumulated narration: only the latest short summary showed, and history was two clicks deep (open Previously, then expand each card). Now every snapshot is visible at once as a transcript; per-turn dividers appear once history spans more than one turn. Collapses the dual-scroll content+footer into one scroll region; drops FocusHistory/FocusCard.                                                                                                                                                                         |
| 2026-06-08 | Session pinning: a hover-revealed `⋯` row menu (the app's first popover — native Popover API, top-layer) with Pin/Unpin; pinned rows lift to the top marked by a monochrome SVG pushpin (`--text-dim`, NOT an emoji) + a visually-hidden "Pinned" label, with a 1px register divider above the unpinned group.                                                                                                            | Long-running sessions scrolled out of reach. The marker can't be signal-amber (reserved for live/ready) and must read as distinct from the active row's cyan `--accent` bar, so it's a neutral monochrome glyph + label (status never by colour/glyph alone). The `⋯` recedes like the `×` close button. Native popover escapes the sidebar's overflow clip and gives dismiss/Escape/focus free. Current tokens pending the Instrument `--signal`/`--dim` swap. (ADR 0004)                                                                                               |
| 2026-06-08 | Pulsing **hollow amber ring** on a research chip whose prefetch is in flight ("warming"), which fills into the existing solid primed dot when ready.                                                                                                                                                                                                                                                                      | Surfaces the in-progress prefetch (ADR 0003 addendum) the primed dot couldn't. Motion = "work happening now" (the one signature breathing pulse); hollow-fills-to-solid is a literal readout of warming → ready. Distinct from the primed dot by **shape**, not just motion/colour — so under `prefers-reduced-motion` the pulse stops but the ring (hollow) still reads as ≠ primed (solid), honouring "status never by colour/motion alone". Single-flight keeps it rare (≤1 at a time), so amber stays signal. Reuses `--amber` pending the `--signal` swap.          |
| 2026-06-08 | Deep Research rail is **one unified list** (briefings + suggested-topic chips in a single section, ordered unread-ready → suggested → read), replacing the separate "Ready to read" block. A completed briefing is "ready to read" (solid amber dot, full-strength) until opened, then "read" (dimmed `--text-dim`, **hollow dim ring, no amber**). Read state is server-owned (`readAt`, mirroring `pinnedAt`/ADR 0004). | One section, not a header, carries the "it's ready" message — the same launcher the user already scans. Critically, amber must turn **off** once a briefing is read: the old ready-list kept its amber dot forever, eroding "amber = rare live/ready signal". Read vs unread is distinguished by **shape AND colour** (hollow dim ring vs solid amber dot), reusing the warming/primed shape language so it never depends on colour alone. Surfacing unread-ready briefings first honours the prefetch north star ("the briefing is already there"). (ADR 0003 addendum) |
| 2026-06-08 | Removed the workflow storyline (the mermaid `graph LR` folded into `01 · CURRENT FOCUS`). Current Focus is now narration + timeline only; research diagrams are unaffected.                                                                                                                                                                                                                                               | The graph was the one element that wasn't a reliable readout: the prompt was its only classifier, it had no eval harness, and its accuracy/value were never validated — so it failed "every element is a readout or a signal, never decoration." Cheaper to remove than to keep paying LLM tokens to draw a storyline most turns hid. The earlier "folded into Current Focus" decision (former ADR 0004) is superseded by this removal.                                                                                                                                  |
