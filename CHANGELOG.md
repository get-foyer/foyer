# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-06-09

### Security

- **DNS rebinding protection.** Foyer's local HTTP daemon now rejects requests whose `Host`, `Origin`, or `Sec-Fetch-Site` headers prove the request came from a cross-origin page. Without this, a malicious website could read your agent sessions and prompts via a DNS rebinding attack. Non-browser clients (Claude Code hooks) are unaffected — they send no `Origin` and a localhost `Host`, so they pass untouched.
- **URL sanitization for LLM-sourced links.** Citations and web search results returned by AI providers (Anthropic, Codex, Claude CLI) are now stripped of `javascript:`, `data:`, `vbscript:`, and other non-HTTP schemes before they reach the browser. A compromised or hallucinating model can no longer inject executable URLs into the research panel.
- **Session ID validation.** Incoming `sessionId` values are now validated at both the HTTP layer (route handlers) and the hooks entry point — path traversal characters, oversized values, and non-alphanumeric input are rejected before they touch any in-memory or on-disk state.

### Changed

- **Express app extracted for testability.** Route handlers are now in `server/app.ts` (`createApp()`), separate from the boot logic in `server/index.ts`. This makes the HTTP layer fully testable with supertest without starting a real server.

## [Unreleased]

### Fixed

- **Research "ready" dot no longer lies.** An amber-dotted topic chip now always opens its
  briefing instantly instead of sometimes showing a ~20s loading spinner. The warmed briefing
  used to expire on a 15-minute timer (and got dropped when a topic slipped below the top-3
  prefetch budget) while the dot stayed lit, so tapping a stale dot fell through to a fresh live
  search. A prefetched briefing is a point-in-time answer, not perishable state, so it now lives
  exactly as long as its chip is on screen — the dot and the cached result stay in lockstep.

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
