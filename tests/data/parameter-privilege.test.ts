import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureParameterPrivilege } from '../../packages/data/src/migrate/runner.js';

/** Fake migration client: scripted answers for the privilege check and scripted failures for the GRANT. */
function fakeClient(script: { granted: boolean[]; grantErrors: (string | null)[] }) {
  const grants: string[] = [];
  let checks = 0;
  const client = {
    async query(text: string) {
      if (text.startsWith('SELECT has_parameter_privilege')) {
        const ok = script.granted[Math.min(checks, script.granted.length - 1)] ?? false;
        checks += 1;
        return { rows: [{ ok }] };
      }
      grants.push(text);
      const code = script.grantErrors.shift() ?? null;
      if (code) throw Object.assign(new Error(`simulated ${code}`), { code });
      return { rows: [] };
    },
  };
  return { client: client as never, grants, checks: () => checks };
}

test('parameter privilege already present: no GRANT is issued', async () => {
  const f = fakeClient({ granted: [true], grantErrors: [] });
  assert.equal(await ensureParameterPrivilege(f.client), 'present');
  assert.deepEqual(f.grants, []);
});

test('clean GRANT when the privilege is missing', async () => {
  const f = fakeClient({ granted: [false], grantErrors: [null] });
  assert.equal(await ensureParameterPrivilege(f.client), 'granted');
  assert.equal(f.grants.length, 1);
});

test('losing the cluster-wide race (23505 on pg_parameter_acl) is tolerated when the winner granted the privilege', async () => {
  const f = fakeClient({ granted: [false, true], grantErrors: ['23505'] });
  assert.equal(await ensureParameterPrivilege(f.client), 'present');
  assert.equal(f.grants.length, 1, 'one attempt, then the re-check sees the winner');
});

test('"tuple concurrently updated" (XX000) retries the GRANT once the re-check still says missing', async () => {
  const f = fakeClient({ granted: [false, false], grantErrors: ['XX000', null] });
  assert.equal(await ensureParameterPrivilege(f.client), 'granted');
  assert.equal(f.grants.length, 2);
});

test('other errors propagate unchanged', async () => {
  const f = fakeClient({ granted: [false], grantErrors: ['42501'] });
  await assert.rejects(ensureParameterPrivilege(f.client), (e: unknown) => (e as { code?: string }).code === '42501');
  assert.equal(f.grants.length, 1);
});

test('a persistent race gives up after three attempts', async () => {
  const f = fakeClient({ granted: [false, false, false, false], grantErrors: ['23505', '23505', '23505'] });
  await assert.rejects(ensureParameterPrivilege(f.client), (e: unknown) => (e as { code?: string }).code === '23505');
  assert.equal(f.grants.length, 3);
});

test('duplicate_object (42710) from a concurrent grant is tolerated like the other catalogue races', async () => {
  const f = fakeClient({ granted: [false, true], grantErrors: ['42710'] });
  assert.equal(await ensureParameterPrivilege(f.client), 'present');
  assert.equal(f.grants.length, 1);
});
