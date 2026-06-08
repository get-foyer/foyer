import { describe, it, expect, vi } from 'vitest';
import { bannerMode, colorSupport, renderStaticBanner, showGateBanner } from './banner.js';

/** Build a fake WriteStream with just the fields the banner logic reads. */
const stream = (over: Partial<{ isTTY: boolean; columns: number }> = {}): NodeJS.WriteStream =>
  ({ isTTY: true, columns: 120, ...over }) as unknown as NodeJS.WriteStream;

const tty = stream();
const wide = { isTTY: true, columns: 120 } as const;

// True if the string contains an ANSI escape sequence (CSI introducer).
const hasAnsi = (s: string): boolean => s.includes('\x1b[');

describe('bannerMode', () => {
  it('animates on a wide interactive terminal with no overrides', () => {
    expect(bannerMode({}, stream(wide))).toBe('animate');
  });

  it('is static when stdout is not a TTY (piped / redirected)', () => {
    expect(bannerMode({}, stream({ isTTY: false }))).toBe('static');
  });

  it('is static under CI', () => {
    expect(bannerMode({ CI: 'true' }, tty)).toBe('static');
    expect(bannerMode({ CI: '1' }, tty)).toBe('static');
  });

  it('is static for narrow terminals', () => {
    expect(bannerMode({}, stream({ columns: 30 }))).toBe('static');
  });

  it('is static when NO_COLOR is set', () => {
    expect(bannerMode({ NO_COLOR: '1' }, tty)).toBe('static');
    expect(bannerMode({ NO_COLOR: '' }, tty)).toBe('static');
  });

  it('respects the FOYER_BANNER opt-out', () => {
    expect(bannerMode({ FOYER_BANNER: 'off' }, stream(wide))).toBe('off');
    expect(bannerMode({ FOYER_BANNER: 'static' }, stream(wide))).toBe('static');
  });

  it('treats CI=false as not in CI', () => {
    expect(bannerMode({ CI: 'false' }, stream(wide))).toBe('animate');
  });
});

describe('colorSupport', () => {
  it('returns none when NO_COLOR is set', () => {
    expect(colorSupport({ NO_COLOR: '1' }, tty)).toBe('none');
  });

  it('returns none on a non-TTY stream without overrides', () => {
    expect(colorSupport({}, stream({ isTTY: false }))).toBe('none');
  });

  it('returns truecolor when COLORTERM advertises it', () => {
    expect(colorSupport({ COLORTERM: 'truecolor' }, tty)).toBe('truecolor');
    expect(colorSupport({ COLORTERM: '24bit' }, tty)).toBe('truecolor');
  });

  it('falls back to ansi256 on a TTY without COLORTERM', () => {
    expect(colorSupport({}, tty)).toBe('ansi256');
  });

  it('honors FORCE_COLOR overrides', () => {
    expect(colorSupport({ FORCE_COLOR: '0' }, tty)).toBe('none');
    expect(colorSupport({ FORCE_COLOR: '3' }, stream({ isTTY: false }))).toBe('truecolor');
    expect(colorSupport({ FORCE_COLOR: '1' }, stream({ isTTY: false }))).toBe('ansi256');
  });
});

describe('renderStaticBanner', () => {
  it('contains the literal wordmark and subtitle', () => {
    const out = renderStaticBanner('Setup', 'truecolor');
    expect(out).toContain('FOYER GATE');
    expect(out).toContain('SETUP');
  });

  it('emits no ANSI escapes when color is none', () => {
    const out = renderStaticBanner('Setup', 'none');
    expect(hasAnsi(out)).toBe(false);
    expect(out).toContain('FOYER GATE');
    expect(out).toContain('SETUP');
  });

  it('emits amber escapes when colored', () => {
    expect(hasAnsi(renderStaticBanner('Setup', 'truecolor'))).toBe(true);
  });
});

/** Fake WriteStream that records writes (or throws on every write). */
const recordingStream = (
  over: Partial<{ isTTY: boolean; columns: number; throwOnWrite: boolean }> = {},
): NodeJS.WriteStream & { writes: string[] } => {
  const { isTTY = true, columns = 120, throwOnWrite = false } = over;
  const writes: string[] = [];
  return {
    isTTY,
    columns,
    write(s: string) {
      if (throwOnWrite) throw new Error('EPIPE');
      writes.push(s);
      return true;
    },
    writes,
  } as unknown as NodeJS.WriteStream & { writes: string[] };
};

describe('showGateBanner (stateful path)', () => {
  it('animate path hides then restores the cursor and removes the SIGINT listener', async () => {
    vi.useFakeTimers();
    try {
      const before = process.listenerCount('SIGINT');
      const stream = recordingStream();
      const p = showGateBanner({ subtitle: 'Setup', env: { COLORTERM: 'truecolor' }, stream });
      await vi.runAllTimersAsync();
      await p;
      const out = stream.writes.join('');
      expect(out).toContain('\x1b[?25l'); // cursor hidden
      expect(out).toContain('\x1b[?25h'); // cursor restored
      expect(out).toContain('FOYER GATE');
      expect(process.listenerCount('SIGINT')).toBe(before); // no leaked handler
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws out to the caller when the stream is dead (best-effort)', async () => {
    const before = process.listenerCount('SIGINT');
    const stream = recordingStream({ throwOnWrite: true });
    await expect(
      showGateBanner({ subtitle: 'Setup', env: { COLORTERM: 'truecolor' }, stream }),
    ).resolves.toBeUndefined();
    expect(process.listenerCount('SIGINT')).toBe(before); // no leaked handler
  });

  it('static mode prints the banner without cursor control', async () => {
    const stream = recordingStream({ isTTY: false });
    await showGateBanner({ subtitle: 'Setup', env: {}, stream });
    const out = stream.writes.join('');
    expect(out).toContain('FOYER GATE');
    expect(out).not.toContain('\x1b[?25l'); // no cursor hide in static path
  });

  it('off mode writes nothing', async () => {
    const stream = recordingStream();
    await showGateBanner({ subtitle: 'Setup', env: { FOYER_BANNER: 'off' }, stream });
    expect(stream.writes.length).toBe(0);
  });
});
