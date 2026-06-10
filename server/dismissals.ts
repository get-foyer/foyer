/**
 * Dismissal log — durable record of every committed "NOT USEFUL" on a primary briefing.
 *
 * This is the structured usefulness signal the dogfood loop runs on (eng review D18): which
 * picks were rejected, for which session, when. JSONL in the data dir, append-only,
 * fire-and-forget (a log failure must never break the dismiss route).
 */
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { cfg } from './config.js';

export interface DismissalEntry {
  sessionId: string;
  topic: string;
  reason: string;
  /** Status the primary was in when dismissed (warming/ready/error — read can't be dismissed). */
  status: string;
  ts: number;
}

export async function appendDismissal(entry: DismissalEntry): Promise<void> {
  try {
    await mkdir(cfg.dataDir, { recursive: true });
    await appendFile(join(cfg.dataDir, 'dismissals.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.error('[dismissals] append failed:', err instanceof Error ? err.message : err);
  }
}
