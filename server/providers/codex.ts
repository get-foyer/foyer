/**
 * Codex CLI provider.
 *
 * Shells out to `codex exec` using the user's ChatGPT subscription.
 *
 * ⚠️ Codex DOES fire its own lifecycle hooks (not Claude Code hooks), which
 * Foyer installs in ~/.codex/config.toml.  Self-trigger isolation uses two
 * layers:
 *  1. `-c features.hooks=false` in BASE_FLAGS disables Codex hooks for the
 *     subprocess at runtime.
 *  2. Every prompt is prefixed with FOYER_INTERNAL_SENTINEL so the server-side
 *     guard in hooks.ts drops any event that leaks through anyway.
 *  3. The subprocess runs from an isolated cwd (belt-and-suspenders).
 *
 * Detection: `codex login status` → contains "Logged in"
 */
import { execFile as _execFile, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile, unlink, mkdtemp, rm } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { LlmProvider, ResearchResult, ActivityContext, ActivityOutput } from './index.js';
import {
  normalizeTopics,
  normalizePrimary,
  RESEARCH_PROMPT,
  parseResearchSections,
} from './text.js';
import { FOYER_INTERNAL_DIR_PREFIX, FOYER_INTERNAL_SENTINEL } from './internal.js';
import { sanitizeUrl } from '../../src/lib/url.js';

