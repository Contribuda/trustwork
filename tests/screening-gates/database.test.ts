import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { bindTransaction, withMaintenance, withPrincipal, type DataPool } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { screeningGates } from '../../packages/data/src/repositories/screening-gates.js';
import { gateVerdict, type GateState, type GateSubject } from '../../packages/contracts/src/screening-gates.js';
import type { ScreeningSubjectRef } from '../../packages/contracts/src/sanctions.js';
import { screenSubject } from '../../apps/worker/src/screening/index.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { principalFor } from '../data/helpers/seed.js';
import { rejects } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { activateBaseline, clearHold, decideMatches, holdPerson, LISTED_COMPANY_NAME, LISTED_PERSON_NAME, newBaselineVersion, nextConsEntries, screen, setBaselineStale, stageAndActivate } from './helpers.js';

const env = await provisionWorkerDatabase('screening_gates_db');

const P = (id: string): ScreeningSubjectRef => ({ kind: 'person', id });
const C = (id: string): ScreeningSubjectRef => ({ kind: 'company', id });

async function person(admin: DataPool, name: string): Promise<string> {
  return withMaintenance(admin, async (trx) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id);
}
async function company(admin: DataPool, name: string): Promise<string> {
  return withMaintenance(admin, async (trx) => (await trx.insertInto('company').values({ display_name: name, claim_status: 'claimed' }).returning('id').executeTakeFirstOrThrow()).id);
}

