/**
 * Codex CLI provider.
 *
 * Shells out to `codex exec` using the user's ChatGPT subscription.
 * Does NOT fire Claude Code hooks, so no self-trigger loop.
 *
 * Detection: `codex login status` → contains "Logged in"
 */
import { execFile as _execFile, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile, unlink } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { LlmProvider, ResearchResult } from './index.js';

const execFile = promisify(_execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema', 'mermaid.schema.json');

const BASE_FLAGS = ['-s', 'read-only', '-a', 'never', '--skip-git-repo-check', '--ephemeral'];
const FAST_FLAGS = [...BASE_FLAGS, '-c', 'model_reasoning_effort=low'];

export class CodexProvider implements LlmProvider {
  readonly id = 'codex' as const;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFile('codex', ['login', 'status'], { timeout: 5_000 });
      return stdout.toLowerCase().includes('logged in');
    } catch {
      return false;
    }
  }

  async generateGraph(planText: string): Promise<string> {
    const prompt = `Convert the following task plan into a concise Mermaid flowchart.
Use "graph TD" (top-down) syntax. Output ONLY the mermaid diagram code — no explanation, no markdown fences.
Focus on the key phases/steps and their dependencies.

Plan:
${planText.slice(0, 4000)}`; // cap to avoid huge context

    const outFile = join(tmpdir(), `foyer-graph-${Date.now()}.json`);

    try {
      await runCodexWithStdin(prompt, [
        ...FAST_FLAGS,
        '--output-schema', SCHEMA_PATH,
        '-o', outFile,
      ]);

      const raw = await readFile(outFile, 'utf-8');
      const parsed = JSON.parse(raw) as { mermaid?: string };
      const mermaid = parsed.mermaid ?? raw;
      return stripFences(mermaid);
    } finally {
      await unlink(outFile).catch(() => {});
    }
  }

  async research(topic: string): Promise<ResearchResult> {
    const prompt = `Produce a concise research briefing on: "${topic}"
Include: a 2-3 paragraph summary of current knowledge, key findings, and 5 relevant sources.
Format the sources at the end as a numbered list with title and URL.`;

    const eventsFile = join(tmpdir(), `foyer-research-${Date.now()}.jsonl`);

    try {
      await runCodexWithStdin(prompt, [
        ...FAST_FLAGS,
        '--search',
        '--json',
      ], eventsFile);

      return parseCodexResearchOutput(eventsFile);
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
  stdoutFile?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const outStream = stdoutFile ? createWriteStream(stdoutFile) : 'pipe';

    const child = spawn('codex', ['exec', '-', ...args], {
      stdio: ['pipe', outStream as 'pipe', 'pipe'],
      timeout: 120_000,
      env: {
        ...process.env,
        // Ensure we don't accidentally inject API keys that would override subscription auth
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
    });

    child.stdin.write(prompt, 'utf-8');
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
}

async function parseCodexResearchOutput(eventsFile: string): Promise<ResearchResult> {
  const content = await readFile(eventsFile, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  let summary = '';
  const links: { title: string; url: string }[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) continue;

      // Agent message = the briefing text
      if (item.type === 'agent_message') {
        const content = item.content;
        if (typeof content === 'string') {
          summary = content;
        } else if (Array.isArray(content)) {
          summary = (content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n');
        }
      }

      // Web search result items carry source URLs
      if (item.type === 'web_search') {
        const url = item.url as string | undefined;
        const title = (item.title as string | undefined) ?? (item.query as string | undefined) ?? url ?? '';
        if (url) links.push({ title, url });
      }
    } catch {
      // Skip malformed JSONL lines
    }
  }

  // If the final agent message contains URLs in a numbered list, extract them too
  if (links.length === 0) {
    const urlPattern = /(?:https?:\/\/[^\s)>\]]+)/g;
    const found = summary.match(urlPattern) ?? [];
    for (const url of found) {
      links.push({ title: url, url });
    }
  }

  return { summary: summary || 'No summary returned.', links };
}

function stripFences(code: string): string {
  return code
    .replace(/^```(?:mermaid)?\n?/m, '')
    .replace(/```\s*$/m, '')
    .trim();
}
