# Contributing to Foyer Gate

## Prerequisites

- **Node 22** (see `.nvmrc`; use `nvm use` or install from [nodejs.org](https://nodejs.org))
- **pnpm** (`npm i -g pnpm` or via [pnpm.io/installation](https://pnpm.io/installation))
- A configured LLM backend — run `pnpm setup` if you haven't already

## Getting started

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts two processes in parallel:

| Process                      | Port     | Purpose                                                   |
| ---------------------------- | -------- | --------------------------------------------------------- |
| Express server (`tsx watch`) | **4317** | Receives Claude Code hooks, SSE stream, research endpoint |
| Vite dev server              | **5173** | React app with HMR                                        |

**Open the dashboard at `http://localhost:5173`** (not `:4317`, which serves the production build). The Vite proxy forwards `/hook`, `/events`, `/research`, and `/api` to the Express server automatically.

## Data flow

```
Claude Code session
  → POST /hook   (server/hooks.ts)
  → in-memory state  (server/state.ts)
  → SSE broadcast    (server/sse.ts)
  → useSSE hook      (src/hooks/useSSE.ts)
  → reducer dispatch (src/App.tsx)
  → panel renders    (src/components/)
```

LLM calls (graph generation, research) are routed through the provider abstraction in `server/providers/`, which has three implementations: `codex.ts`, `claudeCli.ts`, `anthropicApi.ts`.

## Import convention

Server TypeScript files use `.js` extensions in import specifiers (e.g. `from './config.js'`). This is intentional — `tsx` at runtime and `moduleResolution: "bundler"` in `tsconfig.json` handle the mapping. **Do not "fix" these to `.ts`.**

## Scripts

| Script              | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `pnpm dev`          | Start server (watch) + Vite dev server            |
| `pnpm build`        | Build frontend to `dist/public`                   |
| `pnpm start`        | Production server (requires `pnpm build` first)   |
| `pnpm setup`        | Interactive setup wizard                          |
| `pnpm uninstall`    | Remove installed Claude Code hooks                |
| `pnpm typecheck`    | `tsc --noEmit` — type-checks all source (no emit) |
| `pnpm lint`         | ESLint across `src/`, `server/`, `scripts/`       |
| `pnpm lint:fix`     | ESLint with `--fix`                               |
| `pnpm format`       | Prettier format all files                         |
| `pnpm format:check` | Prettier check (CI uses this)                     |
| `pnpm test`         | Vitest (all projects, single run)                 |
| `pnpm test:watch`   | Vitest in watch mode                              |
| `pnpm ci`           | typecheck + lint + test + build (what CI runs)    |

## Testing

Tests live next to the code they test (e.g. `server/install.test.ts`, `src/App.test.tsx`).

**Two Vitest environments** are configured in `vitest.config.ts`:

- **`node`** — for `server/**` and `scripts/**`: pure Node, no DOM
- **`dom`** — for `src/**`: jsdom + `@testing-library/react` + `@testing-library/jest-dom`

Use **explicit imports** in test files rather than global Vitest APIs:

```ts
import { describe, it, expect } from 'vitest';
```

When you need to test an internal helper that isn't exported, export it with a comment noting it's for testing:

```ts
/** @internal Exported for testing. */
export function myHelper(...) { ... }
```

## Before opening a PR

Run `pnpm ci` locally and make sure all steps pass. This is exactly what GitHub Actions runs.

```bash
pnpm ci
```

If you're adding a new feature:

- Add tests for the changed behaviour (server logic → `*.test.ts`, React state → `src/*.test.tsx`)
- Update the README if the user-facing behaviour changed
