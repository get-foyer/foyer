import type { ResearchLink, ResearchSection } from '../../src/types.js';
import type { TouchPoint, SuggestedTopic, SessionStatus } from '../../src/types.js';
import type { ProviderKind } from '../config.js';

export type { SuggestedTopic };

/** What a provider's research() returns; the route wraps it with `topic` + `ts` to store. */
export interface ResearchResult {
  lede: string;
  sections: ResearchSection[];
  links: ResearchLink[];
}

/** Context passed to summarizeActivity() — everything the LLM needs to narrate the agent's current state. */
export interface ActivityContext {
  /** The latest user prompt (current focus); equals `prompts.at(-1)`. */
  prompt: string;
  /** Full ordered prompt history for this session (goal first, current focus last). */
  prompts: string[];
  /** Most recent file operations, newest first (up to ~10). */
  recentTouchPoints: TouchPoint[];
  /** Compact text extracted from the end of the agent's transcript. */
  transcriptTail: string;
  /**
   * Topics suggested on the previous run (empty on first run). Fed back so the model
   * keeps them stable across ticks (anti-churn) and only changes them when the agent's
   * focus shifts.
   */
  previousTopics: SuggestedTopic[];
  /** Session lifecycle status, so the narration's terminal state is accurate. */
  status: SessionStatus;
  /** Why the session is blocked on the user, if waiting (e.g. a permission prompt). */
  waitingReason: string | null;
}

/**
 * The contract every LLM backend must implement.
 *
 * HOOK ISOLATION REQUIREMENT: any subprocess or API call made inside
 * research() or summarizeActivity() must NOT fire agent
 * lifecycle hooks back to this server.  Failure to ensure this creates a
 * phantom-task loop where the server's own inference work registers as new
 * user sessions titled "You are narrating, for a live dashboard…".
 *
 * Defense-in-depth approach (three layers):
 *  1. Provider-level subprocess isolation — each CLI provider runs from an
 *     isolated cwd / config dir so hooks don't load (see claudeCli.ts, codex.ts).
 *  2. Prompt sentinel — every internal prompt is prefixed with
 *     FOYER_INTERNAL_SENTINEL (server/providers/internal.ts) so the server-side
 *     guard can identify the event even if layer 1 leaks.
 *  3. Server-side backstop — hooks.ts calls isSelfOriginatedHook() and drops
 *     any event from an internal call before it reaches startSession().
 *
 * How existing providers satisfy this:
 *  - ClaudeCliProvider: spawns `claude` with an isolated cwd + CLAUDE_CONFIG_DIR
 *    (no user-level or project-level hooks load) and prefixes the prompt with
 *    the sentinel (see claudeCli.ts run()).
 *  - CodexProvider: passes `-c features.hooks=false` to disable Codex's own
 *    lifecycle hooks at runtime; also uses an isolated cwd and sentinel prefix.
 *    Note: Codex does NOT fire Claude Code hooks, but it DOES fire its own hooks
 *    which Foyer installs in ~/.codex/config.toml.
 *  - AnthropicApiProvider: direct HTTPS call, no subprocess — cannot self-trigger.
 *
 * If you add a provider that shells out to any hook-aware CLI, apply all three
 * layers: isolated cwd/config, FOYER_INTERNAL_SENTINEL prefix, and rely on the
 * server-side backstop as the safety net.
 */
export interface LlmProvider {
  readonly id: ProviderKind;
  isAvailable(): Promise<boolean>;
  /** Return a sourced research briefing for a topic. */
  research(topic: string): Promise<ResearchResult>;
  /**
   * Produce a live summary of what the agent is doing right now, given the session context.
   * Returns { summary, topics } where:
   *   summary = 2-4 sentences of markdown (present tense, no preamble)
   *   topics  = 3-6 research topics derived from the agent's work, each with a
   *             one-line `reason` (provenance). May be []. Normalized via
   *             normalizeTopics() (server/providers/text.ts) at each parse site.
   */
  summarizeActivity(ctx: ActivityContext): Promise<{ summary: string; topics: SuggestedTopic[] }>;
}

// Lazy singleton — set after the server reads config
let _active: LlmProvider | null = null;

export function setActiveProvider(p: LlmProvider): void {
  _active = p;
}

export function getActiveProvider(): LlmProvider | null {
  return _active;
}

/** Probe all available providers and return the first one that's available. */
export async function detectBestProvider(): Promise<{ id: ProviderKind; available: boolean }[]> {
  const { CodexProvider } = await import('./codex.js');
  const { ClaudeCliProvider } = await import('./claudeCli.js');
  const { AnthropicApiProvider } = await import('./anthropicApi.js');

  const candidates: LlmProvider[] = [
    new CodexProvider(),
    new ClaudeCliProvider(),
    new AnthropicApiProvider(),
  ];

  const results = await Promise.all(
    candidates.map(async (p) => ({ id: p.id, available: await p.isAvailable() })),
  );
  return results;
}

/** Build a provider instance by kind. */
export async function buildProvider(kind: ProviderKind): Promise<LlmProvider> {
  switch (kind) {
    case 'codex': {
      const { CodexProvider } = await import('./codex.js');
      return new CodexProvider();
    }
    case 'claude-cli': {
      const { ClaudeCliProvider } = await import('./claudeCli.js');
      return new ClaudeCliProvider();
    }
    case 'anthropic-api': {
      const { AnthropicApiProvider } = await import('./anthropicApi.js');
      return new AnthropicApiProvider();
    }
  }
}
