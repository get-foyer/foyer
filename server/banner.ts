/**
 * Foyer — terminal banner.
 *
 * A one-shot ASCII animation for the setup wizard: amber panels part from the
 * centre to reveal the FOYER wordmark, then the animation settles into a
 * static banner. Honors the "Instrument" aesthetic in DESIGN.md (warm-black,
 * one signal-amber accent #ffb020, crisp box-drawing, mechanical motion).
 *
 * Degrades safely: non-TTY / CI / NO_COLOR / narrow terminals / FOYER_BANNER
 * opt-out all fall back to a single plain static line (or nothing). The wordmark
 * is rendered as the literal text "FOYER" so logs and screen-readers keep
 * meaning even when color is stripped.
 */

export type BannerMode = 'animate' | 'static' | 'off';
export type ColorLevel = 'truecolor' | 'ansi256' | 'none';

// Geometry of the banner. INNER is the interior width between the │ │ borders.
const INNER = 30;
const WORDMARK = 'FOYER';
const INDENT = '  ';
const DOOR = '▓';
const STEPS = 6;
const FRAME_MS = 110;
/** Below this terminal width we skip the animation and print a plain line. */
const MIN_WIDTH = 44;

// ANSI control sequences (animation path only — never in the static string).
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';
const RESET = '\x1b[0m';

