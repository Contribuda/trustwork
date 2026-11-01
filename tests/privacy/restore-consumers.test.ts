import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMaintenance } from '@trustwork/data';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';
import { provisionPrivacyDrill, recordPrivacyDrill, verifyPrivacyDrill } from '../../scripts/restore/privacy-drill.js';

test('privacy physical fixture uses actual source projection and reimport consumers', async (t) => {
  const env = await provisionWorkerDatabase('privacy_restore_consumers');
  assert.ok(env);
  const worker = env.workerPool(); const work = await mkdtemp(join(tmpdir(), 'privacy-restore-consumers-'));
  t.after(async () => { await env.close(); await rm(work, { recursive: true, force: true }); });
  const people = await withMaintenance(env.db.admin, async (trx) => {
    const rows = await trx.insertInto('person').values([{ display_name: 'Synthetic erased subject' }, { display_name: 'Synthetic privacy approver' }]).returning('id').execute();
    return rows.map((r) => r.id);
  });
  const fixture = await provisionPrivacyDrill(work, env.db.admin, people);
  const before = await verifyPrivacyDrill(fixture, env.db.admin, worker);
  assert.equal(before.sourceProjectionSuppressed, false);
  assert.equal(before.sourceReimportDenied, false);
  assert.equal(before.deliveryBarrierDenied, false);
  await recordPrivacyDrill(fixture, env.db.admin);
  const after = await verifyPrivacyDrill(fixture, env.db.admin, worker);
  assert.ok(Object.values(after).every(Boolean), JSON.stringify(after));
  assert.deepEqual(await verifyPrivacyDrill(fixture, env.db.admin, worker), after);
});
