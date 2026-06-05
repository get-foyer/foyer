/**
 * Anthropic API provider (BYOK).
 *
 * Uses the @anthropic-ai/sdk with web_search_20260209 for research.
 * Handles stop_reason:"pause_turn" with a continuation loop.
 *
 * Requires ANTHROPIC_API_KEY to be set.
 */
import Anthropic from '@anthropic-ai/sdk';
import { cfg } from '../config.js';
import type { LlmProvider, ResearchResult } from './index.js';

const GRAPH_PROMPT = (plan: string) =>
  `Convert the following task plan into a concise Mermaid flowchart.
Use "graph TD" (top-down) syntax. Output ONLY the mermaid diagram code — no explanation, no markdown fences.

Plan:
${plan.slice(0, 8000)}`;

const RESEARCH_PROMPT = (topic: string) =>
  `Produce a concise research briefing on: "${topic}"
Search the web for current information. Include: a 2-3 paragraph summary of key findings and cite 5 relevant sources.
Format sources as a numbered list (title — URL) at the end of your response.`;

export class AnthropicApiProvider implements LlmProvider {
  readonly id = 'anthropic-api' as const;
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      if (!cfg.anthropicApiKey) {
        throw new Error(
          'ANTHROPIC_API_KEY is not set. Run `npm run setup` to configure your API key.'
        );
      }
      this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    }
    return this.client;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(cfg.anthropicApiKey?.startsWith('sk-ant-'));
  }

  async generateGraph(planText: string): Promise<string> {
    const client = this.getClient();
    const response = await client.messages.create({
      model: cfg.anthropicModel,
      max_tokens: 1024,
      messages: [{ role: 'user', content: GRAPH_PROMPT(planText) }],
    });

    const text = extractText(response.content);
    return stripFences(text);
  }

  async research(topic: string): Promise<ResearchResult> {
    const client = this.getClient();

    type Msg = Anthropic.MessageParam;
    const messages: Msg[] = [{ role: 'user', content: RESEARCH_PROMPT(topic) }];

    let finalText = '';
    const links: { title: string; url: string }[] = [];
    let continuations = 0;
    const MAX_CONTINUATIONS = 5;

    // Loop to handle stop_reason: "pause_turn" (multi-step web search)
    while (continuations <= MAX_CONTINUATIONS) {
      const response = await client.messages.create({
        model: cfg.anthropicModel,
        max_tokens: 4096,
        tools: [
          // Types: don't annotate as Anthropic.Tool[] — server tools are a different shape
          { type: 'web_search_20260209', name: 'web_search', max_uses: 5 } as unknown as Anthropic.Tool,
        ],
        messages,
      });

      // Collect text and source URLs from this turn
      for (const block of response.content) {
        if (block.type === 'text') {
          finalText += block.text;
          // Extract citations if present
          const blockAny = block as unknown as Record<string, unknown>;
          if ('citations' in blockAny && Array.isArray(blockAny.citations)) {
            for (const cite of (blockAny.citations as Array<{ url?: string; title?: string }>) ) {
              if (cite.url) {
                links.push({ title: cite.title ?? cite.url, url: cite.url });
              }
            }
          }
        }
        // web_search_tool_result blocks contain the raw search results (source URLs)
        if ((block.type as string) === 'web_search_tool_result') {
          const b = block as { content?: Array<{ url?: string; title?: string }> };
          for (const item of b.content ?? []) {
            if (item.url) links.push({ title: item.title ?? item.url, url: item.url });
          }
        }
      }

      if (response.stop_reason === 'end_turn') {
        break;
      }

      if (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
        // Continue: re-send user message + assistant content so far
        // DO NOT add a "Continue." message — API auto-detects the trailing server_tool_use
        messages.push({ role: 'assistant', content: response.content });
        continuations++;
        continue;
      }

      break;
    }

    // Deduplicate links
    const seen = new Set<string>();
    const deduped = links.filter(({ url }) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });

    return { summary: finalText || 'No summary returned.', links: deduped };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function stripFences(code: string): string {
  return code
    .replace(/^```(?:mermaid)?\n?/m, '')
    .replace(/```\s*$/m, '')
    .trim();
}
