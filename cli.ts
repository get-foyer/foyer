#!/usr/bin/env node
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { configPath } from './server/paths.js';
import { config as loadDotenv } from 'dotenv';

const command = process.argv[2] ?? 'help';

function printHelp(): void {
  console.log(`Foyer

Usage:
  foyer setup             Configure providers and install hooks
  foyer start             Start the local dashboard
  foyer uninstall         Remove installed hooks
  foyer hook codex EVENT  Internal Codex lifecycle hook endpoint
  foyer --version         Print version
  foyer --help            Show this help
`);
}

async function printVersion(): Promise<void> {
  const root = dirname(fileURLToPath(import.meta.url));
  let raw: string;
  try {
    raw = await readFile(join(root, 'package.json'), 'utf-8');
  } catch {
    raw = await readFile(join(root, '..', 'package.json'), 'utf-8');
  }
  const pkg = JSON.parse(raw) as { version?: string };
  console.log(pkg.version ?? '0.0.0');
}

/**
 * Pure core: wrap a raw Codex hook payload in the `{ source:'codex' }` envelope
 * and POST it to the Foyer /hook endpoint. THROWS on bad JSON or a failed/aborted
 * fetch so callers (and tests) can observe real failures — the exit-0 guarantee
 * lives in the `runCodexHook` shell, not here.
 *
 * @internal Exported for tests.
 */
export async function postHookEvent(event: string, raw: string, port: number): Promise<void> {
  const trimmed = raw.trim();
  const payload = trimmed ? JSON.parse(trimmed) : {};
  const body = JSON.stringify({ source: 'codex', event, payload });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`http://localhost:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Codex lifecycle hook shell. Reads the event payload from stdin and forwards it
 * to the running dashboard. MUST always exit 0 — Codex treats any non-zero exit
 * as "hook (failed)" and surfaces it on every prompt/tool call. So every step is
 * wrapped: a failure logs ONE diagnostic line to stderr (so dropped events aren't
 * fully invisible) and we still exit 0.
 */
async function runCodexHook(): Promise<void> {
  const event = process.argv[4] ?? 'Unknown';
  try {
    loadDotenv({ path: configPath() });
    const port = parseInt(process.env.FOYER_PORT ?? '4317', 10);

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks).toString('utf-8');

    await postHookEvent(event, raw, port);
  } catch (err) {
    // Never block or fail Codex — but leave a single breadcrumb for debugging.
    console.error(
      `[foyer hook codex ${event}] dropped: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    process.exit(0);
  }
}

async function main(): Promise<void> {
  switch (command) {
    case 'setup': {
      const { runSetup } = await import('./scripts/setup.js');
      await runSetup();
      return;
    }
    case 'start':
      process.env.NODE_ENV = process.env.NODE_ENV ?? 'production';
      await import('./server/index.js');
      return;
    case 'uninstall': {
      const { runUninstall } = await import('./scripts/uninstall.js');
      await runUninstall();
      return;
    }
    case 'hook':
      if (process.argv[3] !== 'codex') {
        console.error('Unknown hook provider. Expected: foyer hook codex EVENT');
        process.exitCode = 1;
        return;
      }
      await runCodexHook();
      return;
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return;
    case '--version':
    case '-v':
    case 'version':
      await printVersion();
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
