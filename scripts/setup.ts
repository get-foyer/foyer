#!/usr/bin/env tsx
/**
 * Foyer Gate — interactive setup wizard.
 *
 * 1. Detect available LLM backends (Codex, Claude CLI, Anthropic API)
 * 2. Ask which backend to use (and surface credit-pool warnings inline)
 * 3. If Anthropic API: collect and validate the API key
 * 4. Ask where to install Claude Code hooks (global / project-local)
 * 5. Ask for the dashboard port
 * 6. Write .env and install hooks
 */
import { select, input, confirm } from '@inquirer/prompts';
import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, access, copyFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { installHooks, installCodexHooks } from '../server/install.js';

const execFile = promisify(_execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

async function detectCodex(): Promise<boolean> {
  try {
    // `codex login status` prints to stderr, not stdout
    const { stdout, stderr } = await execFile('codex', ['login', 'status'], { timeout: 5_000 });
    return (stdout + stderr).toLowerCase().includes('logged in');
  } catch {
    return false;
  }
}

async function detectClaudeCli(): Promise<boolean> {
  try {
    await execFile('claude', ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function detectAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n🚪 Foyer Gate — Setup\n');
  console.log('This wizard configures your LLM backend, Claude Code hooks, and dashboard port.');
  console.log('You can re-run `pnpm setup` at any time to reconfigure.\n');

  // --- Detect available backends ---
  console.log('Detecting available LLM backends…');
  const [hasCodex, hasClaude, existingKey] = await Promise.all([
    detectCodex(),
    detectClaudeCli(),
    Promise.resolve(detectAnthropicApiKey()),
  ]);

  const detected: string[] = [];
  if (hasCodex) detected.push('✓ Codex CLI (ChatGPT subscription — logged in)');
  if (hasClaude) detected.push('✓ Claude CLI (Claude subscription — installed)');
  if (existingKey) detected.push('✓ Anthropic API key (ANTHROPIC_API_KEY set in env)');
  if (detected.length === 0) {
    detected.push('✗ No backend auto-detected');
  }
  console.log(detected.map((d) => '  ' + d).join('\n'), '\n');

  // --- Pick backend ---
  type ProviderChoice = 'codex' | 'claude-cli' | 'anthropic-api';
  const providerChoice = await select<ProviderChoice>({
    message: 'Which LLM backend should the dashboard use for graph generation and research?',
    choices: [
      {
        value: 'codex',
        name: 'Codex CLI — ChatGPT subscription' + (hasCodex ? ' (detected ✓)' : ' (not detected)'),
        description:
          'Uses `codex exec` with your ChatGPT Plus/Pro subscription — no per-token cost.\n' +
          'Does NOT fire Claude Code hooks (no self-trigger risk).\n' +
          '⚠  ToS note: automating a personal subscription is a gray area; intended for local use only.',
      },
      {
        value: 'claude-cli',
        name:
          'Claude CLI — Claude subscription' + (hasClaude ? ' (detected ✓)' : ' (not detected)'),
        description:
          'Uses `claude -p` with your Claude Pro/Max subscription — no per-token cost.\n' +
          '⚠  From 2026-06-15: subscription headless usage draws from a SEPARATE monthly "Agent SDK credit"\n' +
          '   pool — distinct from your interactive usage limits. Graph + research calls consume that quota.\n' +
          '⚠  ToS note: automating a personal subscription is a gray area; intended for local use only.',
      },
      {
        value: 'anthropic-api',
        name: 'Anthropic API — bring your own key',
        description:
          'Direct API calls via your Anthropic API key. Clear pricing (see anthropic.com/pricing).\n' +
          'Research uses web_search (~$0.01/call) + per-token costs on the chosen model.',
      },
    ],
  });

  // Warn if chosen backend was not auto-detected
  const isDetected =
    (providerChoice === 'codex' && hasCodex) ||
    (providerChoice === 'claude-cli' && hasClaude) ||
    (providerChoice === 'anthropic-api' && !!existingKey);

  if (!isDetected) {
    console.log('');
    const proceed = await confirm({
      message: `"${providerChoice}" was not auto-detected. Graph generation and research may fail until it is configured. Continue anyway?`,
      default: false,
    });
    if (!proceed) {
      console.log('\nSetup cancelled.\n');
      process.exit(0);
    }
  }

  // --- Anthropic API key (only if BYOK) ---
  let anthropicApiKey = '';
  let anthropicModel = 'claude-haiku-4-5';

  if (providerChoice === 'anthropic-api') {
    console.log('');
    anthropicApiKey =
      existingKey ??
      (await input({
        message: 'Anthropic API key:',
        validate: (v) => {
          if (!v.startsWith('sk-ant-')) return 'Key should start with sk-ant-';
          if (v.length < 20) return 'Key looks too short';
          return true;
        },
      }));

    const modelChoice = await select({
      message: 'Model (for graph generation and research):',
      choices: [
        {
          value: 'claude-haiku-4-5',
          name: 'claude-haiku-4-5 (fast, cheap — recommended for this use case)',
        },
        { value: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6 (better quality, higher cost)' },
        { value: 'claude-opus-4-8', name: 'claude-opus-4-8  (highest quality, most expensive)' },
      ],
    });
    anthropicModel = modelChoice;
  }

  // --- Port ---
  const portStr = await input({
    message: 'Dashboard port:',
    default: '4317',
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1024 || n > 65535) return 'Enter a valid port (1024–65535)';
      return true;
    },
  });
  const port = parseInt(portStr, 10);

  // --- Hook scope ---
  console.log('');
  const hookScope = await select({
    message: 'Where should Claude Code hooks be installed?',
    choices: [
      {
        value: 'global',
        name: 'Global (~/.claude/settings.json)',
        description:
          'Hooks fire for every Claude Code session on this machine.\n' +
          'The dashboard lights up during real feature work in any repo.\n' +
          'Existing hooks in this file will be preserved.',
      },
      {
        value: 'local',
        name: "Project-local (a specific repo's .claude/settings.json)",
        description:
          'Hooks only fire when Claude Code runs inside that specific repo.\n' +
          "More contained, but the dashboard won't populate in other repos.",
      },
    ],
  });

  let hookSettingsPath: string;
  if (hookScope === 'global') {
    hookSettingsPath = join(homedir(), '.claude', 'settings.json');
  } else {
    const repoPath = await input({
      message: 'Path to your repo (the directory containing .claude/):',
      default: process.cwd(),
      validate: (v) => v.trim().length > 0 || 'Please enter a path',
    });
    hookSettingsPath = join(repoPath.trim(), '.claude', 'settings.json');
  }

  // --- Confirm before writing ---
  console.log('\nReady to apply the following configuration:');
  console.log(`  Provider:     ${providerChoice}`);
  if (providerChoice === 'anthropic-api') {
    console.log(`  Model:        ${anthropicModel}`);
    console.log(`  API key:      sk-ant-****${anthropicApiKey.slice(-4)}`);
  }
  console.log(`  Port:         ${port}`);
  console.log(`  Hooks target: ${hookSettingsPath}\n`);

  const ok = await confirm({ message: 'Proceed?', default: true });
  if (!ok) {
    console.log('\nAborted. No changes made.\n');
    process.exit(0);
  }

  // --- Back up existing .env before overwrite ---
  const envPath = join(PROJECT_ROOT, '.env');
  try {
    await access(envPath);
    await copyFile(envPath, envPath + '.foyer-backup');
    console.log('\n✓ Backed up existing .env to .env.foyer-backup');
  } catch {
    // No existing .env — nothing to back up
  }

  // --- Write .env ---
  const envLines = [
    '# Foyer Gate — generated by `pnpm setup`',
    `FOYER_PORT=${port}`,
    `FOYER_PROVIDER=${providerChoice}`,
  ];
  if (providerChoice === 'anthropic-api') {
    envLines.push(`ANTHROPIC_API_KEY=${anthropicApiKey}`);
    envLines.push(`FOYER_ANTHROPIC_MODEL=${anthropicModel}`);
  }
  await writeFile(envPath, envLines.join('\n') + '\n', 'utf-8');
  console.log(`✓ Written .env`);

  // --- Install Claude Code hooks ---
  await installHooks(hookSettingsPath, port);

  // --- Optionally install Codex lifecycle hooks (for monitoring live Codex sessions) ---
  let codexHooksInstalled = false;
  if (hasCodex) {
    console.log('');
    codexHooksInstalled = await confirm({
      message:
        'Also install Codex lifecycle hooks so Codex sessions appear in the dashboard?\n' +
        '  (Writes to ~/.codex/config.toml and sets features.hooks = true. Backed up first.)',
      default: true,
    });
    if (codexHooksInstalled) {
      const codexConfigPath = join(homedir(), '.codex', 'config.toml');
      const shimPath = join(PROJECT_ROOT, 'server', 'codex-hook.mjs');
      await installCodexHooks(codexConfigPath, shimPath, port);
    }
  }

  // --- Done ---
  console.log('\n✅ Setup complete!\n');
  if (codexHooksInstalled) {
    console.log('ℹ  Codex monitoring is active. Run `pnpm uninstall` to remove Codex hooks.');
  }
  console.log('Next steps:');
  console.log('  1. Build and start the dashboard:');
  console.log('       pnpm build && pnpm start');
  console.log('  2. Open your browser:');
  console.log(`       http://localhost:${port}`);
  console.log('  3. In another window, run Claude Code in your repo — the dashboard');
  console.log('     will populate as the agent works.\n');
  console.log('To uninstall hooks:  pnpm uninstall');
  console.log('To reconfigure:      pnpm setup\n');
}

main().catch((err: unknown) => {
  // Clean cancel on Ctrl-C (ExitPromptError from @inquirer/prompts)
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.log('\nSetup cancelled.\n');
    process.exit(0);
  }
  console.error('\n✗ Setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
