import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { hubConfig, hubs } from '../../packages/data/src/repositories/hubs.js';
import { configActivationDigestInput } from '../../packages/contracts/src/hub-core.js';
import { payments } from '../../packages/data/src/repositories/payments.js';
import { receivePaymentWebhook } from '../../apps/worker/src/payments/index.js';
import { screeningListsStaff } from '../../packages/data/src/repositories/screening-lists.js';
import { sourceWorld } from './source-helpers.js';
import { localPaymentLists, stageLocalPaymentList } from './local-list-helpers.js';
import { agreement, ok } from './helpers.js';
import { screenEveryoneClear, screen } from '../screening-gates/helpers.js';
import { installSyntheticListSources } from '../web/admin/screening/list-fixtures.js';
import { waitFor } from '../worker/helpers/worker-db.js';
import type { PaymentAuthorizationView } from '../../packages/contracts/src/payment-sources.js';
import type { PaymentKind, PaymentView } from '../../packages/contracts/src/payments.js';
const h = await startHarness('payment_local_authority');
test('PAY-001 two responsible hubs retain current jurisdiction and list authority at every real API and final worker effect', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const first = await sourceWorld(h, 'synthetic-authority-payer'), w = await sourceWorld(h, 'synthetic-authority-payee');
  t.after(async () => { await w.close(); await first.close(); await h.close(); });
  const lists = await localPaymentLists(h, first, w); await screenEveryoneClear(h.db.admin); await w.registerIssuer('publisher', 2);
  const buyer = h.client(), seller = h.client(); await login(buyer, 'petr'); await login(seller, 'carl');
  for (const world of [first, w]) {
    const [country] = await w.q("SELECT id FROM trustwork.hub_territory WHERE hub_id=$1 AND code='US'", [world.hubId]);
    await world.a.cmd(world.w.people.owner, (trx, ctx) => hubs.removeTerritory(trx, ctx, world.hubId, country!.id as string));
  }
  const payer = await first.bind(buyer), payee = await w.bind(seller, true);
  const fresh = async (deliveryPlace = 'US-CA') => {
    const a = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl, '1250', undefined, deliveryPlace)).agreement;
    const body = { agreementId: a.id, payerBindingId: payer.participant, payeeBindingId: payee.participant, accountBindingId: payee.account!, publisherRegistrationId: w.issuers.publisher.id, rail: 'qr' };
    const authorization = ok<PaymentAuthorizationView>(await buyer.post('/v1/payments/sources/authorizations', body), 201);
    for (const client of [buyer, seller]) ok(await client.post(`/v1/payments/sources/authorizations/${authorization.id}/accept`, { digest: authorization.digest }));
    const [order] = await w.q('SELECT transaction_budget_id FROM trustwork.commercial_order WHERE agreement_id=$1', [a.id]);
    return { payment: { agreementId: a.id, budgetId: order!.transaction_budget_id as string }, authorization };
  };
  type Statement = [string, unknown[]]; type World = typeof w;
  const configuration = async (world: World, place: string): Promise<Statement> => {
    const [prior] = await w.q("SELECT v.payload FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id=c.version_id WHERE c.hub_id=$1 AND c.domain='jurisdiction'", [world.hubId]);
    const old = prior!.payload as { addedRestrictedPlaces: unknown[] };
    // A labelled synthetic fixture, not a claim that this place is legally restricted.
    const payload = { addedRestrictedPlaces: [...old.addedRestrictedPlaces, { code: place, legalBasis: { citation: 'Synthetic test restriction only; no legal determination', url: null } }] };
    const version = await world.a.cmd(world.w.people.owner, (trx, ctx) => hubConfig.draft(trx, ctx, world.hubId, 'jurisdiction', payload));
    const approval = await world.a.approve(world.w.people.officer, world.w.people.owner, 'jurisdiction.activate_settings', world.hubId,
      configActivationDigestInput({ id: version.id, hubId: world.hubId, domain: 'jurisdiction', version: version.version, payloadDigest: version.payload_digest }));
    const ctx = await world.a.elevate(world.w.people.officer);
    return ['SELECT trustwork.hubs_activate_config($1,$2,NULL,$3)', [JSON.stringify(ctx), version.id, approval]];
  };
  const rescreen = async () => { for (const id of [seed.people.petr, seed.people.carl]) await screen(h.db.admin, { kind: 'person', id }, 'scheduled'); };
  let versionMarker = 0;
  const targets: Array<{ name: string; actor?: string; foreignDelivery?: boolean; prepare(place: string): Promise<Statement>; restore(): Promise<unknown> }> = [];
  for (const [world, list, side] of [[first, lists.payer, 'payer'], [w, lists.payee, 'payee']] as const) {
    targets.push({ name: `${side} hub configured list paused`, actor: first.w.people.officer,
      prepare: async () => ['SELECT trustwork.screening_list_set_status($1,$2,\'paused\',\'Synthetic current authority race\')', [JSON.stringify(await first.a.elevate(first.w.people.officer)), list.id]],
      restore: () => first.a.cmd(first.w.people.officer, (trx, ctx) => screeningListsStaff.setStatus(trx, ctx, { listId: list.id, status: 'active', reason: 'Synthetic resume after authority race' })) });
    targets.push({ name: `${side} hub active list version changes before both parties are rescreened`,
      prepare: async () => ['SELECT trustwork.screening_list_activate($1)', [await stageLocalPaymentList(h, list.id, ++versionMarker)]], restore: rescreen });
    targets.push({ name: `${side} hub served territory removed`, actor: world.w.people.owner,
      prepare: async () => { const [territory] = await w.q("SELECT id FROM trustwork.hub_territory WHERE hub_id=$1 AND code='US-CA'", [world.hubId]);
        return ['SELECT trustwork.hubs_remove_territory($1,$2,$3)', [JSON.stringify(await world.a.elevate(world.w.people.owner)), world.hubId, territory!.id]]; },
      restore: () => world.a.cmd(world.w.people.owner, (trx, ctx) => hubs.addTerritory(trx, ctx, world.hubId, { level: 'region', code: 'US-CA' })) });
    targets.push({ name: `${side} hub jurisdiction adds a restriction`, actor: world.w.people.officer,
      foreignDelivery: true, prepare: (place) => configuration(world, place), restore: () => Promise.resolve() });
  }
  targets.push({ name: 'registered local list source withdrawn', prepare: async () => ['UPDATE trustwork.screening_list_source SET current=false WHERE current', []], restore: () => installSyntheticListSources(h.db.admin) });
  await w.q("CREATE FUNCTION trustwork.local_payment_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='payments.requested' THEN PERFORM pg_advisory_xact_lock(827013,1); END IF; RETURN NEW; END $$");
  await w.q('CREATE TRIGGER local_payment_barrier BEFORE INSERT ON trustwork.outbox_event FOR EACH ROW EXECUTE FUNCTION trustwork.local_payment_barrier()');
  const deliveryPlaces = 'AL AK AZ AR CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ').map((s) => `US-${s}`);
  for (const target of targets) for (const surface of ['create', 'confirm', 'refund', 'payout', 'connected_account', 'worker', 'worker_confirm', 'worker_refund', 'worker_payout', 'worker_connected_account'] as const) for (const writerFirst of [true, false]) {
    await t.test(`${target.name}; actual ${surface}; ${writerFirst ? 'revoker' : 'payment'} first`, async () => {
      const place = target.foreignDelivery ? deliveryPlaces.shift()! : 'US-CA';
      const f = await fresh(place), worker = surface.startsWith('worker'), kind = (surface === 'worker' ? 'create' : surface.replace(/^worker_/, '')) as PaymentKind;
      const method = kind === 'connected_account' ? 'connectedAccount' : kind;
      let payment: PaymentView | undefined;
      if (worker || kind !== 'create') payment = ok(await buyer.post('/v1/payments', f.payment), 201);
      if (kind !== 'create') {
        const [original] = await w.q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1', [payment!.id]);
        w.fake.plan(original!.id as string, kind === 'confirm' ? 'requires_confirmation' : 'succeeded'); await w.tick();
        if (worker) ok(await buyer.post(`/v1/payments/${payment!.id}/${kind === 'connected_account' ? 'connected-account' : kind}`, {}));
      }
      if (worker) { const [op] = await w.q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1 AND kind=$2', [payment!.id, kind]); w.fake.plan(op!.id as string, 'outcome_unknown'); }
      const mutation = await target.prepare(place), before = w.fake.calls.length;
      const writer = await h.db.admin.connect(), barrier = await h.db.admin.connect();
      let run: Promise<unknown> | undefined, write: Promise<unknown> | undefined, resume: (() => void) | undefined;
      let response: Awaited<ReturnType<typeof buyer.post>> | undefined;
      const guard = payments.dispatchGuard, invoke = w.fake[method].bind(w.fake);
      const request = () => buyer.post(kind === 'create' ? '/v1/payments' : `/v1/payments/${payment!.id}/${kind === 'connected_account' ? 'connected-account' : kind}`, kind === 'create' ? f.payment : {});
      try {
        await writer.query('BEGIN'); await writer.query("SET LOCAL statement_timeout='5s'");
        if (target.actor) { const p = await w.a.principal(target.actor); await writer.query('SELECT trustwork.set_principal($1,$2)', [p.personId, p.authzEpoch]); }
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;
        let reached!: () => void;
        const ready = new Promise<void>((r) => { reached = r; }), proceed = new Promise<void>((r) => { resume = r; });
        if (worker) {
          if (writerFirst) payments.dispatchGuard = async (...args) => { reached(); await proceed; return guard(...args); };
          else w.fake[method] = async (i, signal) => { reached(); await proceed; return invoke(i, signal); };
          run = w.tick(); await Promise.race([ready, delay(3000).then(() => { throw new Error('actual final worker boundary not reached'); })]);
        }
        if (writerFirst) {
          await writer.query(...mutation);
          if (worker) resume!(); else run = request().then((r) => { response = r; });
          // Catalog-owned mutations wait; NOWAIT jurisdiction readers can refuse immediately.
          await delay(20); await writer.query('COMMIT'); await run;
          assert.equal(w.fake.calls.length, before);
          if (response) assert.equal(response.status, 403, JSON.stringify(response.body));
        } else {
          if (!worker) {
            await barrier.query('SELECT pg_advisory_lock(827013,1)'); run = request().then((r) => { response = r; });
            await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payments_%'")).length > 0, 2000, 'actual payment insert barrier');
          }
          write = writer.query(...mutation);
          await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).length > 0, 2000, 'owning authority writer blocked');
          if (worker) resume!(); else await barrier.query('SELECT pg_advisory_unlock(827013,1)');
          await run; await write; await writer.query('COMMIT');
          if (response) assert.equal(response.status, kind === 'create' ? 201 : 200, JSON.stringify(response.body));
          if (worker) assert.equal(w.fake.calls.length, before + 1);
        }
        if (worker) {
          const [hold] = await w.q('SELECT r.state,r.effect_pending FROM trustwork.reservation r JOIN trustwork.payment_intent p ON p.reservation_id=r.id WHERE p.id=$1', [payment!.id]);
          assert.deepEqual(hold, { state: kind === 'create' || kind === 'confirm' ? 'reserved' : 'settled', effect_pending: true });
          await w.runner.tick(); await w.runner.idle(); assert.equal(w.fake.calls.length, before + (writerFirst ? 0 : 1));
          if (!writerFirst) {
            const [op] = await w.q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1 AND kind=$2', [payment!.id, kind]);
            const signed = w.fake.sign(w.fake.complete(op!.id as string, 'succeeded', `late-local:${op!.id}`));
            assert.equal(await receivePaymentWebhook(w.runtime, w.connectionId, signed.raw, signed.signature), 'applied');
          }
        }
      } finally {
        resume?.(); payments.dispatchGuard = guard; w.fake[method] = invoke;
        await barrier.query('SELECT pg_advisory_unlock_all()'); await writer.query('ROLLBACK'); await Promise.allSettled([run, write]);
        writer.release(); barrier.release(); await target.restore();
        await w.relay.relayOnce(); await w.q("UPDATE trustwork.job SET state='dead' WHERE kind='payments.dispatch' AND state='queued'");
      }
    });
  }
});
