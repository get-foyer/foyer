# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **Live Files** panel (the `02 · TOUCH POINTS` module). File operations are no longer
  streamed (`touch` SSE event), stored (`Session.touchPoints`), or fed into the Current
  Focus summarizer. A value audit found the panel only mattered during a run and drowned
  in tool-call noise; file context already lives in the agent transcript the summarizer
  reads, so the narration is unchanged. Old session files load fine (the dropped field is
  ignored).

## [0.1.0] - 2026-06-08

Initial public release.

### Added

- Local focus-and-learning dashboard that turns the 3–5 minute "agent is working"
  wait into focused, in-context time.
- Pluggable LLM backends (Claude CLI, Codex, Anthropic API) selected at setup.
- `foyer` CLI with a guided `setup` wizard and `uninstall` flow.
- Auto-captured research topics — the research panel derives topic chips from agent
  work, no input box ([ADR 0001](docs/decisions/0001-auto-captured-research-topics.md)).
- Session persistence via a JSON-file store with interrupted-recovery, focus-history,
  and retention safeguards ([ADR 0002](docs/decisions/0002-session-persistence.md)).
- Background research prefetch that warms the cache for waiting/done sessions before
  the tap ([ADR 0003](docs/decisions/0003-background-research-prefetch.md)).
- Session pinning — pin sessions to the top via a row menu, server-owned `pinnedAt`
  ([ADR 0004](docs/decisions/0004-session-pinning.md)).
- "Instrument" design system (warm-black enclosure, signal-amber LED, IBM Plex
  Mono + Sans) — canonical spec in [DESIGN.md](DESIGN.md).
- Local-first security model: binds to `127.0.0.1`, no auth, credentials stored under
  `~/.config/foyer/config.env` ([SECURITY.md](SECURITY.md)).

[Unreleased]: https://github.com/getfoyer/foyer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/getfoyer/foyer/releases/tag/v0.1.0
