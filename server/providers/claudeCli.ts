/**
 * Claude CLI provider.
 *
 * Shells out to `claude -p` using the user's Claude subscription.
 *
 * Self-trigger isolation (three layers):
 *  1. The subprocess runs with an isolated cwd (foyer-internal- prefix) so
 *     project-level .claude/settings.json hooks don't load (resolved from cwd).
 *  2. `--setting-sources user` explicitly loads only user-level settings from
 *     the isolated (empty) CLAUDE_CONFIG_DIR, excluding project/local hooks
 *     regardless of cwd — deterministic, built-in source exclusion.
 *  3. Every prompt is prefixed with FOYER_INTERNAL_SENTINEL so the server-side
 *     guard in hooks.ts can drop any event that leaks through anyway.
 *
 * ⚠️ Warning: from 2026-06-15, subscription headless usage draws from a
 * separate monthly "Agent SDK credit" pool — the setup wizard surfaces this.
 */
import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import type { LlmProvider, ResearchResult, ActivityContext, SuggestedTopic } from './index.js';
import { normalizeTopics, RESEARCH_PROMPT, parseResearchSections } from './text.js';
import { FOYER_INTERNAL_DIR_PREFIX, FOYER_INTERNAL_SENTINEL } from './internal.js';

const execFile = promisify(_execFile);

/**
 * Fast, cheap model for activity summarisation.
 *
 * The summariser runs frequently (debounced, plus periodic polls), so it is
 * pinned to Haiku to keep cost low — matching the deliberate fast-model choice
 * in the other providers (anthropicApi defaults to claude-haiku-4-5; codex uses
 * model_reasoning_effort=low). Overridable via FOYER_CLAUDE_CLI_SUMMARY_MODEL.
 */
const SUMMARY_MODEL = process.env.FOYER_CLAUDE_CLI_SUMMARY_MODEL ?? 'claude-haiku-4-5';

/**
 * Model for the research briefing.
 *
 * Unlike the summariser (high-frequency, trivial → Haiku), research runs only on an explicit tap /
 * prefetch and its briefing is the thing the user actually reads — synthesis quality matters. Pin
 * Sonnet: fast enough to finish well inside the timeout while keeping briefings useful. The prior
 * default was the user's *unpinned* CLI model (often Opus), whose slow WebSearch+WebFetch calls
 * blew the 90s timeout and surfaced as "claude -p failed". Overridable via
 * FOYER_CLAUDE_CLI_RESEARCH_MODEL.
 *
 * Cross-provider note: codex's analogous lever is model_reasoning_effort, not a model name — see the
 * deferred "codex research-tier" item in TODOS.md.
 */
const RESEARCH_MODEL = process.env.FOYER_CLAUDE_CLI_RESEARCH_MODEL ?? 'claude-sonnet-4-6';

// Matches ANSI SGR colour sequences (e.g. ESC[33m) so we can strip them from CLI stderr before
// surfacing a failure reason. The literal ESC (\x1b) is the canonical legitimate use of a
// control-char regex; no-control-regex would otherwise flag it.
// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

export class ClaudeCliProvider implements LlmProvider {
  readonly id = 'claude-cli' as const;

