# CLAUDE.md — Foyer Gate

## Design System

**Always read `DESIGN.md` before making any visual or UI change.**

All fonts, colors, spacing, radius, motion, and the "Instrument" aesthetic direction are
defined there and are canonical. The one-line essence: warm-black instrument enclosure,
a single signal-amber LED, IBM Plex Mono + IBM Plex Sans, crisp corners, designed for the
glance — every element is a readout or a signal, never decoration.

Do not deviate from `DESIGN.md` without explicit user approval. If a change is approved,
add a row to the Decisions Log at the bottom of `DESIGN.md`. In QA/review, flag any code
that doesn't match `DESIGN.md`.

## Testing

- Run all tests: `npm test` (Vitest, `vitest run`).
- Type-check: `npx tsc --noEmit` — note: `npm run build` is `vite build` (esbuild) and does
  NOT type-check, so run tsc separately.
- Lint: `npm run lint` (ESLint + Prettier).

## Architecture decisions

Non-trivial architecture decisions are recorded as ADRs in [`docs/decisions/`](docs/decisions/)
(Nygard format: Context / Decision / Consequences). The repo ADR is the canonical, shared
source of truth — read it for the "why" before changing a decision; supersede, never rewrite.

- [0001 — Auto-captured research topics (suggest-and-click)](docs/decisions/0001-auto-captured-research-topics.md)
- [0002 — Session persistence (JSON-file store)](docs/decisions/0002-session-persistence.md)
- [0003 — Background research prefetch (warm the cache before the tap)](docs/decisions/0003-background-research-prefetch.md) · north star: [docs/research-prefetch.md](docs/research-prefetch.md)
- [0004 — Conditional workflow graph (folded into Current Focus)](docs/decisions/0004-conditional-workflow-graph.md)
