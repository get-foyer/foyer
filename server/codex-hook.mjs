#!/usr/bin/env node
/**
 * Codex lifecycle hook shim — installed as a command hook in ~/.codex/config.toml.
 *
 * Codex passes event JSON on stdin. This script reads it and POSTs to the
 * Foyer Lobby /hook endpoint, wrapping it in a { source:'codex' } envelope so
 * the server can normalise Codex vs Claude payloads.
 *
 * Usage (installed by pnpm setup):
 *   node /abs/path/server/codex-hook.mjs <port> <event>
 *
 * Always exits 0 — never blocks Codex.
 */

const port = parseInt(process.argv[2] ?? '4317', 10);
const event = process.argv[3] ?? 'Unknown';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  try {
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    const payload = raw ? JSON.parse(raw) : {};

    const body = JSON.stringify({ source: 'codex', event, payload });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    await fetch(`http://localhost:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
  } catch {
    // Swallow all errors — never block Codex
  }
  process.exit(0);
});
