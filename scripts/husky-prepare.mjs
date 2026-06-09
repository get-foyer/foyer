#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

const npmCommand = process.env.npm_command ?? '';

if (process.env.CI || npmCommand === 'pack' || npmCommand === 'publish' || !existsSync('.git')) {
  process.exit(0);
}

try {
  execFileSync('husky', { stdio: 'inherit' });
} catch (err) {
  console.warn(`husky prepare skipped: ${err instanceof Error ? err.message : err}`);
}
