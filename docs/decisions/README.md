# Architecture Decision Records

Non-trivial architecture decisions in Foyer Gate are recorded here as ADRs
([Michael Nygard format](https://github.com/joelparkerhenderson/architecture-decision-record):
**Context / Decision / Consequences**).

The repo ADR is the canonical, shared source of truth — read it for the _why_ before
changing a decision. ADRs are immutable once **Accepted**: you supersede an old one with a
new record, you don't rewrite history.

## Convention

- One file per decision: `NNNN-kebab-title.md`, zero-padded sequential number.
- Front matter: `# N. Title`, then `Date:` and `Status:` (Proposed / Accepted / Superseded by #M).
- Sections: **Context** (the forces at play), **Decision** (what we chose and why),
  **Consequences** (what becomes easier/harder, trade-offs accepted, what's out of scope).
- End with a **Key files** line so the next reader can find the code.
- Add a pointer row under `## Architecture decisions` in `CLAUDE.md` so every agent session
  auto-loads awareness.

## Index

- [0001 — Auto-captured research topics (suggest-and-click)](0001-auto-captured-research-topics.md)
- [0002 — Session persistence (JSON-file store)](0002-session-persistence.md)
- [0003 — Background research prefetch (warm the cache before the tap)](0003-background-research-prefetch.md)
- [0004 — Conditional workflow graph (folded into Current Focus)](0004-conditional-workflow-graph.md)
