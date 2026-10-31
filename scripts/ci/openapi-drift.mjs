#!/usr/bin/env node
// Regenerates apps/api/openapi/openapi.json from the contracts and fails when the committed file differs.
// Locally the regenerated file is left in place so it can be committed.
import { spawnSync } from 'node:child_process';
import { dirtyEntries } from './assert-clean-tree.mjs';

const TARGET = 'apps/api/openapi';
const generate = spawnSync('npm', ['run', '--silent', 'openapi', '-w', '@trustwork/api'], { stdio: 'inherit' });
if (generate.status !== 0) {
  console.error('::error::OpenAPI generation failed');
  process.exit(generate.status ?? 1);
}
const dirty = dirtyEntries(process.cwd(), [TARGET]);
if (dirty.length) {
  console.error('::error::apps/api/openapi/openapi.json is stale: run `npm run openapi -w @trustwork/api` and commit the result');
  for (const entry of dirty) console.error(`  ${entry}`);
  spawnSync('git', ['--no-pager', 'diff', '--stat', '--', TARGET], { stdio: 'inherit' });
  process.exitCode = 1;
} else {
  console.log('openapi: committed document matches the contracts');
}