/** A transaction held open on its own connection (to race another one). */
async function openTx(pool: DataPool, setup: (client: pg.PoolClient) => Promise<void> = async () => undefined) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await setup(client);
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return {
    client, pid: rows[0]!.pid, trx: bindTransaction(client),
    async end(commit: boolean) {
      try { await client.query(commit ? 'COMMIT' : 'ROLLBACK'); } finally { client.release(); }
    },
  };
}
const ownerTx = (admin: DataPool) => openTx(admin, async (client) => {
  await client.query('SET LOCAL ROLE trustwork_owner');
  await client.query('SET LOCAL search_path = trustwork, pg_temp');
  await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
});
/** Waits until the backend `pid` waits on a lock (row lock, transaction id or advisory lock). */
async function blocked(admin: DataPool, pid: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await admin.query<{ w: string | null }>('SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (rows[0]?.w === 'Lock') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}
/** Resolves to 'pending' while the promise has not settled within a short window. */
const pendingAfter = async (p: Promise<unknown>, ms = 150): Promise<'pending' | 'settled'> => Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);

const CONFIG = { fuzzyThreshold: null, vesselsAndAircraft: false, sweepBatch: 500 };

/**
 * SANC-004 on real PostgreSQL under the runtime role: the gate's read reports every reason that keeps a subject from
 * transacting (unscreened, insufficient name, open or confirmed match, a result older than the active baseline,
 * missing or stale baseline, an open jurisdiction hold) and refuses unknown or malformed subjects; only the runtime role
 * may call it; a declared own place in a restricted place holds the caller and nobody else; and a decision, a result,
 * a list activation or a hold racing a commitment either is seen by the gate or waits until the commitment ends, so
 * no commitment binds on a stale answer. Every name is synthetic.
 */
test('SANC-004 screening gates on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const runtime = env.apiPool;
  const worker = env.workerPool(2);
  const check = (subjects: ScreeningSubjectRef[]) => tx(runtime, (trx) => screeningGates.check(trx, subjects));
  const one = async (subject: ScreeningSubjectRef): Promise<GateState> => (await check([subject]))[0]!;

  await t.test('without an active baseline every subject is unscreened and screening is unavailable', async () => {
    const id = await person(admin, 'Quillon Brightmere');
    const s = await one(P(id));
    assert.equal(s.moneyHeld, true);
    assert.deepEqual([...s.reasons].sort(), ['lists_unavailable', 'not_screened']);
    assert.equal(gateVerdict([{ subject: P(id), side: 'counterparty' }], [s]).ok, false);
    assert.equal((gateVerdict([{ subject: P(id), side: 'counterparty' }], [s]) as { code: string }).code, 'screening.unavailable');
  });

  await activateBaseline(admin);
  const clear = { buyer: await person(admin, 'Harriet Lindqvist Oakes'), seller: await person(admin, 'Ignatius Ferrow Pell'), firm: await company(admin, 'Ferrow Pell Masonry Works') };
  for (const subject of [P(clear.buyer), P(clear.seller), C(clear.firm)]) assert.equal((await screen(admin, subject)).outcome, 'clear');

  await t.test('clear subjects pass; the read keeps the order given and answers each subject once', async () => {
    const rows = await check([P(clear.seller), C(clear.firm), P(clear.buyer), P(clear.seller)]);
    assert.deepEqual(rows.map((r) => r.subject.id), [clear.seller, clear.firm, clear.buyer]);
    for (const r of rows) assert.deepEqual([r.moneyHeld, r.reasons, r.placeHold], [false, [], false]);
    const subjects: GateSubject[] = [{ subject: P(clear.seller), side: 'own' }, { subject: C(clear.firm), side: 'own' }, { subject: P(clear.buyer), side: 'counterparty' }];
    assert.deepEqual(gateVerdict(subjects, rows), { ok: true });
  });

  await t.test('every reason that keeps money held is reported', async () => {
    const never = await person(admin, 'Ottoline Varga Strand');
    assert.deepEqual((await one(P(never))).reasons, ['not_screened']);

    const mono = await person(admin, 'Exampleworth');
    assert.equal((await screen(admin, P(mono))).outcome, 'insufficient_name');
    assert.deepEqual((await one(P(mono))).reasons, ['insufficient_name']);

    const listed = await person(admin, LISTED_PERSON_NAME);
    assert.equal((await screen(admin, P(listed))).outcome, 'possible_match');
    assert.deepEqual((await one(P(listed))).reasons, ['review_pending']);
    await decideMatches(admin, P(listed), 'confirmed');
    const confirmed = await one(P(listed));
    assert.deepEqual([confirmed.reasons, confirmed.suspended, confirmed.appealable], [['confirmed'], true, true]);

    const listedFirm = await company(admin, LISTED_COMPANY_NAME);
    assert.equal((await screen(admin, C(listedFirm))).outcome, 'possible_match');
    assert.deepEqual((await one(C(listedFirm))).reasons, ['review_pending']);

    const held = await person(admin, 'Rosalind Achterberg Vale');
    assert.equal((await screen(admin, P(held))).outcome, 'clear');
    await holdPerson(admin, held);
    const h = await one(P(held));
    assert.deepEqual([h.moneyHeld, h.placeHold], [false, true], 'a hold is reported separately from the screening state');
    assert.equal(gateVerdict([{ subject: P(held), side: 'counterparty' }], [h]).ok, false);
    await clearHold(admin, held, clear.buyer);
    assert.equal((await one(P(held))).placeHold, false);
  });

  await t.test('a new baseline version makes earlier results stale; a stale baseline makes screening unavailable for everyone', async () => {
    await newBaselineVersion(admin, '950101');
    assert.deepEqual((await one(P(clear.buyer))).reasons, ['rescreen_due']);
    for (const subject of [P(clear.buyer), P(clear.seller), C(clear.firm)]) assert.equal((await screen(admin, subject)).outcome, 'clear');
    assert.deepEqual((await one(P(clear.buyer))).reasons, []);
    await setBaselineStale(admin, true);
    const rows = await check([P(clear.buyer), C(clear.firm)]);
    for (const r of rows) assert.deepEqual(r.reasons, ['lists_unavailable']);
    assert.equal((gateVerdict([{ subject: P(clear.buyer), side: 'own' }, { subject: C(clear.firm), side: 'counterparty' }], rows) as { code: string }).code, 'screening.unavailable');
    await setBaselineStale(admin, false);
  });

  await t.test('unknown and malformed subjects are refused; only the runtime role calls the gate', async () => {
    await rejects(check([P('00000000-0000-4000-8000-000000000000')]), 'P0002', 'screening.subject_not_found');
    await rejects(check([]), '22023', 'screening.gate_subjects');
    await rejects(tx(runtime, (trx) => screeningGates.check(trx, Array.from({ length: 17 }, () => P(clear.buyer)))), '22023', 'screening.gate_subjects');
    await rejects(tx(worker, (trx) => screeningGates.check(trx, [P(clear.buyer)])), '42501');
    await rejects(runtime.query('SELECT trustwork.screening_gate_hold_lock()'), '42501');
  });

  await t.test('a declared own place in a restricted place holds the caller only; an unsynced place list counts every place as restricted', async () => {
    const early = await person(admin, 'Benedikt Sørlie Amaro');
    // Before the kernel list is synced every place is restricted (fail closed, as SANC-001).
    assert.equal(await withPrincipal(runtime, await principalFor(admin, early), (trx) => screeningGates.declarePlace(trx, 'US', 'payout_country')), true);
    await withMaintenance(admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
    const payee = await person(admin, 'Clementine Okafor Rhee');
    const asPayee = async <T>(fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(runtime, await principalFor(admin, payee), fn);
    assert.equal(await asPayee((trx) => screeningGates.declarePlace(trx, 'US', 'payout_country')), false);
    assert.equal(await asPayee((trx) => screeningGates.declarePlace(trx, 'UA', 'self_declared')), false, 'a country with only restricted regions is not restricted as a whole');
    const before = await admin.query('SELECT 1 FROM trustwork.jurisdiction_hold WHERE person_id = $1', [payee]);
    assert.equal(before.rowCount, 0);
    assert.equal(await asPayee((trx) => screeningGates.declarePlace(trx, 'CU', 'payout_country')), true);
    assert.equal(await asPayee((trx) => screeningGates.declarePlace(trx, 'UA-43', 'self_declared')), true, 'the first hold stands');
    const holds = await admin.query<{ place: string; source: string; dataset: string }>('SELECT place, source, dataset FROM trustwork.jurisdiction_hold WHERE person_id = $1', [payee]);
    assert.deepEqual(holds.rows, [{ place: 'CU', source: 'payout_country', dataset: 'declaration' }]);
    assert.equal((await one(P(payee))).placeHold, true);
    await rejects(asPayee((trx) => screeningGates.declarePlace(trx, 'CU', 'geolocation' as 'self_declared')), '22023', 'jurisdiction.invalid_source');
    await rejects(asPayee((trx) => screeningGates.declarePlace(trx, 'cuba', 'payout_country')), '22023', 'jurisdiction.invalid_place');
    await rejects(tx(runtime, (trx) => screeningGates.declarePlace(trx, 'CU', 'payout_country')), '28000', 'access.no_principal');
    // Nobody else was held by these declarations.
    const others = await admin.query("SELECT 1 FROM trustwork.jurisdiction_hold WHERE source IN ('payout_country', 'self_declared') AND person_id NOT IN ($1, $2)", [payee, early]);
    assert.equal(others.rowCount, 0);
  });

  await t.test('concurrency: a result racing a commitment waits for it, or is seen by it', async () => {
    const racer = await person(admin, 'Leopold Haverkamp Quist');
    assert.equal((await screen(admin, P(racer))).outcome, 'clear');
    // 1. The commitment reads first (clear) and still holds its transaction: the new possible match waits for it.
    const commitment = await openTx(runtime);
    assert.equal((await screeningGates.check(commitment.trx, [P(racer)]))[0]!.moneyHeld, false);
    const decision = await ownerTx(admin);
    await decision.client.query('UPDATE trustwork.person SET display_name = $1 WHERE id = $2', [LISTED_PERSON_NAME, racer]);
    const recording = screenSubject(decision.trx, P(racer), 'name_change', CONFIG);
    await blocked(admin, decision.pid);
    assert.equal(await pendingAfter(recording), 'pending', 'the result waits while the commitment is open');
    await commitment.end(true);
    assert.equal((await recording).outcome, 'possible_match');
    await decision.end(true);
    assert.deepEqual((await one(P(racer))).reasons, ['review_pending']);

    // 2. The decision writes first and is not committed: the gate waits, then sees it (never the stale clear).
    const other = await person(admin, 'Mirabel Ostrowski Tane');
    assert.equal((await screen(admin, P(other))).outcome, 'clear');
    const late = await ownerTx(admin);
    await late.client.query('UPDATE trustwork.person SET display_name = $1 WHERE id = $2', [LISTED_PERSON_NAME, other]);
    assert.equal((await screenSubject(late.trx, P(other), 'name_change', CONFIG)).outcome, 'possible_match');
    const gate = await openTx(runtime);
    const reading = screeningGates.check(gate.trx, [P(clear.buyer), P(other)]);
    await blocked(admin, gate.pid);
    assert.equal(await pendingAfter(reading), 'pending');
    await late.end(true);
    const seen = await reading;
    await gate.end(true);
    assert.deepEqual(seen.map((s) => s.reasons), [[], ['review_pending']]);
    assert.equal((gateVerdict([{ subject: P(clear.buyer), side: 'own' }, { subject: P(other), side: 'counterparty' }], seen) as { code: string }).code, 'commercial.counterparty_unavailable');

    // 3. A rolled-back decision leaves the commitment's answer as it was.
    const third = await person(admin, 'Severin Achebe Lund');
    assert.equal((await screen(admin, P(third))).outcome, 'clear');
    const aborted = await ownerTx(admin);
    await aborted.client.query('UPDATE trustwork.person SET display_name = $1 WHERE id = $2', [LISTED_PERSON_NAME, third]);
    await screenSubject(aborted.trx, P(third), 'name_change', CONFIG);
    const g3 = await openTx(runtime);
    const r3 = screeningGates.check(g3.trx, [P(third)]);
    await blocked(admin, g3.pid);
    await aborted.end(false);
    assert.deepEqual((await r3)[0]!.reasons, []);
    await g3.end(true);
  });

  await t.test('concurrency: a decision on a match, a hold and a list activation each serialize with the gate', async () => {
    // A confirmation of an open match (the state row lock) while the gate reads.
    const subject = await person(admin, LISTED_PERSON_NAME);
    assert.equal((await screen(admin, P(subject))).outcome, 'possible_match');
    const confirm = await ownerTx(admin);
    await confirm.client.query("UPDATE trustwork.screening_match SET state = 'confirmed', decided_at = now() WHERE subject_person_id = $1", [subject]);
    await confirm.client.query('SELECT trustwork.screening_recompute(id) FROM trustwork.screening_subject_state WHERE subject_person_id = $1', [subject]);
    const g1 = await openTx(runtime);
    const r1 = screeningGates.check(g1.trx, [P(subject)]);
    await blocked(admin, g1.pid);
    await confirm.end(true);
    const s1 = (await r1)[0]!;
    await g1.end(true);
    assert.deepEqual([s1.reasons, s1.suspended], [['confirmed'], true]);

    // A hold racing the gate, both orders.
    const traveller = await person(admin, 'Annika Bergström Dahl');
    assert.equal((await screen(admin, P(traveller))).outcome, 'clear');
    const sighting = await ownerTx(admin);
    await sighting.client.query("INSERT INTO trustwork.jurisdiction_hold (person_id, place, source, dataset) VALUES ($1, 'IR', 'staff_report', 'fixture')", [traveller]);
    const g2 = await openTx(runtime);
    const r2 = screeningGates.check(g2.trx, [P(traveller)]);
    await blocked(admin, g2.pid);
    await sighting.end(true);
    assert.equal((await r2)[0]!.placeHold, true, 'the gate waited for the hold and saw it');
    await g2.end(true);
    await clearHold(admin, traveller, clear.buyer);
    const g3 = await openTx(runtime);
    assert.equal((await screeningGates.check(g3.trx, [P(traveller)]))[0]!.placeHold, false);
    const sighting2 = await ownerTx(admin);
    const inserting = sighting2.client.query("INSERT INTO trustwork.jurisdiction_hold (person_id, place, source, dataset) VALUES ($1, 'KP', 'staff_report', 'fixture')", [traveller]);
    await blocked(admin, sighting2.pid);
    assert.equal(await pendingAfter(inserting), 'pending', 'the hold waits for the open commitment');
    await g3.end(true);
    await inserting;
    await sighting2.end(true);
    assert.equal((await one(P(traveller))).placeHold, true);

    // A baseline activation racing the gate: the gate waits and sees the subject due for re-screening.
    const fresh = await person(admin, 'Tobias Engstrand Mwangi');
    assert.equal((await screen(admin, P(fresh))).outcome, 'clear');
    const activation = await ownerTx(admin);
    await stageAndActivate(activation.trx, 'ofac-cons', nextConsEntries('950202'), '2026-10-28');
    const g4 = await openTx(runtime);
    const r4 = screeningGates.check(g4.trx, [P(fresh)]);
    await blocked(admin, g4.pid);
    await activation.end(true);
    assert.deepEqual((await r4)[0]!.reasons, ['rescreen_due'], 'the gate waited for the activation and saw the result stale');
    await g4.end(true);
  });
});
