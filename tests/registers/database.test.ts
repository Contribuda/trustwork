import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { bindTransaction, type Transaction } from '@trustwork/data';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { sources } from '../../packages/data/src/repositories/sources.js';
import { calendarDate, registers, registersWorker } from '../../packages/data/src/repositories/registers.js';
import {
  EXPIRY_REMINDER_DAYS, REGISTER_ADAPTERS, SOURCED_FACT_KINDS, type SourcedObservation,
} from '../../packages/contracts/src/sourced-facts.js';
import { fakeObservations } from '../../apps/api/src/modules/registers/fakes.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { NO_DISPLAY_USES, registerSource, registersWorld } from './helpers.js';
import { assertCardBinds } from '../admin/approval-change-helpers.js';

const env = await provisionWorkerDatabase('registers_db');

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const TODAY = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

/** A licence-board observation for a synthetic CSLB number (organisation holder, valid for a year by default). */
function licence(number: string, over: Partial<Extract<SourcedObservation, { kind: 'licence_status' }>> = {}): SourcedObservation {
  return {
    kind: 'licence_status', subject: { identifierKind: 'US-CA-CSLB', identifierValue: number, holderKind: 'organisation' },
    value: { status: 'active', classifications: ['B'], issuedOn: '2019-04-02' }, recordRef: number.replace(/\D/g, ''),
    link: `https://synthetic-register.invalid/us_ca_cslb_licence_file/${number.replace(/\D/g, '')}`, observedAt: new Date().toISOString(),
    validUntil: isoDay(TODAY + 365 * DAY), ...over,
  } as SourcedObservation;
}
function inspection(ref: string): SourcedObservation {
  return {
    kind: 'safety_inspection', subject: { identifierKind: null, identifierValue: null, holderKind: 'organisation' },
    value: { inspectionRef: ref, openedOn: '2026-03-04', inspectionType: 'planned', status: 'closed', citations: 0 }, recordRef: ref,
    link: `https://synthetic-register.invalid/us_osha_inspections/${ref}`, observedAt: new Date().toISOString(), validUntil: null,
  };
}

/**
 * REG-001 on real PostgreSQL under the runtime and worker roles: adapters come from the engine catalogue and read an
 * active official-register source; facts are append-only with the licence snapshot of their observation; they link to a
 * company only through an identifier it holds, or through a reviewed link with a reason; the public projection shows
 * only what an organisation's displayable, current facts say (stale past valid_until, nothing about natural persons);
 * live mode needs a second person; the expiry watch reminds claimed companies once per step; and facts never touch a
 * reputation table. Every person, company, identifier and source is synthetic.
 */
