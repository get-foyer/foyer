/**
 * Safely merge / unmerge agent-foyer hooks into a Claude Code settings.json
 * and a Codex config.toml.
 *
 * Rules:
 *   - Always back up the file before modifying.
 *   - Deep-merge: never overwrite existing hooks from other tools.
 *   - Deduplicate by our hook URL so re-runs are idempotent.
 *   - Uninstall strips only our hooks (matched by URL), leaves everything else.
 */
import { readFile, writeFile, copyFile, access } from 'fs/promises';
import { dirname } from 'path';
import { mkdir } from 'fs/promises';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';

// ---------------------------------------------------------------------------
// Claude Code (JSON settings)
// ---------------------------------------------------------------------------

/** The hooks we install. port is substituted in at install time. */
function buildHooks(port: number) {
  const url = `http://localhost:${port}/hook`;
  return {
    UserPromptSubmit: [
      {
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
    ],
    PreToolUse: [
      {
        matcher: 'ExitPlanMode|AskUserQuestion',
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit|AskUserQuestion',
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
    ],
    Stop: [
      {
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
    ],
    // Subscribe to notifications so we know when the agent needs input.
    // We use separate matchers per type; the server also filters defensively.
    Notification: [
      {
        matcher: 'permission_prompt',
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
      {
        matcher: 'idle_prompt',
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
      {
        matcher: 'elicitation_dialog',
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
    ],
  } as const;
}

type HookEntry = { matcher?: string; hooks: object[] };
type HooksMap = Record<string, HookEntry[]>;

export async function installHooks(settingsPath: string, port: number): Promise<void> {
  await ensureDir(settingsPath);

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist or is invalid JSON — start fresh
  }

  // Back up if file existed
  try {
    await access(settingsPath);
    await copyFile(settingsPath, settingsPath + '.foyer-backup');
  } catch {
    // New file, nothing to back up
  }

  const url = `http://localhost:${port}/hook`;
  const toInstall = buildHooks(port);
  const existingHooks = (existing.hooks ?? {}) as HooksMap;

  for (const [event, newGroups] of Object.entries(toInstall)) {
    const existing_groups: HookEntry[] = existingHooks[event] ?? [];
    // Remove any groups that already have our URL (deduplicate)
    const filtered = existing_groups.filter(
      (g) => !g.hooks.some((h) => (h as { url?: string }).url === url),
    );
    existingHooks[event] = [...filtered, ...(newGroups as unknown as HookEntry[])];
  }

  existing.hooks = existingHooks;
  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  console.log(`✓ Hooks installed in ${settingsPath}`);
  console.log(`  (Backup saved as ${settingsPath}.foyer-backup)`);
}

export async function uninstallHooks(settingsPath: string, port: number): Promise<void> {
  let existing: Record<string, unknown>;
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    console.log(`  No settings file found at ${settingsPath} — nothing to remove.`);
    return;
  }

  const url = `http://localhost:${port}/hook`;
  const existingHooks = (existing.hooks ?? {}) as HooksMap;
  let removed = 0;

  for (const event of Object.keys(existingHooks)) {
    const before = existingHooks[event].length;
    existingHooks[event] = existingHooks[event].filter(
      (g) => !g.hooks.some((h) => (h as { url?: string }).url === url),
    );
    removed += before - existingHooks[event].length;
    // Clean up empty event keys
    if (existingHooks[event].length === 0) {
      delete existingHooks[event];
    }
  }

  if (Object.keys(existingHooks).length === 0) {
    delete existing.hooks;
  } else {
    existing.hooks = existingHooks;
  }

  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  console.log(`✓ Removed ${removed} hook group(s) from ${settingsPath}`);
}

// ---------------------------------------------------------------------------
// Codex (TOML config)
// ---------------------------------------------------------------------------

/** The shim command entry we install for each Codex event. */
function codexHookCommand(shimPath: string, port: number, event: string): string {
  return `node ${shimPath} ${port} ${event}`;
}

/**
 * Codex events to monitor. Minimal set that gives "needs input" signal plus
 * full session lifecycle so Codex sessions appear in the dashboard at all.
 */
const CODEX_EVENTS = ['PermissionRequest', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const;

/** Marker embedded in Codex entries so we can find and remove them. */
const FOYER_MARKER = 'agent-foyer-managed';

export async function installCodexHooks(
  configPath: string,
  shimPath: string,
  port: number,
): Promise<void> {
  await ensureDir(configPath);

  let config: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = parseTOML(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid TOML — start fresh
  }

  // Back up if file existed
  try {
    await access(configPath);
    await copyFile(configPath, configPath + '.foyer-backup');
  } catch {
    // New file, nothing to back up
  }

  // Enable lifecycle hooks
  const features = (config.features ?? {}) as Record<string, unknown>;
  features.hooks = true;
  config.features = features;

  // Merge our hook entries under config.hooks
  const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;

  for (const event of CODEX_EVENTS) {
    const existing: unknown[] = (hooks[event] as unknown[] | undefined) ?? [];
    // Remove any entries we previously installed (identified by marker in command)
    const filtered = existing.filter((entry) => {
      const e = entry as Record<string, unknown>;
      const entryHooks = (e.hooks ?? []) as Array<Record<string, unknown>>;
      return !entryHooks.some(
        (h) => typeof h.command === 'string' && h.command.includes(FOYER_MARKER),
      );
    });
    // Build our entry
    const command = `${codexHookCommand(shimPath, port, event)} # ${FOYER_MARKER}`;
    filtered.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = filtered;
  }

  config.hooks = hooks;

  await writeFile(
    configPath,
    stringifyTOML(config as Parameters<typeof stringifyTOML>[0]),
    'utf-8',
  );
  console.log(`✓ Codex hooks installed in ${configPath}`);
  console.log(`  (Backup saved as ${configPath}.foyer-backup)`);
}

export async function uninstallCodexHooks(configPath: string): Promise<void> {
  let config: Record<string, unknown>;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = parseTOML(raw) as Record<string, unknown>;
  } catch {
    console.log(`  No Codex config found at ${configPath} — nothing to remove.`);
    return;
  }

  const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
  let removed = 0;

  for (const event of Object.keys(hooks)) {
    const before = hooks[event].length;
    hooks[event] = hooks[event].filter((entry) => {
      const e = entry as Record<string, unknown>;
      const entryHooks = (e.hooks ?? []) as Array<Record<string, unknown>>;
      return !entryHooks.some(
        (h) => typeof h.command === 'string' && h.command.includes(FOYER_MARKER),
      );
    });
    removed += before - hooks[event].length;
    if (hooks[event].length === 0) {
      delete hooks[event];
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete config.hooks;
    // Also remove features.hooks if we added it (check if it's still true and the only key)
    const features = config.features as Record<string, unknown> | undefined;
    if (features && features.hooks === true) {
      delete features.hooks;
      if (Object.keys(features).length === 0) {
        delete config.features;
      }
    }
  } else {
    config.hooks = hooks;
  }

  await writeFile(
    configPath,
    stringifyTOML(config as Parameters<typeof stringifyTOML>[0]),
    'utf-8',
  );
  console.log(`✓ Removed ${removed} Codex hook group(s) from ${configPath}`);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
