#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const assets = [
  [
    'server/providers/schema/activity.schema.json',
    'dist/server/providers/schema/activity.schema.json',
  ],
];

for (const [source, target] of assets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
