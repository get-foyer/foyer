import type { ResearchLink } from '../../src/types.js';
import type { ProviderKind } from '../config.js';

export interface ResearchResult {
  summary: string;
  links: ResearchLink[];
}

/** The contract every LLM backend must implement. */
export interface LlmProvider {
  readonly id: ProviderKind;
  isAvailable(): Promise<boolean>;
  /** Convert a plan text to Mermaid graph TD syntax. */
  generateGraph(planText: string): Promise<string>;
  /** Return a sourced research briefing for a topic. */
  research(topic: string): Promise<ResearchResult>;
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
    candidates.map(async (p) => ({ id: p.id, available: await p.isAvailable() }))
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
