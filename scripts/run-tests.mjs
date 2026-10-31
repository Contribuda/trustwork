import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function discoverTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discoverTests(path);
    return entry.isFile() && /\.test\.(?:ts|mjs|js)$/.test(entry.name) ? [path] : [];
  }).sort();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = discoverTests(resolve(process.argv[2] ?? 'tests'));
  if (!files.length) throw new Error('No supported tests discovered');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
