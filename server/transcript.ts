/**
 * Transcript tail reader.
 *
 * Reads the last N bytes of a Claude Code JSONL transcript and emits a compact
 * text blob summarising recent agent activity (tool calls, assistant text).
 * Used by server/activity.ts to build context for the LLM summarisation call.
 *
 * Format notes (verified against real transcripts):
 *   - Each line is a JSON object with a `type` field.
 *   - `type: "assistant"` entries carry `message.content` — an array of blocks:
 *       { type: "text", text: "..." }
 *       { type: "tool_use", name: "ToolName", input: { file_path?, command?, ... } }
 *       { type: "thinking", thinking: "..." }  (omitted — too verbose)
 *   - `type: "user"` entries carry tool_result blocks (omitted — server-side noise).
 *   - Other types (summary, meta, etc.) are skipped.
 */
import { stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

/** Max bytes read from the end of the transcript file. */
const TAIL_BYTES = 16384;
/** Max characters in the text blob sent to the LLM. */
const MAX_CHARS = 4000;

/**
 * Read the tail of a JSONL transcript and return a compact text blob
 * summarising recent agent activity.
 *
 * Returns an empty string if the file does not exist or cannot be read.
 */
export async function readTranscriptTail(
  transcriptPath: string,
  maxBytes: number = TAIL_BYTES,
): Promise<string> {
  let fileSize: number;
  try {
    const s = await stat(transcriptPath);
    fileSize = s.size;
  } catch {
    return ''; // file not found or inaccessible
  }

  const start = Math.max(0, fileSize - maxBytes);
  const stream = createReadStream(transcriptPath, { start, encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }

  // Drop the first line — it may be a partial line from the byte-offset cut
  const safeLines = start > 0 ? lines.slice(1) : lines;

  const parts: string[] = [];
  for (const line of safeLines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const type = entry.type as string | undefined;

      if (type === 'assistant') {
        const msg = entry.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content as Array<Record<string, unknown>>) {
          const btype = block.type as string | undefined;

          if (btype === 'text') {
            const text = (block.text as string | undefined) ?? '';
            if (text.trim()) {
              parts.push(`[assistant] ${text.slice(0, 500)}`);
            }
          } else if (btype === 'tool_use') {
            const name = (block.name as string | undefined) ?? 'unknown';
            const input = (block.input as Record<string, unknown> | undefined) ?? {};
            // Extract the most useful input field depending on tool type
            const filePath = input.file_path ?? input.path;
            const command = input.command;
            const detail = filePath
              ? String(filePath)
              : command
                ? String(command).slice(0, 120)
                : '';
            parts.push(detail ? `[tool:${name}] ${detail}` : `[tool:${name}]`);
          }
          // skip: thinking, tool_result — too verbose or server-noise
        }
      }
    } catch {
      // Malformed JSONL line — skip without throwing
    }
  }

  const blob = parts.join('\n');
  return blob.slice(0, MAX_CHARS);
}

/**
 * Read the HEAD of a JSONL transcript and return the original user prompt — the
 * first genuine user message, which is the task the developer typed.
 *
 * Used by server/hooks.ts to give a resumed/picked-up session a real tab title
 * instead of the "(resumed session)" placeholder, when Foyer first sees a session
 * via a PostToolUse/Notification hook (mid-turn) rather than UserPromptSubmit.
 *
 * Returns `null` if the file is missing/unreadable or no user prompt is found in
 * the first `maxBytes`. The caller is expected to fall back to a weaker title.
 */
export async function readFirstUserPrompt(
  transcriptPath: string,
  maxBytes: number = TAIL_BYTES,
): Promise<string | null> {
  let fileSize: number;
  try {
    const s = await stat(transcriptPath);
    fileSize = s.size;
  } catch {
    return null; // file not found or inaccessible
  }

  const stream = createReadStream(transcriptPath, {
    start: 0,
    end: maxBytes - 1,
    encoding: 'utf-8',
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }

  // Only when the file was actually truncated by maxBytes is the last line possibly
  // a partial cut — drop it then. If the whole file fit, every line is complete.
  const truncated = fileSize > maxBytes;
  const safeLines = truncated && lines.length > 1 ? lines.slice(0, -1) : lines;

  for (const line of safeLines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // malformed JSONL line — skip without throwing
    }

    if (entry.type !== 'user') continue;
    if (entry.isMeta === true) continue; // Claude Code injected/meta message

    const msg = entry.message as Record<string, unknown> | undefined;
    const content = msg?.content;

    // Content is either a plain string, or an array of blocks (text / tool_result).
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text = block.text;
          break; // first text block wins; tool_result blocks are ignored
        }
      }
    }

    // Strip system-reminder wrappers the harness injects into the first message.
    const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!cleaned) continue;

    // Skip slash-command / local-command / caveat wrappers — not the real task.
    if (
      cleaned.startsWith('<command-name>') ||
      cleaned.startsWith('<command-message>') ||
      cleaned.startsWith('<local-command-stdout>') ||
      cleaned.startsWith('Caveat:')
    ) {
      continue;
    }

    return cleaned.slice(0, 200).trim();
  }

  return null;
}

/**
 * Returns the byte size of the transcript file, or null if it does not exist.
 * Used by server/activity.ts for skip-if-unchanged change detection.
 */
export async function getTranscriptSize(transcriptPath: string): Promise<number | null> {
  try {
    const s = await stat(transcriptPath);
    return s.size;
  } catch {
    return null;
  }
}

/**
 * Returns the last-modified time (ms since epoch) of the transcript file, or null if it
 * does not exist. Used by the stale-session watcher to detect when Claude has exited.
 */
export async function getTranscriptMtime(transcriptPath: string): Promise<number | null> {
  try {
    const s = await stat(transcriptPath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Read all content from startOffset to end-of-file.
 * Returns an empty string if the file doesn't exist or startOffset >= file size.
 */
export async function readTranscriptFrom(
  transcriptPath: string,
  startOffset: number,
): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const stream = createReadStream(transcriptPath, { start: startOffset, encoding: 'utf-8' });
    stream.on('data', (chunk) => {
      data += chunk as string;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(''));
  });
}