test('REG-001 register facts on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const runtime = env.apiPool;
  const worker = env.workerPool(4);
  const world = await registersWorld(admin, runtime);
  const { w, as, cmd, owner, activeSource, company } = world;
  const p = w.people;
  const steward = p.hubOwner;
  const anon = async <T>(fn: (trx: Transaction) => Promise<T>): Promise<T> => {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      return await fn(bindTransaction(client));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };

  const board = await activeSource();
  const cslb = await cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'us_ca_cslb_licence_file', board.id, 7));
  const oshaSource = await activeSource({ name: 'Synthetic Inspections File', url: 'https://inspections.synthetic-agency.invalid/data' });
  const osha = await cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'us_osha_inspections', oshaSource.id, 30));

  await t.test('the database vocabularies match the contract', async () => {
    const kinds = (await admin.query<{ v: string[] }>('SELECT trustwork.registers_fact_kinds() AS v')).rows[0]?.v;
    assert.deepEqual(kinds, [...SOURCED_FACT_KINDS]);
    const { rows } = await admin.query<{ adapter: string; kinds: string[]; identifier_kind: string | null; method: string; refresh_days: number }>('SELECT * FROM trustwork.registers_catalogue() ORDER BY adapter');
    assert.deepEqual(rows, [...REGISTER_ADAPTERS].sort((x, y) => x.id.localeCompare(y.id)).map((r) => ({
      adapter: r.id, kinds: [...r.kinds], identifier_kind: r.identifierKind, method: r.method, refresh_days: r.refreshDays })));
    const days = (await admin.query<{ v: number[] }>('SELECT trustwork.registers_reminder_days() AS v')).rows[0]?.v;
    assert.deepEqual(days, [...EXPIRY_REMINDER_DAYS]);
  });

  await t.test('adapters come from the catalogue, read an active official register of the hub and are bound by stewards only', async () => {
    await rejects(cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'scraped_reviews', board.id, 7)), '23514', 'registers.unknown_adapter');
    const media = await activeSource({ kind: 'rss', readerKind: 'industry_media', name: 'Synthetic Trade Journal', url: 'https://journal.synthetic.invalid/feed.xml' });
    await rejects(cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'gleif_lei', media.id, 30)), '23514', 'registers.source_not_register');
    const proposed = await cmd(steward, (trx, ctx) => sources.register(trx, ctx, w.hubId, { ...registerSource(steward), name: 'Synthetic Proposed Register' }));
    await rejects(cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'gleif_lei', proposed.id, 30)), '23514', 'registers.source_not_register');
    await rejects(cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'gleif_lei', board.id, 31)), '23514', 'registers.refresh_out_of_range');
    await rejects(cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'us_ca_cslb_licence_file', board.id, 7)), '23505', 'registers.already_bound');
    await rejects(cmd(p.agent, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'gleif_lei', board.id, 30)), '42501', 'admin.forbidden');
    await rejects(cmd(p.otherAgent, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'gleif_lei', board.id, 30)), '42501', 'admin.forbidden');
    await rejects(cmd(p.outsider, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'gleif_lei', board.id, 30)), '42501', 'admin.forbidden');
    assert.equal(cslb.mode, 'fake');
  });

  await t.test('facts are append-only; an unchanged observation adds nothing and a changed one supersedes', async () => {
    const [first] = await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [licence('1000123')]));
    assert.ok(first);
    assert.deepEqual([first.identifier_norm, first.holder_kind, first.recorded_by, first.mode, first.method], ['1000123', 'organisation', steward, 'fake', 'structured_feed']);
    assert.equal(first.licence_snapshot.displayHeadlineAndLink, true);
    const [again] = await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [licence('1000123')]));
    assert.equal(again?.id, first.id, 'nothing changed, so nothing is added');
    const [changed] = await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [licence('1000123', { value: { status: 'suspended', classifications: ['B'], issuedOn: '2019-04-02' } })]));
    assert.notEqual(changed?.id, first.id);
    const current = await as(steward, (trx) => registers.currentFacts(trx, cslb.id));
    assert.deepEqual(current.map((f) => [f.id, (f.value as { status: string }).status]), [[changed?.id, 'suspended']]);
    const old = await owner((trx) => trx.selectFrom('register_fact').selectAll().where('id', '=', first.id).executeTakeFirstOrThrow());
    assert.equal(old.superseded_by, changed?.id);
    await rejects(owner((trx) => sql`UPDATE trustwork.register_fact SET value = '{}'::jsonb WHERE id = ${changed?.id}::uuid`.execute(trx)), '23000', 'registers.append_only');
    await rejects(owner((trx) => sql`DELETE FROM trustwork.register_fact WHERE id = ${first.id}::uuid`.execute(trx)), '23000', 'registers.append_only');
    await rejects(as(steward, (trx) => sql`INSERT INTO trustwork.register_fact (hub_id) VALUES (${w.hubId}::uuid)`.execute(trx)), '42501');
  });

  await t.test('observations never carry a person\'s name or contact, and must fit the adapter', async () => {
    const named = { ...licence('1000124'), value: { status: 'active', classifications: ['B'], issuedOn: null, qualifierName: 'Synthetic Person' } } as unknown as SourcedObservation;
    await rejects(cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [named])), '23514', 'registers.invalid_value');
    const phone = { ...licence('1000124'), value: { status: 'active', classifications: ['555-0100 call Synthetic Person'], issuedOn: null } } as unknown as SourcedObservation;
    await rejects(cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [phone])), '23514', 'registers.invalid_value');
    const wrongKind = { ...licence('1000124'), subject: { identifierKind: 'US-UEI', identifierValue: 'SYNTH1234567', holderKind: 'organisation' } } as SourcedObservation;
    await rejects(cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [wrongKind])), '23514', 'registers.identifier_kind_mismatch');
    await rejects(cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [inspection('SYN-1')])), '23514', 'registers.kind_not_reported');
    await rejects(cmd(p.agent, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [licence('1000124')])), '42501', 'admin.forbidden');
  });

  await t.test('facts link to a company only through an identifier it holds, never by name', async () => {
    const holder = await company('Synthetic Licence Holder Inc', [{ kind: 'US-CA-CSLB', value: '1 000-123' }]);
    const sameName = await company('Synthetic Licence Holder Inc', []);
    const otherKind = await company('Synthetic Other Kind Inc', [{ kind: 'US-CA-SOS', value: '1000123' }]);
    assert.deepEqual((await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, holder))).map((f) => f.identifier_norm), ['1000123']);
    assert.deepEqual(await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, sameName)), []);
    assert.deepEqual(await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, otherKind)), []);
    assert.equal((await anon((trx) => registers.publicFacts(trx, w.hubId, sameName))).length, 0);
    await rejects(as(p.outsider, (trx) => registers.companyFacts(trx, w.hubId, holder)), 'P0002', 'admin.not_found');
    await rejects(as(p.otherAgent, (trx) => registers.companyFacts(trx, w.hubId, holder)), 'P0002', 'admin.not_found');
    assert.deepEqual(await as(p.outsider, (trx) => trx.selectFrom('register_fact').select('id').execute()), []);
    assert.deepEqual(await as(p.otherAgent, (trx) => trx.selectFrom('register_adapter').select('id').execute()), []);
  });

  await t.test('records without an identifier link only by a person\'s reviewed decision with a reason', async () => {
    await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, osha.id, [inspection('SYN-OSHA-1')]));
    const site = await company('Synthetic Site Builders', []);
    assert.deepEqual(await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, site)), []);
    await rejects(cmd(steward, (trx, ctx) => registers.linkRecord(trx, ctx, osha.id, 'SYN-OSHA-1', site, 'short')), '23514');
    await rejects(cmd(steward, (trx, ctx) => registers.linkRecord(trx, ctx, cslb.id, '1000123', site, 'The licence number matches the company page.')), '23514', 'registers.link_by_identifier');
    await rejects(cmd(p.agent, (trx, ctx) => registers.linkRecord(trx, ctx, osha.id, 'SYN-OSHA-1', site, 'Address and establishment match the claim file.')), '42501', 'admin.forbidden');
    const link = await cmd(steward, (trx, ctx) => registers.linkRecord(trx, ctx, osha.id, 'SYN-OSHA-1', site, 'Address and establishment match the claim file.'));
    assert.deepEqual((await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, site))).map((f) => f.kind), ['safety_inspection']);
    await rejects(cmd(p.lead2, (trx, ctx) => registers.linkRecord(trx, ctx, osha.id, 'SYN-OSHA-1', site, 'Address and establishment match the claim file.')), '23505', 'registers.already_linked');
    await cmd(p.lead2, (trx, ctx) => registers.endLink(trx, ctx, link.id));
    assert.deepEqual(await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, site)), []);
  });

  await t.test('the public projection shows only displayable facts about organisations, stale past expiry, with no person data', async () => {
    const shown = await company('Synthetic Shown Builders', [{ kind: 'US-CA-CSLB', value: '2000001' }, { kind: 'US-CA-CSLB', value: '2000002' }, { kind: 'US-CA-CSLB', value: '2000003' }]);
    await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, cslb.id, [
      licence('2000001'),
      licence('2000002', { validUntil: isoDay(TODAY - 2 * DAY), value: { status: 'expired', classifications: ['C-10'], issuedOn: null } }),
      licence('2000003', { subject: { identifierKind: 'US-CA-CSLB', identifierValue: '2000003', holderKind: 'natural_person' } }),
    ]));
    const facts = await anon((trx) => registers.publicFacts(trx, w.hubId, shown));
    assert.deepEqual(facts.map((f) => [(f.value as { status: string }).status, f.stale]).sort(), [['active', false], ['expired', true]]);
    for (const fact of facts) {
      assert.deepEqual(Object.keys(fact).sort(), ['identifier_kind', 'kind', 'link', 'observed_at', 'source_id', 'stale', 'valid_until', 'value']);
      assert.ok(!JSON.stringify(fact).includes('2000003'));
    }
    const staffView = await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, shown));
    assert.equal(staffView.length, 3, 'staff see every fact, including the one about a natural person');
    assert.equal(calendarDate(staffView.find((f) => f.identifier_norm === '2000002')?.valid_until ?? null), isoDay(TODAY - 2 * DAY));

    // A source whose licence does not allow display: nothing from it reaches a public page.
    const quiet = await activeSource({ name: 'Synthetic Display-Free Register', url: 'https://quiet.synthetic-register.invalid/data', allowedUses: { ...NO_DISPLAY_USES } });
    const lei = await cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'gleif_lei', quiet.id, 30));
    const leiHolder = await company('Synthetic LEI Holder', [{ kind: 'XX-LEI', value: '5299SYNTHETIC0000042' }]);
    await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, lei.id, fakeObservations('gleif_lei', [{ identifierValue: '5299SYNTHETIC0000042' }], new Date())));
    assert.equal((await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, leiHolder))).length, 1);
    assert.deepEqual(await anon((trx) => registers.publicFacts(trx, w.hubId, leiHolder)), []);

    // A taken-down source hides what it gave, at once.
    await cmd(steward, (trx, ctx) => sources.takedown(trx, ctx, { sourceId: board.id, itemId: null }, 'rights_holder_request', 'Synthetic takedown for the test.'));
    assert.deepEqual(await anon((trx) => registers.publicFacts(trx, w.hubId, shown)), []);
  });

  await t.test('live mode needs a credential reference and a second person', async () => {
    const leiSource = await activeSource({ name: 'Synthetic LEI Index', url: 'https://lei.synthetic-index.invalid/data' });
    const sam = await cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'us_sam_entity', leiSource.id, 30));
    const credential = await owner(async (trx) => (await trx.insertInto('provider_credential_ref').values({ hub_id: w.hubId, provider: 'synthetic_sam', adapter: 'us_sam_entity', mode: 'live',
      secret_store: 'env', secret_ref: 'env:SYNTHETIC_SAM_KEY', registered_by: steward }).returning('id').executeTakeFirstOrThrow()).id);
    await rejects(cmd(steward, (trx, ctx) => registers.goLive(trx, ctx, sam.id, sam.revision, credential, null)), '42501', 'admin.approval_required');
    await rejects(cmd(steward, (trx, ctx) => registers.goLive(trx, ctx, sam.id, sam.revision, null, null)), '23514', 'registers.credential_required');
    const digest = await as(steward, (trx) => registers.liveDigest(trx, sam.id, sam.revision, credential));
    const request = await cmd(steward, (trx, ctx) => approvals.request(trx, ctx, { action: 'providers.enable_non_fake', scope: world.hub, actionDigest: digest }));
    await rejects(cmd(steward, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest)), '42501');
    const shown = (await as(p.lead2, (trx) => approvals.changes(trx, [request.id]))).get(request.id) as { bound: boolean; fields: Array<{ field: string }> };
    assert.ok(shown.bound && shown.fields.some((f) => f.field === 'adapter'), 'the second person reads the adapter the digest binds');
    await assertCardBinds(env.db.admin, request.id);
    await cmd(p.lead2, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    const live = await cmd(steward, (trx, ctx) => registers.goLive(trx, ctx, sam.id, sam.revision, credential, request.id));
    assert.equal(live.mode, 'live');
    await rejects(cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, sam.id, fakeObservations('us_sam_entity', [{ identifierValue: 'SYNTH1234567' }], new Date()))),
      '23514', 'registers.live_results_from_adapter');
    const recorded = await tx(worker, (trx) => registersWorker.recordAdapterRun(trx, sam.id, fakeObservations('us_sam_entity', [{ identifierValue: 'SYNTH1234567' }], new Date()), new Date()));
    assert.equal(recorded, 2);
    const facts = await as(steward, (trx) => registers.currentFacts(trx, sam.id));
    assert.deepEqual(facts.map((f) => [f.kind, f.mode, f.recorded_by]), [['sam_exclusion', 'live', null], ['sam_registration', 'live', null]]);
    await rejects(cmd(steward, (trx, ctx) => registers.retireAdapter(trx, ctx, sam.id, sam.revision)), '40001', 'registers.revision_conflict');
    await cmd(steward, (trx, ctx) => registers.retireAdapter(trx, ctx, sam.id, live.revision));
  });

  await t.test('the expiry watch reminds a claimed company once per step before a licence lapses (clock test)', async () => {
    const reminderSource = await activeSource({ name: 'Synthetic Expiry Board', url: 'https://expiry.synthetic-board.invalid/data' });
    await cmd(steward, async (trx, ctx) => {
      const old = (await registers.adapters(trx, w.hubId)).find((a) => a.adapter === 'us_ca_cslb_licence_file' && a.status === 'active');
      if (old) await registers.retireAdapter(trx, ctx, old.id, old.revision);
    });
    const board2 = await cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'us_ca_cslb_licence_file', reminderSource.id, 7));
    const claimed = w.company;
    await owner((trx) => trx.updateTable('company').set({ claim_status: 'claimed', legal_identifiers: JSON.stringify([{ kind: 'US-CA-CSLB', value: '3000001', status: 'claimed' }]) })
      .where('id', '=', claimed).execute());
    const unclaimed = await company('Synthetic Unclaimed Builders', [{ kind: 'US-CA-CSLB', value: '3000002' }], 'unclaimed');
    const start = TODAY + 12 * 3_600_000;
    await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, board2.id, [
      licence('3000001', { validUntil: isoDay(TODAY + 75 * DAY) }), licence('3000002', { validUntil: isoDay(TODAY + 75 * DAY) }),
    ]));
    const at = (days: number) => new Date(start + days * DAY);
    const run = (days: number) => tx(worker, (trx) => registersWorker.runExpiryWatch(trx, at(days)));
    const mine = (rows: Awaited<ReturnType<typeof run>>) => rows.filter((r) => r.company_id === claimed || r.company_id === unclaimed).map((r) => [r.company_id === claimed ? 'claimed' : 'unclaimed', r.days_before]);
    assert.deepEqual(mine(await run(0)), [], '75 days ahead: nothing yet');
    assert.deepEqual(mine(await run(15)), [['claimed', 60]], '60 days ahead: the first reminder, only to the claimed company');
    assert.deepEqual(mine(await run(16)), [], 'once per step');
    assert.deepEqual(mine(await run(45)), [['claimed', 30]]);
    assert.deepEqual(mine(await run(69)), [['claimed', 7]]);
    assert.deepEqual(mine(await run(76)), [], 'after expiry the fact is stale, not reminded');
    const own = await as(p.employee, (trx) => registers.ownReminders(trx, claimed));
    assert.deepEqual(own.map((r) => r.days_before).sort((x, y) => x - y), [7, 30, 60]);
    assert.ok(own.every((r) => calendarDate(r.valid_until) === isoDay(TODAY + 75 * DAY) && r.link.startsWith('https://synthetic-register.invalid/')));
    await rejects(as(p.outsider, (trx) => registers.ownReminders(trx, claimed)), 'P0002', 'access.not_found');
    await rejects(as(p.agent, (trx) => registers.ownReminders(trx, claimed)), 'P0002', 'access.not_found');

    // Each reminder reaches the company's administrators in the notification centre once, with three plain values only.
    const notices = await as(p.employee, (trx) => trx.selectFrom('notification').selectAll().where('template_key', '=', 'registers.licence_expiring').execute());
    assert.deepEqual(notices.map((n) => (n.params as { daysBefore: string }).daysBefore).sort((x, y) => Number(x) - Number(y)), ['6', '30', '60']);
    for (const n of notices) {
      assert.deepEqual(Object.keys(n.params as object).sort(), ['daysBefore', 'factKind', 'validUntil']);
      assert.deepEqual([n.category, n.transactional, n.link_kind, (n.params as { validUntil: string }).validUntil], ['account', true, null, isoDay(TODAY + 75 * DAY)]);
      assert.ok(!JSON.stringify(n.params).includes('3000001'), 'no identifier in a notice');
    }
    assert.equal((await as(p.outsider, (trx) => trx.selectFrom('notification').select('id').where('template_key', '=', 'registers.licence_expiring').execute())).length, 0);
  });

  await t.test('canonical entities read the current facts by identifier (staff of the hub only)', async () => {
    const facts = await as(p.agent, (trx) => registers.identifierFacts(trx, w.hubId, 'US-CA-CSLB', '3 000 001'));
    assert.deepEqual(facts.map((f) => [f.kind, f.identifier_norm, f.superseded_at]), [['licence_status', '3000001', null]]);
    assert.ok(facts.every((f) => f.licence_snapshot && f.source_id && f.observed_at));
    await rejects(as(p.outsider, (trx) => registers.identifierFacts(trx, w.hubId, 'US-CA-CSLB', '3000001')), 'P0002', 'admin.not_found');
    await rejects(as(p.otherAgent, (trx) => registers.identifierFacts(trx, w.hubId, 'US-CA-CSLB', '3000001')), 'P0002', 'admin.not_found');
  });

  await t.test('the worker refreshes due adapters; the runtime role cannot call worker functions', async () => {
    const due = await tx(worker, (trx) => registersWorker.dueAdapters(trx, new Date(Date.now() + 31 * DAY), 50));
    assert.ok(due.some((a) => a.id === osha.id));
    assert.ok(due.every((a) => a.status === 'active'));
    await assert.rejects(tx(runtime, (trx) => registersWorker.dueAdapters(trx, new Date(), 10)), /permission denied/);
    await assert.rejects(tx(runtime, (trx) => registersWorker.recordAdapterRun(trx, osha.id, [], new Date())), /permission denied/);
    await assert.rejects(tx(runtime, (trx) => registersWorker.runExpiryWatch(trx, new Date())), /permission denied/);
  });

  await t.test('register facts never touch reputation (comparison and function bodies)', async () => {
    const reputationTables = ['professional_credential', 'credential_check', 'portfolio_entry', 'relation_declaration', 'confirmation_request', 'confirmation_response',
      'contribution_record', 'timeliness_observation', 'automated_limitation'];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const table of reputationTables) {
        out[table] = (await admin.query<{ v: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS v FROM trustwork.${table} t`)).rows[0]?.v ?? '';
      }
      return out;
    };
    const before = await snapshot();
    const subject = await company('Synthetic Comparison Builders', [{ kind: 'US-CA-CSLB', value: '4000001' }], 'verified');
    const active = (await as(steward, (trx) => registers.adapters(trx, w.hubId))).find((a) => a.adapter === 'us_ca_cslb_licence_file' && a.status === 'active');
    assert.ok(active);
    await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, active.id, [licence('4000001', { validUntil: isoDay(TODAY + 20 * DAY) })]));
    await tx(worker, (trx) => registersWorker.runExpiryWatch(trx, new Date()));
    assert.equal((await as(p.agent, (trx) => registers.companyFacts(trx, w.hubId, subject))).length, 1);
    assert.deepEqual(await snapshot(), before);

    const { rows } = await admin.query<{ proname: string; src: string }>(
      "SELECT p.proname, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND (p.proname LIKE 'registers\\_%' OR p.proname LIKE 'reputation\\_%')");
    for (const row of rows) {
      const other = row.proname.startsWith('registers_') ? [...reputationTables, 'reputation_'] : ['register_fact', 'register_adapter', 'register_fact_link', 'register_reminder', 'registers_'];
      for (const name of other) assert.ok(!row.src.includes(name), `${row.proname} must not name ${name}`);
    }
  });
});
