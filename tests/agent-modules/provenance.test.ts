import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { inTransaction } from '@trustwork/worker';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { as, fails, workerLogin } from '../assistant/helpers.js';
import { activatePolicy, buildAgentWorld, ok } from './helpers.js';
import { usHubPolicy } from './fixtures.js';

const h = await startHarness('agent_modules_provenance');
test('first-party serving provenance is explicit, immutable and independent of process defaults', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const worker = await workerLogin(h);
  t.after(async () => { await worker.close(); await h.close(); });
  const world = await buildAgentWorld(h);
  const seed = await seedPersonas(h);
  await activatePolicy(h, world, usHubPolicy(world.hubId));
  const client = h.client();
  await login(client, 'petr');
  const body = { actingFor: 'self', moduleKey: 'project_planner', templateKey: 'weekly_plan_review', trigger: null, validUntil: new Date(Date.now() + 86_400_000 * 30).toISOString() };
  const key = randomUUID();

  await t.test('forged headers and a conflicting process hub cannot redirect a committed job request', async () => {
    const previous = process.env.TRUSTWORK_HUB_ID;
    process.env.TRUSTWORK_HUB_ID = randomUUID();
    try {
      const first = ok<{ request: { id: string }; confirmation: { proposalId: string; digest: unknown } }>(await client.post('/v1/assistant/jobs', body,
        { idempotencyKey: key, headers: { host: 'forged.example.invalid', 'x-hub-id': randomUUID(), 'accept-language': 'es' } }), 201);
      const replay = ok(await client.post('/v1/assistant/jobs', body, { idempotencyKey: key }), 201);
      assert.deepEqual(replay, first);
      const p = (await h.db.admin.query<{ hub_id: string; operation_id: string; state: string }>(
        'SELECT p.hub_id, p.operation_id, i.state FROM trustwork.agent_job_provenance p JOIN trustwork.idempotency_record i ON i.id = p.operation_id WHERE p.job_request_id = $1', [first.request.id])).rows;
      assert.equal(p.length, 1);
      assert.equal(p[0]!.hub_id, world.hubId);
      assert.equal(p[0]!.state, 'completed');
      ok(await client.post(`/v1/assistant/mandate-proposals/${first.confirmation.proposalId}/confirm`, { digest: first.confirmation.digest }));
      const usage = (await h.db.admin.query<{ same_digest: boolean; same_snapshot: boolean; hub_id: string }>(
        `SELECT u.hub_id, u.mandate_digest = m.digest AS same_digest, m.snapshot = v.snapshot AS same_snapshot
         FROM trustwork.agent_mandate_usage u JOIN trustwork.mandate m ON m.id = u.mandate_id
         JOIN trustwork.mandate_revision v ON v.mandate_id = m.id AND v.revision = u.mandate_revision WHERE u.job_request_id = $1`, [first.request.id])).rows;
      assert.deepEqual(usage, [{ hub_id: world.hubId, same_digest: true, same_snapshot: true }]);
    } finally { process.env.TRUSTWORK_HUB_ID = previous; }
  });

  await t.test('staff, other participants and workers cannot read private provenance or rewrite routing', async () => {
    for (const personId of [seed.people.carl, world.w.people.owner]) await as(h, personId, async (trx) => {
      assert.equal((await trx.selectFrom('agent_job_provenance').selectAll().execute()).length, 0);
      assert.equal((await trx.selectFrom('agent_mandate_usage').selectAll().execute()).length, 0);
      await fails(sql`UPDATE trustwork.agent_serving_hub SET active = false`.execute(trx), '42501');
    });
    await inTransaction(worker.pool(1), (trx) => fails(sql`SELECT * FROM trustwork.agent_job_provenance`.execute(trx), '42501'));
    await assert.rejects(withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.agent_job_provenance SET hub_id = ${randomUUID()}::uuid`.execute(trx)));
    await assert.rejects(withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.agent_serving_hub SET origin = 'https://forged.example.invalid'`.execute(trx)));
  });

  await t.test('an absent routing registration is denied even when the process default names a real hub', async () => {
    await withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.agent_serving_hub SET active = false`.execute(trx));
    const r = await client.post('/v1/assistant/jobs', body);
    assert.equal(r.status, 403);
    assert.match(JSON.stringify(r.body), /hub_provenance_unavailable/);
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agent_job_request')).rowCount, 1);
  });
});
