# Foyer Lobby

> Turn the 3–5 minute "agent is working" wait into focused, in-context time.

When you prompt a Claude Code agent, Foyer Lobby hooks into the session and renders a live dashboard: a narrated "current focus", the files being touched in real time, and a deep-research panel for learning while you wait.

**Core UX principle:** every panel gives you something to think about _in the same mental space as the current task_ — not just a progress bar.

<!-- screenshot coming soon -->

---

## Features

- **Live touch points** — every file Write/Edit/MultiEdit streams as it happens
- **Plan capture** — the approved plan auto-populates when you exit plan mode (rendered as formatted markdown)
- **Deep research** — enter any topic during the wait and get a sourced briefing
- **Connection status** — a Live / Reconnecting / Disconnected badge so you always know if the dashboard is connected
- **Active provider chip** — shows which LLM backend is in use; banner when none is configured
- **Zero agent slowdown** — all hooks return instantly; nothing blocks the agent

---

## Prerequisites

- Node ≥ 18 and pnpm
- Claude Code installed and configured
- One of the following LLM backends (for graph + research):
  - **Codex CLI** (`npm i -g @openai/codex`) — uses your ChatGPT Plus/Pro subscription
  - **Claude CLI** (already installed if you have Claude Code) — uses your Claude subscription
  - **Anthropic API key** — pay-per-token via `anthropic.com`

---

## Quick start

```bash
git clone https://github.com/getfoyer/lobby
cd lobby
pnpm install
pnpm setup      # interactive wizard: pick backend, install hooks
pnpm build
pnpm start          # dashboard at http://localhost:4317
```

Then in another terminal window, start Claude Code in any repo. The dashboard populates as the agent works.

---

## LLM backend options

The setup wizard auto-detects what's available and asks which to use.

| Backend           | Auth                 | Web search    | Cost                     |
| ----------------- | -------------------- | ------------- | ------------------------ |
| **Codex CLI**     | ChatGPT subscription | ✅ `--search` | Usage against your plan  |
| **Claude CLI**    | Claude subscription  | ✅ WebSearch  | Usage against your plan† |
| **Anthropic API** | API key (BYOK)       | ✅ web_search | ~$0.01/search + tokens   |

**†** From 2026-06-15, Claude subscription headless usage (via `claude -p`) draws from a separate monthly "Agent SDK credit" pool, distinct from your interactive limits. The setup wizard warns you before choosing this option.

**⚠ ToS note:** Using the Codex or Claude CLI to automate calls from a local server is in a gray area of each provider's terms of service. Foyer Lobby is intended for personal, local developer use only. For production or team use, use the Anthropic API (BYOK).

---

## Local security model

Foyer Lobby is designed to run on your own machine, for your own agent sessions. The Express server binds to `127.0.0.1` only, and the installed hooks call `http://localhost:<port>/hook`.

The local API routes are not authenticated. That is intentional for a localhost developer tool, but it means any process running as your user can talk to the dashboard while it is open. Do not expose the Foyer Lobby port with a reverse proxy, tunnel, public bind address, or shared network listener. If you change the server to listen on anything other than loopback, add authentication and firewall rules first.

`.env` is ignored by git and may contain provider credentials when you use the Anthropic API backend.

---

## How it works

1. `pnpm setup` installs 4 HTTP hooks into your Claude Code `settings.json` (global or project-local, your choice)
2. When you run Claude Code, these hooks POST small JSON payloads to the dashboard server at `http://localhost:4317/hook`
3. The server holds session state in memory, broadcasts updates to the browser via SSE, and fires async LLM calls for graph generation and research

### Hook events

| Event                                  | Purpose                |
| -------------------------------------- | ---------------------- |
| `UserPromptSubmit`                     | New task started       |
| `PreToolUse (ExitPlanMode)`            | Approved plan captured |
| `PostToolUse (Write\|Edit\|MultiEdit)` | Live touch point       |
| `Stop`                                 | Task complete          |

All hooks have a 2-second timeout — if the server is not running, the hook fails fast and the agent continues unaffected.

---

## Development

```bash
pnpm dev       # Vite + Express in watch mode (frontend on :5173, API on :4317)
```

The Vite dev server proxies `/hook`, `/events`, `/research`, `/activity`, `/prefetch`, `/close`, `/pin`, and `/api` to the Express server.

```bash
pnpm typecheck  # type-check all source files
pnpm lint       # ESLint
pnpm test       # Vitest (node + jsdom projects)
pnpm ci         # typecheck + lint + test + build (same as CI)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details and conventions.

---

## Uninstall

```bash
pnpm uninstall  # strips only Foyer Lobby hooks; all other hooks are preserved
```

---

## Configuration

All config lives in `.env` (created by `pnpm setup`):

```bash
FOYER_PORT=4317                 # dashboard port
FOYER_PROVIDER=codex            # codex | claude-cli | anthropic-api
ANTHROPIC_API_KEY=sk-ant-...    # only for anthropic-api provider
FOYER_ANTHROPIC_MODEL=claude-haiku-4-5
```

---

## License

MIT — see [LICENSE](LICENSE).
