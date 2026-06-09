#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const requiredFiles = [
  'dist/cli.js',
  'dist/server/index.js',
  'dist/scripts/setup.js',
  'dist/scripts/uninstall.js',
  'dist/server/providers/schema/activity.schema.json',
  'dist/public/index.html',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'package.json',
];

for (const file of requiredFiles) {
  if (!existsSync(file)) {
    console.error(`Missing required package file: ${file}`);
    process.exit(1);
  }
}

const help = execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf-8' });
if (!help.includes('foyer setup') || !help.includes('foyer start')) {
  console.error('CLI help output is missing expected commands.');
  process.exit(1);
}

const version = execFileSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf-8' });
if (!/^\d+\.\d+\.\d+/.test(version.trim())) {
  console.error(`CLI version output did not look like a semver version: ${version}`);
  process.exit(1);
}

// Codex runs lifecycle hooks as `node <abs>/dist/cli.js hook codex EVENT`. This
// is the exact invocation that shipped broken (it pointed at a .ts file node
// can't load, crashing exit 1 on every event). Prove the built entrypoint is
// actually node-runnable and honours its "never fail Codex" contract: it must
// exit 0 even with no Foyer server listening. A shape assertion can't catch an
// existing-but-unrunnable .js; executing it can.
for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
  try {
    execFileSync(process.execPath, ['dist/cli.js', 'hook', 'codex', event], {
      input: '{"session_id":"smoke","prompt":"hi"}',
      encoding: 'utf-8',
      timeout: 10_000,
    });
  } catch (err) {
    console.error(`CLI hook command \`hook codex ${event}\` exited non-zero (status ${err.status}):`);
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}
console.log('CLI Codex hook commands exit 0 (node-runnable entrypoint).');

const npmEnv = {
  ...process.env,
  npm_config_cache: mkdtempSync(join(tmpdir(), 'foyer-npm-cache-')),
  npm_config_ignore_scripts: 'true',
};
const packRaw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf-8',
  env: npmEnv,
});
const jsonStart = packRaw.indexOf('[');
if (jsonStart === -1) {
  console.error(`npm pack did not produce JSON output:\n${packRaw}`);
  process.exit(1);
}
const pack = JSON.parse(packRaw.slice(jsonStart))[0];
const packed = new Set(pack.files.map((file) => file.path));

for (const file of requiredFiles) {
  if (!packed.has(file)) {
    console.error(`npm pack would omit required file: ${file}`);
    process.exit(1);
  }
}

console.log(`Package smoke passed: ${pack.name}@${pack.version} (${pack.files.length} files)`);
