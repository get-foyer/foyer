import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installHooks,
  uninstallHooks,
  installCodexHooks,
  uninstallCodexHooks,
  codexHookCommand,
} from './install.js';

let tempDir: string;
let settingsPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'foyer-test-'));
  settingsPath = join(tempDir, 'settings.json');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// installHooks
// ---------------------------------------------------------------------------

describe('installHooks', () => {
  it('creates 5 hook events including Notification pointing to the configured port', async () => {
    await installHooks(settingsPath, 4317);
    const content = JSON.parse(await readFile(settingsPath, 'utf-8'));
    const hooks = content.hooks;

    expect(hooks).toHaveProperty('UserPromptSubmit');
    expect(hooks).toHaveProperty('PreToolUse');
    expect(hooks).toHaveProperty('PostToolUse');
    expect(hooks).toHaveProperty('Stop');
    expect(hooks).toHaveProperty('Notification');

    // URL should include the specified port
    const url = 'http://localhost:4317/hook';
    expect(hooks.UserPromptSubmit[0].hooks[0].url).toBe(url);
    expect(hooks.PreToolUse[0].hooks[0].url).toBe(url);
    expect(hooks.PostToolUse[0].hooks[0].url).toBe(url);
    expect(hooks.Stop[0].hooks[0].url).toBe(url);
    // Notification has 3 matcher groups (permission_prompt, idle_prompt, elicitation_dialog)
    expect(hooks.Notification).toHaveLength(3);
    expect(hooks.Notification[0].hooks[0].url).toBe(url);
  });

  it('is idempotent — running twice does not duplicate hook groups', async () => {
    await installHooks(settingsPath, 4317);
    await installHooks(settingsPath, 4317);

    const content = JSON.parse(await readFile(settingsPath, 'utf-8'));
    // Each event should have exactly its own groups (ours), not doubled
    expect(content.hooks.UserPromptSubmit).toHaveLength(1);
    expect(content.hooks.PreToolUse).toHaveLength(1);
    expect(content.hooks.PostToolUse).toHaveLength(1);
    expect(content.hooks.Stop).toHaveLength(1);
    expect(content.hooks.Notification).toHaveLength(3); // 3 matchers, not 6
  });

  it('preserves pre-existing unrelated hooks from other tools', async () => {
    const foreign = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'http', url: 'http://other-tool.local/hook' }] }],
      },
      someOtherConfig: { key: 'value' },
    };
    await writeFile(settingsPath, JSON.stringify(foreign, null, 2), 'utf-8');

    await installHooks(settingsPath, 4317);

    const content = JSON.parse(await readFile(settingsPath, 'utf-8'));
    // Both the foreign hook and ours should be present
    expect(content.hooks.UserPromptSubmit).toHaveLength(2);
    expect(
      content.hooks.UserPromptSubmit.some(
        (g: { hooks: { url: string }[] }) => g.hooks[0].url === 'http://other-tool.local/hook',
      ),
    ).toBe(true);
    // Other config preserved
    expect(content.someOtherConfig).toEqual({ key: 'value' });
  });

  it('creates a .foyer-backup of the original file', async () => {
    await writeFile(settingsPath, JSON.stringify({ original: true }), 'utf-8');
    await installHooks(settingsPath, 4317);

    const backup = JSON.parse(await readFile(settingsPath + '.foyer-backup', 'utf-8'));
    expect(backup).toEqual({ original: true });
  });

  it('works without a pre-existing file (first-time install)', async () => {
    // settingsPath does not exist yet
    await expect(installHooks(settingsPath, 4317)).resolves.not.toThrow();
    const content = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(content.hooks).toHaveProperty('UserPromptSubmit');
  });
});

// ---------------------------------------------------------------------------
// uninstallHooks
// ---------------------------------------------------------------------------

