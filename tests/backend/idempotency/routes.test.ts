import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { completionModeOf, IDEMPOTENT_ROUTES } from '../../../apps/api/src/common/idempotency/index.js';

const API_SOURCE = new URL('../../../apps/api/src/', import.meta.url).pathname;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Every `@Idempotent('action', ...)` used by a controller, with the file that declares it. */
function declaredActions(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources(API_SOURCE)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/@Idempotent\(\s*'([^']+)'/g)) found.set(match[1] as string, file.slice(API_SOURCE.length));
  }
  return found;
}

/** BE-005 acceptance: "Every mutating route uses in-transaction completion or is listed with a reason." */
test('every idempotent route has a completion mode; lease routes carry a reason', () => {
  const declared = declaredActions();
  assert.ok(declared.size >= 18, `found ${declared.size} idempotent routes`);
  const unlisted = [...declared.keys()].filter((action) => !Object.hasOwn(IDEMPOTENT_ROUTES, action));
  assert.deepEqual(unlisted, [], 'every @Idempotent action is classified in common/idempotency/routes.ts');
  const stale = Object.keys(IDEMPOTENT_ROUTES).filter((action) => !declared.has(action));
  assert.deepEqual(stale, [], 'the registry lists only actions that exist');
  for (const [action, mode] of Object.entries(IDEMPOTENT_ROUTES)) {
    if (mode.kind === 'lease') assert.ok(mode.reason.length >= 80, `${action} states why it cannot complete in its transaction`);
  }
  const lease = Object.entries(IDEMPOTENT_ROUTES).filter(([, mode]) => mode.kind === 'lease').map(([action]) => action);
  assert.deepEqual(lease, ['membership.invite'], 'only the invitation keeps the lease re-run');
});

test('an unclassified action is refused instead of silently using the lease', () => {
  assert.throws(() => completionModeOf('project.unknown_action'), /no completion mode/);
  assert.throws(() => completionModeOf('constructor'), /no completion mode/);
  assert.equal(completionModeOf('project.create').kind, 'in_transaction');
});