  async isAvailable(): Promise<boolean> {
    try {
      await execFile('claude', ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async summarizeActivity(
    ctx: ActivityContext,
  ): Promise<{ summary: string; topics: SuggestedTopic[] }> {
    const { buildActivityPrompt } = await import('./codex.js');
    const prompt = buildActivityPrompt(ctx);
    // Pin to a fast/cheap model — summarisation runs often and doesn't need the
    // user's (potentially Opus-tier) default CLI model. Request JSON output so
    // we can parse summary + topics reliably.
    const raw = await this.run(prompt, ['--model', SUMMARY_MODEL]);
    return parseActivityJson(raw);
  }

  async research(topic: string): Promise<ResearchResult> {
    // NOTE: do NOT pass '--output-format' here. buildClaudeArgs() already sets
    // '--output-format json' and run() parses the JSON envelope ({ result }).
    // A second '--output-format' (text) would override it, the CLI would emit
    // plain text, JSON.parse(stdout) would throw, and /research would 500.
    // Pin research to RESEARCH_MODEL (Sonnet): the prior unpinned default (often Opus) blew the
    // timeout on slow WebSearch/WebFetch calls. The model's `result` is our structured-briefing
    // JSON; parseResearchSections parses it (with a single-section fallback) and yields the source
    // links too — replacing the old text-regex link scraping entirely.
    const result = await this.run(RESEARCH_PROMPT(topic), [
      '--model',
      RESEARCH_MODEL,
      '--allowedTools',
      'WebSearch,WebFetch',
    ]);
    const { lede, sections, sources } = parseResearchSections(result, topic);
    return { lede, sections, links: sources };
  }

  private async run(prompt: string, extraArgs: string[]): Promise<string> {
    // Isolation layer 1: create a throw-away directory used as BOTH the cwd
    // and CLAUDE_CONFIG_DIR.  Running from an empty dir prevents project-level
    // .claude/settings.json hooks from loading (they're resolved relative to
    // cwd), and the empty CLAUDE_CONFIG_DIR has no user-level hooks either.
    const isolatedDir = await mkdtemp(join(tmpdir(), FOYER_INTERNAL_DIR_PREFIX));
    // Isolation layer 2 (--setting-sources user) is expressed in buildClaudeArgs.
    // Isolation layer 3: prefix the prompt with the sentinel so the server-side
    // guard in hooks.ts can drop any event that reaches /hook despite layers 1+2.
    const sentinelPrompt = `${FOYER_INTERNAL_SENTINEL}\n${prompt}`;
    try {
      // execFile leaves the child's stdin as an open pipe; claude (v2.1.168+) then waits ~3s for
      // possible stdin input before proceeding ("no stdin data received in 3s"). We pass the prompt
      // via -p, never stdin, so close it: the promisified execFile exposes the ChildProcess as
      // `.child` (documented). EOF → claude skips the wait, no warning, full timeout budget.
      const p = execFile('claude', buildClaudeArgs(sentinelPrompt, extraArgs), {
        timeout: 120_000,
        cwd: isolatedDir,
        env: {
          ...process.env,
          // Do NOT override CLAUDE_CONFIG_DIR — the real config dir has the auth
          // token. Self-trigger isolation is handled by the cwd (foyer-internal-
          // prefix) and the sentinel prompt prefix, which the server-side guard
          // checks and drops before any phantom session can be created.
          // Explicitly unset API key so subscription auth is used
          ANTHROPIC_API_KEY: undefined,
        },
      });
      p.child?.stdin?.end();
      const { stdout } = await p;
      const parsed = JSON.parse(stdout) as { result?: string };
      return parsed.result ?? stdout;
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        message?: string;
        killed?: boolean;
        signal?: string;
      };
      // Try to extract result from partial stdout
      if (e.stdout) {
        try {
          const parsed = JSON.parse(e.stdout) as { result?: string };
          if (parsed.result) return parsed.result;
        } catch {
          /* ignore */
        }
      }
      // Surface the real failure reason instead of the raw (ANSI-coloured) stdin warning the old
      // message used to show. A timeout kills the child with SIGTERM (killed=true); a maxBuffer
      // overflow also sets killed/SIGTERM, so guard against mislabeling it as a timeout.
      const ansi = (s?: string) => (s ?? '').replace(ANSI_SGR, '').trim();
      if (e.killed && e.signal === 'SIGTERM' && !e.message?.includes('maxBuffer')) {
        // Generic wording: run() is shared by summarizeActivity / research.
        throw new Error('claude -p timed out after 120s');
      }
      throw new Error(`claude -p failed: ${ansi(e.stderr) || ansi(e.message) || String(err)}`);
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the argv for an internal `claude -p` call.
 *
 * Exported as a pure function so tests can assert that source-isolation flags
 * are present without spawning a subprocess.  The `sentinelPrompt` parameter
 * must already contain the FOYER_INTERNAL_SENTINEL prefix (the caller's
 * responsibility — `run()` prepends it before calling here).
 *
 * `--setting-sources user` loads only user-level settings from the (empty,
 * isolated) CLAUDE_CONFIG_DIR, explicitly excluding project/local hooks.
 */
export function buildClaudeArgs(sentinelPrompt: string, extraArgs: string[]): string[] {
  return [
    '-p',
    sentinelPrompt,
    '--output-format',
    'json',
    '--setting-sources',
    'user',
    ...extraArgs,
  ];
}

/**
 * Parse { summary, topics } from the LLM's JSON output.
 * Falls back gracefully if JSON is malformed or fields are missing.
 * Shared by ClaudeCliProvider and AnthropicApiProvider.
 */
export function parseActivityJson(raw: string): {
  summary: string;
  topics: SuggestedTopic[];
} {
  // Strip any accidental markdown fences around the JSON
  const cleaned = raw
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/```\s*$/m, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'Agent is working…',
      topics: normalizeTopics(parsed.topics),
    };
  } catch {
    // Unparseable JSON: keep the text as summary, no topics.
    return {
      summary: raw.slice(0, 800) || 'Agent is working…',
      topics: [],
    };
  }
}
