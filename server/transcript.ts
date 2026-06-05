/**
 * Fallback plan extraction.
 *
 * When ExitPlanMode fires, the plan lives in a file under ~/.claude/plans/.
 * We try two strategies in order:
 *   1. Read the plan path embedded in transcript_path (the JSONL) — look for
 *      the most recent Write call to a plans/XXXXXX.md file.
 *   2. Just pick the newest *.md file in ~/.claude/plans/.
 */
import { readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const PLANS_DIR = join(homedir(), '.claude', 'plans');

/** Try to extract the plan text for a given session from the transcript. */
export async function extractPlanFromTranscript(transcriptPath: string): Promise<string | null> {
  try {
    const planPath = await findPlanPathInTranscript(transcriptPath);
    if (planPath) {
      return await readFile(planPath, 'utf-8');
    }
  } catch {
    // fall through
  }
  return null;
}

/** Find the most recently written plans/*.md path by scanning the JSONL transcript. */
async function findPlanPathInTranscript(transcriptPath: string): Promise<string | null> {
  const rl = createInterface({
    input: createReadStream(transcriptPath),
    crlfDelay: Infinity,
  });

  let latestPlanPath: string | null = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Look for a Write or Edit tool call to a plans/*.md file
      const toolName: string | undefined = entry.tool_name ?? entry.toolName;
      const toolInput: Record<string, unknown> | undefined =
        entry.tool_input ?? entry.toolInput ?? entry.input;
      const filePath: string | undefined =
        typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined;

      if ((toolName === 'Write' || toolName === 'Edit') && filePath?.includes('/plans/') && filePath.endsWith('.md')) {
        latestPlanPath = filePath;
      }
    } catch {
      // Malformed line; skip
    }
  }

  return latestPlanPath;
}

/** Fallback: return the content of the newest .md file in ~/.claude/plans/ */
export async function extractNewestPlan(): Promise<string | null> {
  try {
    const files = await readdir(PLANS_DIR);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    if (mdFiles.length === 0) return null;

    // Sort by mtime descending, pick newest
    const withStats = await Promise.all(
      mdFiles.map(async (f) => {
        const fullPath = join(PLANS_DIR, f);
        const s = await stat(fullPath);
        return { fullPath, mtime: s.mtimeMs };
      })
    );
    withStats.sort((a, b) => b.mtime - a.mtime);
    return await readFile(withStats[0].fullPath, 'utf-8');
  } catch {
    return null;
  }
}
