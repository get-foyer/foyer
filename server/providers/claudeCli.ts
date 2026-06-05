/**
 * Claude CLI provider.
 *
 * Shells out to `claude -p` using the user's Claude subscription.
 *
 * Self-trigger guard: runs with an isolated CLAUDE_CONFIG_DIR that has NO
 * hooks installed, so the internal claude -p call never POSTs to our own
 * /hook endpoint and creates phantom tasks.
 *
 * ⚠️ Warning: from 2026-06-15, subscription headless usage draws from a
 * separate monthly "Agent SDK credit" pool — the setup wizard surfaces this.
 */
import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import type { LlmProvider, ResearchResult } from './index.js';

const execFile = promisify(_execFile);

const GRAPH_PROMPT = (plan: string) =>
  `Convert the following task plan into a concise Mermaid flowchart.
Use "graph TD" (top-down) syntax. Output ONLY the mermaid diagram code — no explanation, no markdown fences.

Plan:
${plan.slice(0, 4000)}`;

const RESEARCH_PROMPT = (topic: string) =>
  `Produce a concise research briefing on: "${topic}"
Include: a 2-3 paragraph summary, key insights, and cite 5 relevant sources (title + URL).
Format sources as a numbered list at the end.`;

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

  async generateGraph(planText: string): Promise<string> {
    const result = await this.run(GRAPH_PROMPT(planText), []);
    return stripFences(result);
  }

  async research(topic: string): Promise<ResearchResult> {
    const result = await this.run(RESEARCH_PROMPT(topic), [
      '--allowedTools', 'WebSearch,WebFetch',
      '--output-format', 'text',
    ]);
    return parseResearchText(result);
  }

  private async run(prompt: string, extraArgs: string[]): Promise<string> {
    // Create a throw-away config dir with NO hooks so we don't self-trigger
    const isolatedConfigDir = await mkdtemp(join(tmpdir(), 'foyer-claude-'));
    try {
      const { stdout } = await execFile(
        'claude',
        ['-p', prompt, '--output-format', 'json', ...extraArgs],
        {
          timeout: 90_000,
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: isolatedConfigDir,
            // Explicitly unset API key so subscription auth is used
            ANTHROPIC_API_KEY: undefined,
          },
        }
      );
      const parsed = JSON.parse(stdout) as { result?: string };
      return parsed.result ?? stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      // Try to extract result from partial stdout
      if (e.stdout) {
        try {
          const parsed = JSON.parse(e.stdout) as { result?: string };
          if (parsed.result) return parsed.result;
        } catch { /* ignore */ }
      }
      throw new Error(`claude -p failed: ${e.message ?? String(err)}`);
    } finally {
      await rm(isolatedConfigDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripFences(code: string): string {
  return code
    .replace(/^```(?:mermaid)?\n?/m, '')
    .replace(/```\s*$/m, '')
    .trim();
}

function parseResearchText(text: string): ResearchResult {
  // Extract URLs from the text — the model formats them as a numbered list
  const urlPattern = /(?:https?:\/\/[^\s)>\]]+)/g;
  const urlMatches = text.match(urlPattern) ?? [];

  // Try to extract title-URL pairs from "1. Title — URL" or "1. [Title](URL)" patterns
  const links: { title: string; url: string }[] = [];
  const numberedPattern = /\d+\.\s+([^\n]+?)\s*—\s*(https?:\/\/\S+)/g;
  const mdLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

  let match;
  while ((match = numberedPattern.exec(text)) !== null) {
    links.push({ title: match[1].trim(), url: match[2].trim() });
  }
  while ((match = mdLinkPattern.exec(text)) !== null) {
    links.push({ title: match[1].trim(), url: match[2].trim() });
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const dedupedLinks = [...links, ...urlMatches.map((u) => ({ title: u, url: u }))]
    .filter(({ url }) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .slice(0, 8);

  return { summary: text, links: dedupedLinks };
}
