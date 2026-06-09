# Security Policy

## Supported Versions

Foyer is pre-1.0. Security fixes are applied to the latest published npm version only.

## Local Security Model

Foyer is a local developer tool. The server binds to `127.0.0.1` and exposes unauthenticated localhost routes for Claude Code and Codex hooks.

Do not expose the dashboard port through a public bind address, tunnel, reverse proxy, or shared network listener. If you change the bind address, add authentication and firewall rules first.

`foyer setup` modifies local Claude Code and Codex hook configuration after confirmation. Existing hook files are backed up with a `.foyer-backup` suffix, and uninstall removes only Foyer-managed hook entries.

Provider credentials may be stored in `~/.config/foyer/config.env` when using the Anthropic API backend. Keep that file private.

## Reporting Vulnerabilities

Open a private security advisory on GitHub or email the maintainer listed on the npm package. Include reproduction steps, affected version, and whether the issue requires local access or can be triggered remotely.
