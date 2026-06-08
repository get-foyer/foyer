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
import type { LlmProvider, ResearchResult, ActivityContext, SuggestedTopic } from './index.js';
import {
  stripFences,
  normalizeTopics,
  normalizeGraph,
  RESEARCH_PROMPT,
  parseResearchSections,
} from './text.js';
import { FOYER_INTERNAL_DIR_PREFIX, FOYER_INTERNAL_SENTINEL } from './internal.js';

const execFile = promisify(_execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema', 'mermaid.schema.json');
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

  async generateGraph(planText: string): Promise<string> {
    const prompt = `Convert the following task plan into a concise Mermaid flowchart.
Use "graph TD" (top-down) syntax. Output ONLY the mermaid diagram code — no explanation, no markdown fences.
Focus on the key phases/steps and their dependencies.
Wrap every node label in double quotes so that spaces and special characters are handled correctly — for example A["Read file.ts"] instead of A[Read file.ts].
Keep each node label short (≤ 5 words) so nodes stay compact and readable.

Plan:
${planText.slice(0, 4000)}`; // cap to avoid huge context

    const outFile = join(tmpdir(), `foyer-graph-${Date.now()}.json`);

    try {
      await runCodexWithStdin(prompt, [
        ...FAST_FLAGS,
        '--output-schema',
        SCHEMA_PATH,
        '-o',
        outFile,
      ]);

      const raw = await readFile(outFile, 'utf-8');
      const parsed = JSON.parse(raw) as { mermaid?: string };
      const mermaid = parsed.mermaid ?? raw;
      return stripFences(mermaid);
    } finally {
      await unlink(outFile).catch(() => {});
    }
  }

  async summarizeActivity(
    ctx: ActivityContext,
  ): Promise<{ summary: string; graph: string | null; topics: SuggestedTopic[] }> {
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
      const parsed = JSON.parse(raw) as { summary?: string; graph?: string; topics?: unknown };
      return {
        summary: parsed.summary ?? 'Agent is working…',
        // null = "no workflow warranted this session" → dashboard shows no graph region.
        graph: normalizeGraph(parsed.graph),
        topics: normalizeTopics(parsed.topics),
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
        const url = item.url as string | undefined;
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
  const touchList = ctx.recentTouchPoints
    .slice(0, 10)
    .map((tp) => `  ${tp.tool}: ${tp.path}`)
    .join('\n');

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

  // The :::active rule depends on lifecycle: while working, light the current
  // phase; while waiting, append a reason chip and light THAT; when done there
  // is no "current" phase, so no active marker.
  const activeRule =
    ctx.status === 'waiting'
      ? 'The session is WAITING on the user — append a final node naming why (e.g. "Awaiting your OK") and put :::active on THAT node.'
      : ctx.status === 'done'
        ? 'The session is DONE — the last phase is the end; no :::active marker is required.'
        : 'Put :::active on the single phase the agent is in right now.';

  const previousTopicsList = ctx.previousTopics?.length
    ? ctx.previousTopics.map((t) => `  - ${t.topic}`).join('\n')
    : '(none yet)';

  // Workflow visibility gate (hybrid trigger): when the agent went through plan mode this turn
  // the work is inherently multi-phase, so always draw a graph. Otherwise the model decides —
  // trivial/single-step work returns null and the dashboard shows no workflow region at all.
  const workflowGate = ctx.planned
    ? 'This turn has an APPROVED PLAN (the agent exited plan mode), so the work is inherently multi-phase — you MUST return a graph; do NOT return null.'
    : 'FIRST decide whether this session even warrants a workflow graph. If it is a single-step task, a quick question/answer, or trivial linear work with no real phases, set "graph" to null and skip the rules below — the dashboard will simply show no workflow. Only draw a graph when there are genuine multi-phase milestones (about 3 or more). Never invent phases to fill a graph.';

  return `You are narrating, for a live dashboard, what a coding agent is doing in a session.
The dashboard shows many sessions side by side, so the graph must be a GLANCEABLE FINGERPRINT of THIS session: an engineer should glance once and instantly know what the session is about and where it is.

Given the agent's original task, recent file operations, a tail of the agent's transcript, and the storyline you drew last time, return JSON with three fields:

- "summary": 2-4 sentences of markdown — what the agent is working on at this moment and what it just did. Present tense. No preamble.

- "graph": EITHER null, OR a Mermaid **graph LR** MILESTONE STORYLINE of the session. ${workflowGate} When you DO draw a graph, follow every rule:
  1. Nodes are intent-named PHASES of the work (a goal the agent pursued, e.g. "Diagnose token expiry", "Patch auth flow", "Run tests"). NEVER a raw tool call like "Read file.ts" or "Bash npm test".
  2. The FIRST node is a rounded subject node naming the whole session goal in ≤5 words, derived from the original task, tagged with the goal class — for example: G(["Fix login bug"]):::goal
  3. Then 3-6 phase nodes left-to-right in the order they happened. ${activeRule}
  4. APPEND-ONLY: the previous storyline is given below. Keep its existing node ids, labels, and order UNCHANGED — only append new phases and move the :::active marker. Redraw from scratch ONLY if the task has clearly pivoted.
  5. Hard cap: at most 6 nodes after the goal node. Wrap every label in double quotes — A["…"]. Keep labels ≤ 5 words. Output mermaid only (no code fences).
  6. End with both class definitions exactly:
     classDef goal fill:#161b22,stroke:#4493f8,color:#fff;
     classDef active fill:#1f6feb,stroke:#4493f8,color:#fff;

- "topics": an array of 3-6 research topics worth reading up on while the user waits, derived from THIS session's work — follow every rule:
  1. Each item is { "topic": "...", "reason": "..." }. "topic" is concise and searchable (≤120 chars, e.g. "React useTransition hook"). "reason" is one short line grounding it in the work (≤160 chars, e.g. "you're editing App.tsx which uses useTransition").
  2. Draw from what's actually in play: libraries/APIs being used, concepts the work depends on, error messages seen, unfamiliar terms or commands. Prefer specific over generic ("Mermaid graph LR syntax", not "diagrams").
  3. EXTRACTION ONLY — do NOT search the web; infer topics from the task, files, and transcript provided.
  4. Skip the trivial/obvious (no "what is JavaScript"). If nothing is worth suggesting, return an empty array.
  5. STABILITY: keep the previously-suggested topics below unless the focus has clearly shifted — reuse the same wording so chips don't churn.

${taskSection}

Current session status: ${statusLine}

Recent file operations (newest first):
${touchList || '  (none yet)'}

Recent transcript tail:
${ctx.transcriptTail.slice(0, 3000) || '(no transcript available yet)'}

Previous storyline (extend it, do not redraw):
${ctx.previousGraph ?? '(none yet — this is the first draft)'}

Previously-suggested topics (keep stable unless the focus shifted):
${previousTopicsList}`;
}
