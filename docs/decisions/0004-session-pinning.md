# 4. Session pinning (server-owned, pinned-first ordering)

Date: 2026-06-08
Status: Accepted

## Context

The session sidebar lists every session in start order. As new Claude Code / Codex sessions
pile up, a long-running or "reference" session scrolls down and out of reach — there was no way
to keep one in view. We wanted a per-row "pin to top" affordance with a visual marker, and the
pin had to survive reloads and server restarts (a pin that evaporates on refresh is worse than
no pin).

Three things were genuinely independent and had to be decided separately:

- **Where pin state lives.** The sidebar's order is server-owned: `getAllSessions()` feeds the
  snapshot, and the reducer's `snapshot` action trusts that order. A client-only (localStorage)
  pin would be per-browser and would bolt a client sort layer onto a model where the reducer
  trusts the server. So pin state belongs server-side, mirroring the existing `closed` field and
  the ADR 0002 write-through store.
- **What "most-recently-pinned first" requires.** Pinned rows sort newest-pin-first, which needs
  a persisted **timestamp**, not a boolean.
- **The menu chrome.** The "⋯" trigger needs a floating menu that escapes the sidebar's
  `overflow-y:auto` + the row's `overflow:hidden` clipping, with click-outside / Escape / focus
  handling. A hand-rolled React portal would re-implement a platform built-in.

## Decision

1. **Server-owned `Session.pinnedAt: number | null`** (ms timestamp), persisted exactly like
   `closed`: a `/pin` endpoint (`{ sessionId, pinned }`) mirrors `/close` — `pinSession` /
   `unpinSession` in `state.ts` set/clear `pinnedAt` and `flushNow` (write-through). The store
   serializes the whole `Session`, so the field round-trips for free; `normalizeSession` coerces a
   missing/malformed value to `null`. `/pin` does **not** broadcast — the client updates
   optimistically and the next snapshot reconciles (server timestamp wins), matching `/close`.

2. **One shared ordering rule.** `sortPinnedFirst()` in `src/types.ts` (shared by server and
   client so they can't drift): pinned first by `pinnedAt` **descending** (newest pin first), then
   unpinned by `startedAt` ascending. `getAllSessions()` runs it server-side; the client `pin` /
   `unpin` reducer actions run it optimistically so the row moves on click. Unpinned are ordered by
   `startedAt`, **not** array position — on the server that equals Map insertion order, but on the
   client it's what makes an optimistic _unpin_ drop a row straight back to its chronological slot
   instead of stranding it at the top until the next snapshot.

3. **Native Popover API for the menu**, not a portal (eng-review decision). `popover="auto"`
   renders in the top layer (escapes both clips with zero JS) and gives light-dismiss, Escape,
   focus-return, and one-open-at-a-time for free; CSS anchor positioning places + flips it. We keep
   the ARIA menu semantics (role=menu/menuitem, aria-haspopup/expanded, focus-first-item, arrow
   keys). The `popover` attribute is set imperatively so it doesn't depend on the installed React
   DOM typings.

4. **Marker + grouping.** Pinned rows show a monochrome inline-SVG pushpin (NOT an emoji — DESIGN.md
   bans them) in `--text-dim`, plus a visually-hidden "Pinned" label (status never by glyph/colour
   alone). A 1px register divider separates the pinned group from the rest, rendered only when both
   groups are non-empty. Uses today's pre-Instrument tokens (`--text-dim` / `--border`) pending the
   Instrument palette swap, matching how `jump-to-live` and the primed-dot forward-map.

## Consequences

- Pinning is **order-only**: it never changes `activeSessionId` or `followMode`, and doesn't touch
  the jump-to-live pill (pin = list order; follow = which session is active).
- Pin survives reload and restart (write-through), and is shared across browser tabs (server-owned,
  single source of truth) — unlike a localStorage approach.
- The `⋯` trigger is hover-revealed like the `×` close button ("controls recede"), so it is **not
  reachable on touch** — accepted for a mouse-driven local tool; captured as a TODO.
- A done/interrupted session can still be pinned (pin is status-independent); a closed pinned
  session keeps `pinnedAt` on disk and returns pinned if re-opened.
- Browser support: Popover API + CSS anchor positioning are Baseline 2026; Safari < 18.4 positions
  the menu correctly but loses the auto-flip — acceptable graceful degradation.

## Key files

`src/types.ts` (`pinnedAt`, `sortPinnedFirst`), `server/state.ts` (`pinSession`/`unpinSession`,
sorted `getAllSessions`), `server/store.ts` (`normalizeSession` coercion), `server/index.ts`
(`/pin`), `src/App.tsx` (`pin`/`unpin` reducer + `persistPinnedSession`),
`src/components/{SessionTabs,SessionMenu}.tsx`, `src/styles.css`. Tests: `src/types.test.ts`,
`src/App.reducer.test.ts`, `server/state.test.ts`, `src/components/SessionTabs.test.tsx`.
