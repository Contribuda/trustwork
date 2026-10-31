#!/usr/bin/env node
// Fails when the working tree differs from the commit: a step rewrote a tracked file or left an untracked,
// non-ignored file behind. Usage: node scripts/ci/assert-clean-tree.mjs ["what to do about it"] [-- path ...]
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Porcelain entries ("XY path") of modified, deleted or untracked non-ignored files, optionally limited to paths. */
export function dirtyEntries(cwd = process.cwd(), paths = []) {
  return git(['status', '--porcelain=v1', '--untracked-files=all', ...(paths.length ? ['--', ...paths] : [])], cwd).split('\n').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const separator = process.argv.indexOf('--');
  const args = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
  const paths = separator === -1 ? [] : process.argv.slice(separator + 1);
  const hint = args[0] ?? 'a step changed tracked files or left untracked files; commit generated output or make the step write only ignored paths';
  const dirty = dirtyEntries(process.cwd(), paths);
  if (dirty.length) {
    console.error(`::error::working tree is not clean: ${hint}`);
    for (const entry of dirty) console.error(`  ${entry}`);
    const diff = git(['diff', '--stat', ...(paths.length ? ['--', ...paths] : [])], process.cwd());
    if (diff.trim()) console.error(diff);
    process.exitCode = 1;
  } else {
    console.log(`clean tree${paths.length ? ` (${paths.join(', ')})` : ''}`);
  }
}
