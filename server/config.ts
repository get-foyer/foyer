import { config as loadDotenv } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { configPath } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: configPath() });
loadDotenv({ path: resolve(__dirname, '..', '.env') });

export type ProviderKind = 'codex' | 'claude-cli' | 'anthropic-api';

/** Parse a non-negative integer env var; a missing/garbage/negative value degrades to `fallback`
 *  rather than crashing or going negative. Used by the prefetch knob (a bad value must mean "off",
 *  not undefined behaviour). */
function nonNegInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const cfg = {
  port: parseInt(process.env.FOYER_PORT ?? '4317', 10),
  provider: (process.env.FOYER_PROVIDER ?? 'codex') as ProviderKind,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.FOYER_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
  isDev: process.env.NODE_ENV !== 'production',
  /** Where session state persists. Per-user data dir, never the npm install dir. */
  dataDir: process.env.FOYER_DATA_DIR ?? join(homedir(), '.foyer'),
  /** How many of the viewed session's top suggested topics to speculatively prefetch in the
   *  background so a tap is instant. 0 disables prefetch entirely (pure reactive — ADR 0001). */
  prefetchTopics: nonNegInt(process.env.FOYER_PREFETCH_TOPICS, 3),
} as const;
