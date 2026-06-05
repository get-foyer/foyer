/**
 * Safely merge / unmerge agent-foyer hooks into a Claude Code settings.json.
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

/** The 4 hooks we install. port is substituted in at install time. */
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
        matcher: 'ExitPlanMode',
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [{ type: 'http', url, timeout: 2 }],
      },
    ],
    Stop: [
      {
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
      (g) => !g.hooks.some((h) => (h as { url?: string }).url === url)
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
      (g) => !g.hooks.some((h) => (h as { url?: string }).url === url)
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

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
