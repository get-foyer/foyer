import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '..', '.env') });

export type ProviderKind = 'codex' | 'claude-cli' | 'anthropic-api';

export const cfg = {
  port: parseInt(process.env.FOYER_PORT ?? '4317', 10),
  provider: (process.env.FOYER_PROVIDER ?? 'codex') as ProviderKind,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.FOYER_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
  isDev: process.env.NODE_ENV !== 'production',
} as const;
