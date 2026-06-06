#!/usr/bin/env tsx
/**
 * Agent Foyer — uninstall hooks.
 *
 * Reads the port from .env (or defaults to 4317) and strips only the hooks
 * that point to http://localhost:<port>/hook. All other hooks are preserved.
 */
import { input, confirm } from '@inquirer/prompts';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { uninstallHooks, uninstallCodexHooks } from '../server/install.js';
import { config as loadDotenv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

loadDotenv({ path: join(PROJECT_ROOT, '.env') });

async function main() {
  console.log('\n🚪 Agent Foyer — Uninstall\n');

  const port = parseInt(process.env.FOYER_PORT ?? '4317', 10);
  const hookUrl = `http://localhost:${port}/hook`;

  const target = await input({
    message: 'Path to the settings.json to remove hooks from:',
    default: join(homedir(), '.claude', 'settings.json'),
  });

  console.log(`\nWill remove hooks pointing to: ${hookUrl}`);
  console.log(`From: ${target}`);
  console.log('All other hooks in that file will be left untouched.\n');

  const ok = await confirm({ message: 'Proceed?', default: true });
  if (!ok) {
    console.log('\nAborted. No changes made.\n');
    process.exit(0);
  }

  await uninstallHooks(target, port);

  // Also remove Codex hooks if present
  const codexConfigPath = join(homedir(), '.codex', 'config.toml');
  try {
    await uninstallCodexHooks(codexConfigPath);
  } catch {
    // Codex config may not exist — uninstallCodexHooks already logs this
  }

  console.log('\n✅ Hooks removed. The dashboard server can be stopped with Ctrl+C.\n');
}

main().catch((err: unknown) => {
  // Clean cancel on Ctrl-C (ExitPromptError from @inquirer/prompts)
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.log('\nUninstall cancelled.\n');
    process.exit(0);
  }
  console.error('\n✗ Uninstall failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