describe('uninstallHooks', () => {
  it('removes only our hook groups, leaving foreign hooks intact', async () => {
    const initial = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'http', url: 'http://localhost:4317/hook' }] },
          { hooks: [{ type: 'http', url: 'http://other.local/hook' }] },
        ],
        Stop: [{ hooks: [{ type: 'http', url: 'http://localhost:4317/hook' }] }],
      },
    };
    await writeFile(settingsPath, JSON.stringify(initial, null, 2), 'utf-8');

    await uninstallHooks(settingsPath, 4317);

    const content = JSON.parse(await readFile(settingsPath, 'utf-8'));
    // Foreign hook should remain
    expect(content.hooks.UserPromptSubmit).toHaveLength(1);
    expect(content.hooks.UserPromptSubmit[0].hooks[0].url).toBe('http://other.local/hook');
    // Our Stop hook was the only group — event key should be deleted
    expect(content.hooks).not.toHaveProperty('Stop');
  });

  it('removes the hooks key entirely when all our groups are the only ones', async () => {
    await installHooks(settingsPath, 4317);
    await uninstallHooks(settingsPath, 4317);

    const content = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(content).not.toHaveProperty('hooks');
  });

  it('does not throw if the settings file does not exist', async () => {
    // No file written — should log and return cleanly
    await expect(uninstallHooks(settingsPath, 4317)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// installCodexHooks / uninstallCodexHooks
// ---------------------------------------------------------------------------

let codexConfigPath: string;

beforeEach(async () => {
  codexConfigPath = join(tempDir, 'config.toml');
});

const SHIM_PATH = '/abs/path/server/codex-hook.mjs';
const PORT = 4317;

describe('installCodexHooks', () => {
  it('quotes shim path and args in the installed command', () => {
    const command = codexHookCommand(
      "/Users/dennis/Foyer's App/server/codex-hook.mjs",
      4317,
      'Stop',
    );
    expect(command).toBe(
      "node '/Users/dennis/Foyer'\\''s App/server/codex-hook.mjs' '4317' 'Stop'",
    );
  });

  it('creates a TOML file with features.hooks = true and hook entries', async () => {
    await installCodexHooks(codexConfigPath, SHIM_PATH, PORT);
    const raw = await readFile(codexConfigPath, 'utf-8');
    // Should have hooks enabled
    expect(raw).toContain('hooks = true');
    // Should have entries for each monitored event
    expect(raw).toContain('PermissionRequest');
    expect(raw).toContain('UserPromptSubmit');
    expect(raw).toContain('PostToolUse');
    expect(raw).toContain('Stop');
    // Command should reference the shim and our marker
    expect(raw).toContain(SHIM_PATH);
    expect(raw).toContain('foyer-lobby-managed');
  });

  it('is idempotent — running twice does not duplicate entries', async () => {
    await installCodexHooks(codexConfigPath, SHIM_PATH, PORT);
    await installCodexHooks(codexConfigPath, SHIM_PATH, PORT);
    const raw = await readFile(codexConfigPath, 'utf-8');
    // The marker should appear exactly once per event (4 events)
    const markerOccurrences = (raw.match(/foyer-lobby-managed/g) ?? []).length;
    expect(markerOccurrences).toBe(4); // one per event
  });

  it('preserves unrelated TOML keys', async () => {
    const existing = `[openai]\napi_key = "sk-test"\n\n[settings]\nmodel = "gpt-4"\n`;
    await writeFile(codexConfigPath, existing, 'utf-8');
    await installCodexHooks(codexConfigPath, SHIM_PATH, PORT);
    const raw = await readFile(codexConfigPath, 'utf-8');
    expect(raw).toContain('sk-test');
    expect(raw).toContain('gpt-4');
  });

  it('creates a .foyer-backup of the original file', async () => {
    await writeFile(codexConfigPath, '[original]\nkey = "value"\n', 'utf-8');
    await installCodexHooks(codexConfigPath, SHIM_PATH, PORT);
    const backup = await readFile(codexConfigPath + '.foyer-backup', 'utf-8');
    expect(backup).toContain('key = "value"');
  });

  it('works without a pre-existing config (first-time install)', async () => {
    await expect(installCodexHooks(codexConfigPath, SHIM_PATH, PORT)).resolves.not.toThrow();
    const raw = await readFile(codexConfigPath, 'utf-8');
    expect(raw).toContain('PermissionRequest');
  });
});

describe('uninstallCodexHooks', () => {
  it('removes our hook entries, leaving other config intact', async () => {
    const existing = `[openai]\napi_key = "sk-test"\n`;
    await writeFile(codexConfigPath, existing, 'utf-8');
    await installCodexHooks(codexConfigPath, SHIM_PATH, PORT);

    await uninstallCodexHooks(codexConfigPath);
    const raw = await readFile(codexConfigPath, 'utf-8');

    // Our marker is gone
    expect(raw).not.toContain('foyer-lobby-managed');
    // Foreign config preserved
    expect(raw).toContain('sk-test');
  });

  it('does not throw if the config file does not exist', async () => {
    await expect(uninstallCodexHooks(join(tempDir, 'nonexistent.toml'))).resolves.not.toThrow();
  });
});
