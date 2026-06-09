import { describe, it, expect, vi, afterEach } from 'vitest';
import { builtinModules } from 'module';
import { readFileSync } from 'fs';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { postHookEvent, resolveHookPort } from '../cli.js';

// ---------------------------------------------------------------------------
// postHookEvent — pure Codex hook forwarder
//
// The `runCodexHook` shell guarantees exit 0 (covered end-to-end by
// scripts/package-smoke.mjs, which actually execs the built CLI). Here we pin
// the pure core's contract: it builds the { source:'codex' } envelope, POSTs it
// to the configured port, and THROWS on real failures so they're observable.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('postHookEvent', () => {
  it('wraps the payload in a codex envelope and POSTs to the given port', async () => {
    const fetchMock = stubFetch();
    await postHookEvent('UserPromptSubmit', '{"session_id":"s1","prompt":"hi"}', 4317);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4317/hook');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({
      source: 'codex',
      event: 'UserPromptSubmit',
      payload: { session_id: 's1', prompt: 'hi' },
    });
  });

  it('treats empty / whitespace stdin as an empty payload', async () => {
    const fetchMock = stubFetch();
    await postHookEvent('Stop', '   \n', 4317);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      source: 'codex',
      event: 'Stop',
      payload: {},
    });
  });

  it('passes the port through into the URL (even an odd one)', async () => {
    const fetchMock = stubFetch();
    await postHookEvent('PostToolUse', '{}', 5999);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:5999/hook');
  });

  it('throws on malformed JSON (so the shell can log + swallow it)', async () => {
    stubFetch();
    await expect(postHookEvent('UserPromptSubmit', '{not json', 4317)).rejects.toThrow();
  });

  it('propagates a failed fetch (e.g. server down)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postHookEvent('Stop', '{}', 4317)).rejects.toThrow(/ECONNREFUSED/);
  });
});

// ---------------------------------------------------------------------------
// Hook entrypoint must stay node_modules-free
//
// The Codex hook runs `node dist/cli.js …` directly. If cli.ts ever statically
// imports a node_modules package again (e.g. `dotenv`), the hook crashes with
// ERR_MODULE_NOT_FOUND whenever deps are mid-reinstall (pnpm ci). This guard
// fails the moment a bare specifier creeps back into the top-level import set.
// ---------------------------------------------------------------------------

describe('cli.ts import surface', () => {
  const builtins = new Set(builtinModules);

  function isBuiltin(spec: string): boolean {
    const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
    const root = bare.split('/')[0]; // fs/promises → fs
    return builtins.has(bare) || builtins.has(root);
  }

  it('only statically imports Node builtins or relative paths (no node_modules)', () => {
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    // Match `import ... from '<spec>'` / `export ... from '<spec>'` (static only;
    // dynamic import() inside main() is allowed for the heavier subcommands).
    const specs = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map(
      (m) => m[1],
    );
    expect(specs.length).toBeGreaterThan(0);
    const external = specs.filter((s) => !s.startsWith('.') && !isBuiltin(s));
    expect(external, `unexpected node_modules imports on the hook path: ${external}`).toEqual([]);
  });
});

describe('resolveHookPort', () => {
  const ORIG = process.env.FOYER_PORT;
  const ORIG_CFG = process.env.FOYER_CONFIG_PATH;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.FOYER_PORT;
    else process.env.FOYER_PORT = ORIG;
    if (ORIG_CFG === undefined) delete process.env.FOYER_CONFIG_PATH;
    else process.env.FOYER_CONFIG_PATH = ORIG_CFG;
  });

  it('prefers FOYER_PORT from the environment', () => {
    process.env.FOYER_PORT = '5005';
    expect(resolveHookPort()).toBe(5005);
  });

  it('parses FOYER_PORT out of the config.env file when env is unset', () => {
    delete process.env.FOYER_PORT;
    const dir = mkdtempSync(join(tmpdir(), 'foyer-cfg-'));
    const cfg = join(dir, 'config.env');
    writeFileSync(cfg, '# Foyer\nFOYER_PORT=4999\nFOYER_PROVIDER=codex\n', 'utf-8');
    process.env.FOYER_CONFIG_PATH = cfg;
    expect(resolveHookPort()).toBe(4999);
  });

  it('defaults to 4317 when neither env nor config file is available', () => {
    delete process.env.FOYER_PORT;
    process.env.FOYER_CONFIG_PATH = join(tmpdir(), 'foyer-does-not-exist', 'config.env');
    expect(resolveHookPort()).toBe(4317);
  });
});
