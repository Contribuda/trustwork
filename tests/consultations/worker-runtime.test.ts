import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('consultation registration loads in the worker runtime without API files', () => {
  // The worker image deliberately excludes apps/api. A fresh process makes an accidental API runtime import fail,
  // even when an integration suite has already loaded those modules into its own module cache.
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const apiRoot = new URL('./apps/api/', pathToFileURL(process.cwd() + '/')).href;
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith(apiRoot)) throw new Error('API files are absent from the worker image: ' + result.url);
      return result;
    } });
    const { buildRegistry } = await import('./apps/worker/src/main.ts');
    if (typeof buildRegistry !== 'function') throw new Error('worker registration is unavailable');
    process.stdout.write('worker module loaded');
  `], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 30_000 });
  assert.equal(output, 'worker module loaded');
});
