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
import type { LlmProvider, ResearchResult, ActivityContext, SuggestedTopic } from './index.js';
import { RESEARCH_PROMPT, parseResearchSections } from './text.js';

export class AnthropicApiProvider implements LlmProvider {
  readonly id = 'anthropic-api' as const;
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      if (!cfg.anthropicApiKey) {
        throw new Error(
          'ANTHROPIC_API_KEY is not set. Run `foyer setup` to configure your API key.',
        );
      }
      this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    }
    return this.client;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(cfg.anthropicApiKey?.startsWith('sk-ant-'));
  }

  async summarizeActivity(
    ctx: ActivityContext,
  ): Promise<{ summary: string; topics: SuggestedTopic[] }> {
    const { buildActivityPrompt } = await import('./codex.js');
    const { parseActivityJson } = await import('./claudeCli.js');
    const client = this.getClient();

    const prompt = buildActivityPrompt(ctx);
    const response = await client.messages.create({
      model: cfg.anthropicModel,
      // Sized to fit the summary + topics array.
      max_tokens: 1536,
      // No web_search — this is summarisation, not research; keeps cost low
      messages: [
        {
          role: 'user',
          content: `${prompt}\n\nRespond with ONLY a JSON object matching this schema: { "summary": string, "topics": Array<{ "topic": string, "reason": string }> }. No markdown fences, no explanation.`,
        },
      ],
    });

    const text = extractText(response.content);
    return parseActivityJson(text);
  }

  async research(topic: string): Promise<ResearchResult> {
    const client = this.getClient();

    type Msg = Anthropic.MessageParam;
    // Anthropic searches via the model, so it prepends the search instruction to the shared prompt.
    const messages: Msg[] = [
      {
        role: 'user',
        content: `Search the web for current information.\n\n${RESEARCH_PROMPT(topic)}`,
      },
    ];

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
          {
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: 5,
          } as unknown as Anthropic.Tool,
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
            for (const cite of blockAny.citations as Array<{ url?: string; title?: string }>) {
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

    // Citations from the web_search blocks are the authoritative sources (real fetched URLs);
    // fall back to the model's self-reported sources only if the API surfaced no citations.
    const { lede, sections, sources } = parseResearchSections(finalText, topic);
    return { lede, sections, links: deduped.length ? deduped : sources };
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
