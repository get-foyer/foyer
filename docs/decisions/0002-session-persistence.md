# 2. Session persistence (JSON-file store)

Date: 2026-06-06
Status: Accepted

## Context

All session state lived in an in-memory `Map` in `server/state.ts` and was lost on every
restart. The motivating feature was focus history (ADR 0001's sibling): retained "Current
Focus" snapshots are only useful if they survive a restart. But persistence is broader than
one feature — touchpoints, research, prompts, and the focus timeline all live on the same
`Session` aggregate, so the right move was a reusable persistence standard, not a one-off.

Foyer ships as an npm package run locally by a single user. That shapes the backend choice:
the workload is whole-aggregate read/write with no cross-session queries, and install
friction is an adoption tax we must avoid.

## Decision

**A write-through `SessionStore` (`server/store.ts`) that the in-memory Map backs onto.**
The Map stays the synchronous read model; mutators mark a session dirty and a debounced
flusher writes it through. This is the standard future persisted state follows.

1. **Backend = one JSON file per session**, in a per-user data dir
   (`~/.foyer-gate/sessions/<sha256(id)>.json`, override `FOYER_DATA_DIR`) — never the npm
   install dir. **Not SQLite:** `better-sqlite3` is a native module (node-gyp install
   failures kill adoption) and `node:sqlite` needs Node 22.5+ and prints an experimental
   warning. JSON is a perfect fit for this workload and installs everywhere with zero deps.
   One file per session gives corruption isolation, bounded per-flush writes, and prune = unlink.

2. **Aggregate persistence, not normalized tables or event sourcing** — the app never queries
   across sessions, so normalization would be mapping boilerplate for no benefit.

3. **Synchronous store API** (`writeFileSync`) so `state.ts` never goes async. Writes are
   atomic (temp file + `renameSync` — readers never see a partial file). Dir is `0700`,
   files `0600`.

4. **Path-safe filenames:** `sha256(sessionId)`. `session_id` is hook input; a raw
   `<id>.json` could contain `/` or `..` and escape the dir. The real id rides in the envelope.

5. **Recovery on hydrate.** Parse → `normalizeSession()` over `newSession()` defaults (a
   session persisted before `focusHistory`/`turnSeq` existed still loads, gated by a
   `SCHEMA_VERSION` envelope) → demote a live `working`/`waiting` session to a new terminal
   **`interrupted`** status (the owning server is gone) and reset a stale
   `activityStatus: 'generating'` (which would otherwise spin the UI forever) → retention-prune
   → sort by `startedAt`. A corrupt file is skipped with a warning, never crashing boot.

6. **Never bricks the tool.** An unwritable data dir falls back to a no-op store
   (in-memory only). Persistence failure is logged, never fatal.

7. **Retention** (new concern persistence introduces): keep the 50 most recent sessions;
   prune terminal sessions older than 14 days on boot.

8. **Close is durable, not destructive.** Dismissing a tab persists a `closed` flag
   (`POST /close` → `closeSession`); the snapshot filters closed sessions out so they stay
   dismissed across restarts, but their data is kept on disk (reversible), not deleted.

## Consequences

- Focus history, sessions, touchpoints, and research survive restarts.
- A session that was mid-run when the server died comes back as `interrupted` (terminal,
  muted styling), not a forever-spinning "working" card.
- Closing a tab now sticks across reloads/restarts.
- **Known limitation (accepted, documented):** `getSession()`/`getAllSessions()` return live
  mutable refs; a caller mutating one without a `state.ts` mutator won't `markDirty`.
  Convention: mutate only via mutators. The shutdown flush (`flushAll` on SIGINT/SIGTERM)
  catches most drift. Clone-on-read was rejected as over-engineering for a local single-user tool.
- **Out of scope:** SQLite, normalized schema, cross-session query UI, multi-instance
  concurrency, encryption-at-rest (perms `0600` only — revisit if Foyer ever goes multi-user).

## Shipping

Sequenced as PR2, on top of the focus-history PR1 (which locked the `FocusEntry`/`Session`
shape so this PR only adds persistence, no model migration).

Key files: `server/store.ts`, `server/state.ts`, `server/config.ts`, `server/index.ts`,
`src/types.ts` (`SessionStatus` + `closed`), `src/components/{TaskHeader,SessionTabs}.tsx`,
`src/App.tsx`.
