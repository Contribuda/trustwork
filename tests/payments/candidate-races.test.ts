import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { hubConfig } from '../../packages/data/src/repositories/hubs.js';
import { configActivationDigestInput } from '../../packages/contracts/src/hub-core.js';
import { killSwitches, approvals, adminDigests } from '../../packages/data/src/repositories/admin.js';
import { sourceWorld } from './source-helpers.js';
import { localPaymentLists } from './local-list-helpers.js';
import { agreement, ok } from './helpers.js';
import { screenEveryoneClear } from '../screening-gates/helpers.js';
import { waitFor } from '../worker/helpers/worker-db.js';
import type { PaymentOutsideView } from '../../packages/contracts/src/payment-sources.js';
const h = await startHarness('payment_candidate_races');
test('PAY-001 verified candidate absence serializes actual second consent with owning insert/config/rail/kill writes', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const first = await sourceWorld(h, 'synthetic-race-payer'), w = await sourceWorld(h, 'synthetic-race-payee');
  t.after(async () => { await w.close(); await first.close(); await h.close(); });
  await localPaymentLists(h, first, w); await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client(); await login(buyer, 'petr'); await login(seller, 'carl');
  const payer = await first.bind(buyer), payee = await w.bind(seller), publisher = await w.registerDecisionPublisher();
  const [configured] = await w.q("SELECT v.payload FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id=c.version_id WHERE c.hub_id=$1 AND c.domain='payments'", [w.hubId]);
  const configPayload = configured!.payload as Record<string, unknown>;
  type Statement = [string, unknown[]];
  const configuration = async (enabled: boolean): Promise<Statement> => {
    const v = await w.a.cmd(w.w.people.owner, (trx, ctx) => hubConfig.draft(trx, ctx, w.hubId, 'payments', { ...configPayload, providers: enabled ? configPayload.providers : [] }));
    const approval = await w.a.approve(w.w.people.officer, w.w.people.owner, 'payments.change_settings', w.hubId, configActivationDigestInput({ id: v.id, hubId: w.hubId, domain: 'payments', version: v.version, payloadDigest: v.payload_digest }));
    const ctx = await w.a.elevate(w.w.people.officer);
    return ['SELECT trustwork.hubs_activate_config($1,$2,NULL,$3)', [JSON.stringify(ctx), v.id, approval]];
  };
  const execute = async (statement: Statement, person?: string) => {
    const c = await h.db.admin.connect();
    try {
      await c.query('BEGIN');
      if (person) { const p = await w.a.principal(person); await c.query('SELECT trustwork.set_principal($1,$2)', [p.personId, p.authzEpoch]); }
      await c.query(statement[0], statement[1]); await c.query('COMMIT');
    } finally { await c.query('ROLLBACK'); c.release(); }
  };
  const railInsert: Statement = ["INSERT INTO trustwork.payment_rail(connection_id,currencies,countries,rails,capabilities,custody,evidence_mode,approval_ref) VALUES($1,ARRAY['USD'],ARRAY['US'],ARRAY['qr'],ARRAY['create','confirm','refund','payout','connected_account'],'provider_connected_accounts','synthetic','synthetic-insert-race')", [w.connectionId]];
  const restoreRail = async () => {
    if (!(await w.q('SELECT 1 FROM trustwork.payment_rail WHERE connection_id=$1', [w.connectionId])).length) await execute(railInsert);
    await w.q("UPDATE trustwork.payment_rail SET currencies=ARRAY['USD'] WHERE connection_id=$1", [w.connectionId]);
  };
  const releaseKill = async () => {
    const [k] = await w.q("SELECT id,scope_kind FROM trustwork.kill_switch WHERE state='engaged' AND (connection_id=$1 OR scope_kind='node')", [w.connectionId]);
    if (!k) return;
    const note = 'Synthetic independent candidate race release', digest = adminDigests.killSwitchRelease(k.id as string, note);
    const approval = await w.a.cmd(w.w.people.owner, (trx, ctx) => approvals.request(trx, ctx, { action: 'kill_switch.release', scope: k.scope_kind === 'node' ? { kind: 'node', nodeId: w.w.nodeId } : { kind: 'hub', hubId: w.hubId }, actionDigest: digest }));
    await w.a.cmd(w.w.people.officer, (trx, ctx) => approvals.decide(trx, ctx, approval.id, 'approve', digest));
    await w.a.cmd(w.w.people.owner, (trx, ctx) => killSwitches.release(trx, ctx, k.id as string, approval.id, note));
  };
  await w.a.assignSensitive({ personId: w.w.people.owner, role: 'compliance-officer', scope: { kind: 'node', nodeId: w.w.nodeId } });
  const targets: Array<{ name: string; actor?: string; unchanged?: boolean; prepare(): Promise<Statement> }> = [
    { name: 'configured provider enabled', prepare: async () => { await w.providerEnabled(false); return ["UPDATE trustwork.provider_connection SET status='enabled',enabled_by=$2,enabled_at=clock_timestamp() WHERE id=$1", [w.connectionId, w.w.people.owner]]; } },
    { name: 'rail currency enabled', prepare: async () => { await w.q("UPDATE trustwork.payment_rail SET currencies=ARRAY['EUR'] WHERE connection_id=$1", [w.connectionId]); return ["UPDATE trustwork.payment_rail SET currencies=ARRAY['USD'] WHERE connection_id=$1", [w.connectionId]]; } },
    { name: 'new rail inserted', prepare: async () => { await w.q('DELETE FROM trustwork.payment_rail WHERE connection_id=$1', [w.connectionId]); return railInsert; } },
    { name: 'current collecting config activated', actor: w.w.people.officer, prepare: async () => { await execute(await configuration(false), w.w.people.officer); return configuration(true); } },
    { name: 'connection kill inserted', actor: w.w.people.owner, prepare: async () => { await w.providerEnabled(false); const ctx = await w.a.elevate(w.w.people.owner); return ['SELECT trustwork.admin_engage_kill_switch($1,\'provider_connection\',NULL,$2,$3,NULL)', [JSON.stringify(ctx), w.hubId, JSON.stringify({ connectionId: w.connectionId })]]; } },
    { name: 'node kill inserted', actor: w.w.people.owner, prepare: async () => { await w.providerEnabled(false); const ctx = await w.a.elevate(w.w.people.owner); return ['SELECT trustwork.admin_engage_kill_switch($1,\'node\',$2,NULL,\'{}\',NULL)', [JSON.stringify(ctx), w.w.nodeId]]; } },
    { name: 'unconfigured provider inserted cannot become a candidate', actor: w.w.people.owner, unchanged: true, prepare: async () => {
      await w.providerEnabled(false); const ctx = await w.a.elevate(w.w.people.owner);
      return ["SELECT trustwork.providers_create_connection($1,$2,'fake','fake','Synthetic unconfigured race provider',ARRAY['payments'],NULL,'self_hosted','US',false,false,false,NULL,NULL,NULL)", [JSON.stringify(ctx), w.hubId]];
    } },
  ];
  await w.q("CREATE FUNCTION trustwork.outside_consent_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(827014,1); RETURN NEW; END $$");
  await w.q('CREATE TRIGGER outside_consent_barrier BEFORE INSERT ON trustwork.payment_outside_platform_acceptance FOR EACH ROW EXECUTE FUNCTION trustwork.outside_consent_barrier()');
  for (const target of targets) for (const writerFirst of [true, false]) await t.test(`${target.name}; ${writerFirst ? 'writer' : 'consent'} first`, async () => {
    await releaseKill(); await restoreRail(); await w.providerEnabled(true); await execute(await configuration(true), w.w.people.officer);
    const accepted = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl)).agreement;
    const mutation = await target.prepare();
    const decision = ok<PaymentOutsideView>(await buyer.post('/v1/payments/sources/outside-platform', { agreementId: accepted.id, payerBindingId: payer.participant, payeeBindingId: payee.participant, publisherRegistrationId: publisher.id }), 201);
    ok(await buyer.post(`/v1/payments/sources/outside-platform/${decision.id}/accept`, { digest: decision.digest }));
    const before = await w.q('SELECT * FROM trustwork.ledger_entry ORDER BY id');
    const writer = await h.db.admin.connect(), barrier = await h.db.admin.connect();
    let run: ReturnType<typeof seller.post> | undefined, write: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query("SET LOCAL statement_timeout='5s'");
      if (target.actor) { const p = await w.a.principal(target.actor); await writer.query('SELECT trustwork.set_principal($1,$2)', [p.personId, p.authzEpoch]); }
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;
      const request = () => seller.post(`/v1/payments/sources/outside-platform/${decision.id}/accept`, { digest: decision.digest });
      if (writerFirst) {
        await writer.query(mutation[0], mutation[1]); run = request();
        await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payments_accept_outside%'")).length > 0, 2000, 'outside consent waits for actual owning writer');
        await writer.query('COMMIT');
      } else {
        await barrier.query('SELECT pg_advisory_lock(827014,1)'); run = request();
        await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payments_accept_outside%'")).length > 0, 2000, 'consent holds candidate absence at its actual insert');
        write = writer.query(mutation[0], mutation[1]);
        await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).length > 0, 2000, 'owning write waits for consent');
        await barrier.query('SELECT pg_advisory_unlock(827014,1)');
        await run; await write; await writer.query('COMMIT');
      }
      const response = await run;
      assert.equal(response.status, writerFirst && !target.unchanged ? 403 : 200, JSON.stringify(response.body));
      assert.equal((await w.q('SELECT * FROM trustwork.payment_outside_platform_acceptance WHERE decision_id=$1', [decision.id])).length, writerFirst && !target.unchanged ? 1 : 2);
      assert.equal((await w.q('SELECT * FROM trustwork.payment_intent')).length, 0);
      assert.equal((await w.q('SELECT * FROM trustwork.payment_operation')).length, 0);
      assert.deepEqual(await w.q('SELECT * FROM trustwork.ledger_entry ORDER BY id'), before);
      assert.equal(first.fake.calls.length + w.fake.calls.length, 0);
    } finally {
      await barrier.query('SELECT pg_advisory_unlock_all()'); await writer.query('ROLLBACK');
      await Promise.allSettled([run, write]); writer.release(); barrier.release();
    }
  });
});
