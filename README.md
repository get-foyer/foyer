# Agent Foyer 🚪

> Turn the 3–5 minute "agent is working" wait into focused, in-context time.

When you prompt a Claude Code agent, Agent Foyer hooks into the session and renders a live dashboard: the approved plan, a mermaid graph of it, the files being touched in real time, and a deep-research panel for learning while you wait.

**Core UX principle:** every panel gives you something to think about *in the same mental space as the current task* — not just a progress bar.

![Dashboard screenshot placeholder](https://placeholder.com/screenshot)

---

## Features

- **Live touch points** — every file Write/Edit/MultiEdit streams as it happens
- **Plan capture** — the approved plan auto-populates when you exit plan mode
- **LLM-generated graph** — a mermaid flowchart of the plan, generated automatically
- **Deep research** — enter any topic during the wait and get a sourced briefing
- **Zero agent slowdown** — all hooks return instantly; nothing blocks the agent

---

## Prerequisites

- Node ≥ 18 and npm
- Claude Code installed and configured
- One of the following LLM backends (for graph + research):
  - **Codex CLI** (`npm i -g @openai/codex`) — uses your ChatGPT Plus/Pro subscription
  - **Claude CLI** (already installed if you have Claude Code) — uses your Claude subscription
  - **Anthropic API key** — pay-per-token via `anthropic.com`

---

## Quick start

```bash
git clone https://github.com/your-username/agent-foyer
cd agent-foyer
npm install
npm run setup      # interactive wizard: pick backend, install hooks
npm run build
npm start          # dashboard at http://localhost:4317
```

Then in another terminal window, start Claude Code in any repo. The dashboard populates as the agent works.

---

## LLM backend options

The setup wizard auto-detects what's available and asks which to use.

| Backend | Auth | Web search | Cost |
|---|---|---|---|
| **Codex CLI** | ChatGPT subscription | ✅ `--search` | Usage against your plan |
| **Claude CLI** | Claude subscription | ✅ WebSearch | Usage against your plan† |
| **Anthropic API** | API key (BYOK) | ✅ web_search | ~$0.01/search + tokens |

**†** From 2026-06-15, Claude subscription headless usage (via `claude -p`) draws from a separate monthly "Agent SDK credit" pool, distinct from your interactive limits. The setup wizard warns you before choosing this option.

**⚠ ToS note:** Using the Codex or Claude CLI to automate calls from a local server is in a gray area of each provider's terms of service. Agent Foyer is intended for personal, local developer use only. For production or team use, use the Anthropic API (BYOK).

---

## How it works

1. `npm run setup` installs 4 HTTP hooks into your Claude Code `settings.json` (global or project-local, your choice)
2. When you run Claude Code, these hooks POST small JSON payloads to the dashboard server at `http://localhost:4317/hook`
3. The server holds session state in memory, broadcasts updates to the browser via SSE, and fires async LLM calls for graph generation and research

### Hook events

| Event | Purpose |
|---|---|
| `UserPromptSubmit` | New task started |
| `PreToolUse (ExitPlanMode)` | Approved plan captured |
| `PostToolUse (Write\|Edit\|MultiEdit)` | Live touch point |
| `Stop` | Task complete |

All hooks have a 2-second timeout — if the server is not running, the hook fails fast and the agent continues unaffected.

---

## Development

```bash
npm run dev       # Vite + Express in watch mode (frontend on :5173, API on :4317)
```

The Vite dev server proxies `/hook`, `/events`, `/research`, `/api` to the Express server.

---

## Uninstall

```bash
npm run uninstall  # strips only Agent Foyer hooks; all other hooks are preserved
```

---

## Configuration

All config lives in `.env` (created by `npm run setup`):

```bash
FOYER_PORT=4317                 # dashboard port
FOYER_PROVIDER=codex            # codex | claude-cli | anthropic-api
ANTHROPIC_API_KEY=sk-ant-...    # only for anthropic-api provider
FOYER_ANTHROPIC_MODEL=claude-haiku-4-5
```

---

## License

MIT — see [LICENSE](LICENSE).