interface Palette {
  amber: string;
  amberHi: string;
  dim: string;
  reset: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isTruthyFlag(value: string | undefined): boolean {
  return value != null && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Decide how much color the terminal can take. Pure function of env + stream so
 * it is trivially testable. FORCE_COLOR overrides upward; NO_COLOR forces none.
 */
export function colorSupport(
  env: NodeJS.ProcessEnv = process.env,
  stream: NodeJS.WriteStream = process.stdout,
): ColorLevel {
  const fc = env.FORCE_COLOR;
  if (fc === '0' || fc?.toLowerCase() === 'false') return 'none';
  if (env.NO_COLOR != null) return 'none';
  if (fc === '3') return 'truecolor';
  if (fc != null && fc !== '') return 'ansi256';
  if (!stream.isTTY) return 'none';
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor';
  return 'ansi256';
}

/**
 * Decide whether to animate, print a static banner, or stay silent. Pure
 * function of env + stream. See the decision matrix in the setup plan / DESIGN.md.
 */
export function bannerMode(
  env: NodeJS.ProcessEnv = process.env,
  stream: NodeJS.WriteStream = process.stdout,
): BannerMode {
  const pref = (env.FOYER_BANNER ?? '').toLowerCase();
  if (pref === 'off') return 'off';
  if (pref === 'static') return 'static';
  if (!stream.isTTY) return 'static';
  if (isTruthyFlag(env.CI)) return 'static';
  if ((stream.columns ?? 80) < MIN_WIDTH) return 'static';
  if (env.NO_COLOR != null) return 'static';
  return 'animate';
}

function palette(level: ColorLevel): Palette {
  if (level === 'truecolor') {
    return {
      amber: '\x1b[38;2;255;176;32m',
      amberHi: '\x1b[38;2;255;196;77m',
      dim: '\x1b[38;2;167;156;139m',
      reset: RESET,
    };
  }
  if (level === 'ansi256') {
    return {
      amber: '\x1b[38;5;214m',
      amberHi: '\x1b[38;5;221m',
      dim: '\x1b[38;5;246m',
      reset: RESET,
    };
  }
  return { amber: '', amberHi: '', dim: '', reset: '' };
}

function center(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

/**
 * Paint the wordmark span (first to last non-space char, interior spaces kept)
 * as one contiguous amber run; leave the outer padding uncolored.
 */
function paintInterior(text: string, pal: Palette): string {
  if (!pal.amberHi) return text;
  return text.replace(/\S(?:.*\S)?/, (run) => pal.amberHi + run + pal.reset);
}

/**
 * Build one interior content row at the given reveal fraction (0 = doors closed,
 * 1 = doors fully open). Doors part from the centre outward.
 */
function buildRow(interior: string, reveal: number, pal: Palette): string {
  const open = Math.round(INNER * reveal);
  const left = Math.floor((INNER - open) / 2);
  const right = INNER - open - left;
  const mid = interior.slice(left, left + open);
  return (
    pal.amber +
    DOOR.repeat(left) +
    pal.reset +
    paintInterior(mid, pal) +
    pal.amber +
    DOOR.repeat(right) +
    pal.reset
  );
}

/** The five banner lines (top, three content rows, bottom) at a reveal fraction. */
function buildFoyerBanner(reveal: number, pal: Palette): string[] {
  const filler = ' '.repeat(INNER);
  const word = center(WORDMARK, INNER);
  const frame = (left: string, right: string) =>
    INDENT + pal.amber + left + '─'.repeat(INNER) + right + pal.reset;
  const content = (interior: string) =>
    INDENT +
    pal.amber +
    '│' +
    pal.reset +
    buildRow(interior, reveal, pal) +
    pal.amber +
    '│' +
    pal.reset;
  return [frame('┌', '┐'), content(filler), content(word), content(filler), frame('└', '┘')];
}

/**
 * The settled banner as a plain string (no cursor control). Always contains the
 * literal text "FOYER" and the uppercased subtitle so it stays meaningful
 * when color is stripped.
 */
export function renderStaticBanner(subtitle: string, level: ColorLevel = colorSupport()): string {
  const pal = palette(level);
  const lines = buildFoyerBanner(1, pal);
  const label = `— ${subtitle.toUpperCase()} —`;
  const subtitleLine = INDENT + pal.dim + center(label, INNER + 2) + pal.reset;
  return [...lines, subtitleLine].join('\n');
}

/**
 * Entry point. Plays the banner animation when the terminal supports it, otherwise
 * prints a static banner (or nothing). The banner is best-effort: every write is
 * guarded so a dead stream (EPIPE, closed FD) can never throw out of here and
 * abort the setup wizard, and the cursor-restore in `finally` always runs.
 */
export async function showFoyerBanner(
  options: { subtitle?: string; env?: NodeJS.ProcessEnv; stream?: NodeJS.WriteStream } = {},
): Promise<void> {
  const { subtitle = 'Setup', env = process.env, stream = process.stdout } = options;
  const mode = bannerMode(env, stream);
  if (mode === 'off') return;

  const level = colorSupport(env, stream);

  // Guarded write — a broken pipe / closed FD returns false instead of throwing.
  const write = (s: string): boolean => {
    try {
      stream.write(s);
      return true;
    } catch {
      return false;
    }
  };

  if (mode === 'static') {
    write('\n' + renderStaticBanner(subtitle, level) + '\n\n');
    return;
  }

  const pal = palette(level);
  const onSigint = () => {
    write(SHOW_CURSOR + RESET + '\n');
    process.exit(130);
  };

  // If we can't even hide the cursor, the stream is unusable — bail before
  // registering the signal handler so there is nothing to clean up.
  if (!write('\n' + HIDE_CURSOR)) return;
  process.once('SIGINT', onSigint);
  try {
    for (let k = 0; k <= STEPS; k++) {
      const lines = buildFoyerBanner(k / STEPS, pal);
      if (k > 0 && !write(`\x1b[${lines.length}A`)) break;
      let drew = true;
      for (const line of lines) {
        if (!write(CLEAR_LINE + line + '\n')) {
          drew = false;
          break;
        }
      }
      if (!drew) break;
      if (k < STEPS) await sleep(FRAME_MS);
    }
    const label = `— ${subtitle.toUpperCase()} —`;
    write(CLEAR_LINE + INDENT + pal.dim + center(label, INNER + 2) + pal.reset + '\n\n');
  } finally {
    process.removeListener('SIGINT', onSigint);
    write(SHOW_CURSOR + pal.reset);
  }
}