const execFile = promisify(_execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ACTIVITY_SCHEMA_PATH = join(__dirname, 'schema', 'activity.schema.json');

// features.hooks=false disables Codex's own lifecycle hooks at runtime so the
// internal codex exec calls don't POST back to our /hook endpoint.
// Exported so tests can assert the flag is present (see codex.test.ts).
export const BASE_FLAGS = [
  '-s',
  'read-only',
  '-a',
  'never',
  '--skip-git-repo-check',
  '--ephemeral',
  '-c',
  'features.hooks=false',
];
const FAST_FLAGS = [...BASE_FLAGS, '-c', 'model_reasoning_effort=low'];

export class CodexProvider implements LlmProvider {
  readonly id = 'codex' as const;

  async isAvailable(): Promise<boolean> {
    try {
      // `codex login status` prints to stderr, not stdout
      const { stdout, stderr } = await execFile('codex', ['login', 'status'], { timeout: 5_000 });
      const output = (stdout + stderr).toLowerCase();
      return output.includes('logged in');
    } catch {
      return false;
    }
  }

  async summarizeActivity(ctx: ActivityContext): Promise<ActivityOutput> {
    const prompt = buildActivityPrompt(ctx);
    const outFile = join(tmpdir(), `foyer-activity-${Date.now()}.json`);

    try {
      await runCodexWithStdin(prompt, [
        ...FAST_FLAGS,
        '--output-schema',
        ACTIVITY_SCHEMA_PATH,
        '-o',
        outFile,
      ]);

      const raw = await readFile(outFile, 'utf-8');
      const parsed = JSON.parse(raw) as { summary?: string; topics?: unknown; primary?: unknown };
      const topics = normalizeTopics(parsed.topics);
      return {
        summary: parsed.summary ?? 'Agent is working…',
        topics,
        // Old-shape output (no primary field) parses unchanged: normalizePrimary(undefined) → null.
        primary: normalizePrimary(parsed.primary, topics),
      };
    } finally {
      await unlink(outFile).catch(() => {});
    }
  }

  async research(topic: string): Promise<ResearchResult> {
    // Keep `--search --json`: search runs as events, the final agent_message carries our
    // briefing JSON. This deliberately avoids `--output-schema` for research (whose
    // composition with `--search` is unverified) — parseResearchSections handles the
    // agent_message text with a single-section fallback.
    const eventsFile = join(tmpdir(), `foyer-research-${Date.now()}.jsonl`);

    try {
      await runCodexWithStdin(
        RESEARCH_PROMPT(topic),
        [...FAST_FLAGS, '--search', '--json'],
        eventsFile,
      );

      return parseCodexResearchOutput(eventsFile, topic);
    } finally {
      await unlink(eventsFile).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCodexWithStdin(
  prompt: string,
  args: string[],
  stdoutFile?: string,
): Promise<void> {
  // Isolation: run from a throw-away cwd so any cwd-sensitive hooks don't
  // pick up project config; prefix the prompt with the sentinel as a backstop.
  const isolatedDir = await mkdtemp(join(tmpdir(), FOYER_INTERNAL_DIR_PREFIX));
  const sentinelPrompt = `${FOYER_INTERNAL_SENTINEL}\n${prompt}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const outStream = stdoutFile ? createWriteStream(stdoutFile) : 'pipe';

      const child = spawn('codex', ['exec', '-', ...args], {
        cwd: isolatedDir,
        stdio: ['pipe', outStream as 'pipe', 'pipe'],
        timeout: 120_000,
        env: {
          ...process.env,
          // Ensure we don't accidentally inject API keys that would override subscription auth
          OPENAI_API_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
        },
      });

      child.stdin.write(sentinelPrompt, 'utf-8');
      child.stdin.end();

      const stderr: string[] = [];
      child.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`codex exec exited ${code}: ${stderr.join('')}`));
        }
      });
    });
  } finally {
    await rm(isolatedDir, { recursive: true, force: true });
  }
}

export async function parseCodexResearchOutput(
  eventsFile: string,
  topic: string,
): Promise<ResearchResult> {
  const content = await readFile(eventsFile, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  let agentMessage = '';
  const links: { title: string; url: string }[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) continue;

      // Agent message = the briefing JSON
      if (item.type === 'agent_message') {
        const content = item.content;
        if (typeof content === 'string') {
          agentMessage = content;
        } else if (Array.isArray(content)) {
          agentMessage = (content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n');
        }
      }

      // Web search result items carry source URLs
      if (item.type === 'web_search') {
        // LLM/search-sourced URL ends up in an <a href> — only http(s) survives.
        const url = typeof item.url === 'string' ? sanitizeUrl(item.url) : null;
        const title =
          (item.title as string | undefined) ?? (item.query as string | undefined) ?? url ?? '';
        if (url) links.push({ title, url });
      }
    } catch {
      // Skip malformed JSONL lines
    }
  }

  // Web-search events are the authoritative sources; fall back to the model's self-reported
  // `sources` only when the run surfaced no search events.
  const seen = new Set<string>();
  const deduped = links.filter(({ url }) => (seen.has(url) ? false : (seen.add(url), true)));
  const { lede, sections, sources } = parseResearchSections(agentMessage, topic);
  return { lede, sections, links: deduped.length ? deduped : sources };
}

export function buildActivityPrompt(ctx: ActivityContext): string {
  // Focus anchor (D4): pin the session GOAL (first prompt) + CURRENT focus (latest prompt),
  // with the middle turns compacted to one line each. Keeps the goal anchored even after it
  // has scrolled out of the transcript tail, without dumping every verbatim turn into context.
  const prompts = ctx.prompts?.length ? ctx.prompts : [ctx.prompt];
  const taskSection =
    prompts.length === 1
      ? `Original task: ${prompts[0].slice(0, 500)}`
      : [
          `Session goal (first request): ${prompts[0].slice(0, 300)}`,
          prompts.length > 2
            ? `Earlier turns (oldest first):\n${prompts
                .slice(1, -1)
                .slice(-8)
                .map((p) => `  - ${p.replace(/\s+/g, ' ').slice(0, 80)}`)
                .join('\n')}`
            : null,
          `Current focus (latest request): ${prompts[prompts.length - 1].slice(0, 300)}`,
          'Narrate progress across the WHOLE session, weighted toward the current focus.',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 1500);

  const statusLine =
    ctx.status === 'waiting'
      ? `waiting on the user${ctx.waitingReason ? ` — ${ctx.waitingReason}` : ''}`
      : ctx.status;

  const previousTopicsList = ctx.previousTopics?.length
    ? ctx.previousTopics.map((t) => `  - ${t.topic}`).join('\n')
    : '(none yet)';

  const touchedSection = ctx.touchedAreas?.length
    ? `Repo areas the agent's tool calls are touching (most active first):\n${ctx.touchedAreas
        .map((a) => `  - ${a}`)
        .join('\n')}`
    : '';

  const docsSection = ctx.docSnippets?.length
    ? `Project docs that match this session's context (path · title · first paragraph):\n${ctx.docSnippets
        .map((d) => `  - ${d.path} · ${d.title} · ${d.snippet.replace(/\s+/g, ' ').slice(0, 300)}`)
        .join('\n')}`
    : '';

  const currentPrimaryLine = ctx.currentPrimary
    ? `Current PRIMARY topic: "${ctx.currentPrimary.topic}" (status: ${ctx.currentPrimary.status})`
    : 'Current PRIMARY topic: (none yet)';

  return `You are narrating, for a live dashboard, what a coding agent is doing in a session.
The dashboard shows many sessions side by side, so the summary must read at a glance: an engineer should glance once and instantly know what the session is about and where it is.

Given the agent's original task and a tail of the agent's transcript, return JSON with three fields:

- "summary": 2-4 sentences of markdown — what the agent is working on at this moment and what it just did. Present tense. No preamble.

- "topics": an array of 3-6 research topics worth reading up on while the user waits, derived from THIS session's work — follow every rule:
  1. Each item is { "topic": "...", "reason": "..." }. "topic" is concise and searchable (≤120 chars, e.g. "React useTransition hook"). "reason" is one short line grounding it in the work (≤160 chars, e.g. "you're editing App.tsx which uses useTransition").
  2. Draw from what's actually in play, and make each topic answerable from PUBLIC/WEB knowledge: a named library, API, language feature, algorithm, protocol, error message, or industry concept. Prefer specific over generic ("Zod schema refinement", not "validation").
  3. WEB-RESEARCHABLE ONLY — every chip is answered later by a live WEB SEARCH with no access to this project's code. NEVER suggest a topic about this repo's own internal design, file/module structure, naming, or proprietary architecture (e.g. "Foyer's provider abstraction", "this session's persistence layout"). If the only interesting subject is project-internal, reframe it as the underlying public concept (e.g. "write-through cache patterns") or omit it.
  4. EXTRACTION ONLY — do NOT search the web while suggesting; infer topics from the task, files, and transcript provided.
  5. Skip the trivial/obvious (no "what is JavaScript"). If nothing is worth suggesting, return an empty array.
  6. STABILITY: keep the previously-suggested topics below unless the focus has clearly shifted — reuse the same wording so chips don't churn.

- "primary": which ONE topic from your "topics" array is THE most valuable read for understanding THIS task right now, or null. Rules:
  1. Either { "topic": "<exact text of one item in topics>", "reason": "<specific one-line why-now, ≤80 chars>" } or null.
  2. The "reason" must be SPECIFIC and grounded — name the area or doc that makes it primary (e.g. "the session is editing server/providers + security hooks"). Never generic filler.
  3. Return null when no topic is a clearly valuable read (a generic pick is worse than none) — null is a normal, expected answer for thin context.
  4. STICKINESS: a current PRIMARY topic is listed below. Propose a DIFFERENT topic ONLY if the task has meaningfully shifted away from it. If the current primary is still the right read, return null (null = keep it). Do not churn the primary between near-equivalent picks.

${taskSection}

Current session status: ${statusLine}
${touchedSection ? `\n${touchedSection}\n` : ''}${docsSection ? `\n${docsSection}\n` : ''}
Recent transcript tail:
${ctx.transcriptTail.slice(0, 3000) || '(no transcript available yet)'}

Previously-suggested topics (keep stable unless the focus shifted):
${previousTopicsList}

${currentPrimaryLine}`;
}
