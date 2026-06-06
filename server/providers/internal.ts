/**
 * Shared marker constants and guard for detecting Foyer's own internal LLM
 * subprocess calls so the hook handler can silently drop them before they
 * become phantom sessions in the dashboard.
 *
 * Used by:
 *  - server/providers/claudeCli.ts  — sets CLAUDE_CONFIG_DIR + cwd
 *  - server/providers/codex.ts      — sets cwd + features.hooks=false
 *  - server/hooks.ts                — server-side backstop guard (always fires)
 */

/**
 * Prefix for the throw-away temp directory used as `cwd` (and CLAUDE_CONFIG_DIR)
 * for every internal LLM subprocess.  Claude Code embeds the cwd in hook
 * payloads, so the hook handler can identify and drop self-originated events
 * by looking for this prefix.
 */
export const FOYER_INTERNAL_DIR_PREFIX = 'foyer-internal-';

/**
 * Sentinel string prepended to every prompt sent to an internal LLM call.
 * It round-trips back in `UserPromptSubmit` payloads, giving the hook handler
 * a second way to recognise self-originated events when the cwd check is
 * insufficient (e.g. on providers that don't expose cwd in their payloads).
 *
 * The sentinel is harmless to the model: all internal prompts request
 * structured JSON or Mermaid output and the model ignores the first line.
 */
export const FOYER_INTERNAL_SENTINEL = '[foyer-internal-call]';

/** Minimal shape of a hook payload needed for self-origin detection. */
interface SelfOriginPayload {
  cwd?: string;
  prompt?: string;
}

/**
 * Return true when a hook event was produced by one of Foyer's own internal
 * LLM subprocess calls rather than by a genuine user-driven agent session.
 *
 * Two complementary checks (either is sufficient):
 *  1. cwd contains FOYER_INTERNAL_DIR_PREFIX — covers all hook event types
 *     (Stop, PostToolUse, UserPromptSubmit, …) because the subprocess runs
 *     from the isolated temp dir.
 *  2. prompt contains FOYER_INTERNAL_SENTINEL — backstop specifically for
 *     UserPromptSubmit, in case cwd is absent or normalised away.
 */
export function isSelfOriginatedHook(payload: SelfOriginPayload): boolean {
  if (payload.cwd?.includes(FOYER_INTERNAL_DIR_PREFIX)) return true;
  if (payload.prompt?.includes(FOYER_INTERNAL_SENTINEL)) return true;
  return false;
}
