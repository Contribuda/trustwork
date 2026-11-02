import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { datasets, datasetsWorker } from '../../packages/data/src/repositories/datasets.js';
import { DATASET_SUBJECTS, DatasetOutputSchema, LegalBasisSchema, PersonalDataCategorySchema } from '../../packages/contracts/src/hub.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { datasetInput, datasetsWorld, record } from './helpers.js';

const env = await provisionWorkerDatabase('datasets_db');
const DAY = 86_400_000;
const digest = () => 'a'.repeat(64);

/**
 * MINE-001 first slice on real PostgreSQL under the runtime and worker roles: the database vocabularies equal the
 * contract; reputation is never an output; people, court and debt datasets keep their rules; activation is another
 * person's decision, with a second person for personal data and court or debt data; contract datasets need a licence
 * in force; every record carries its provenance; the do-not-collect list drops records before storage on every
 * refresh and buries stored ones; contact points need a person's decision and provenance; retention and licence
 * expiry bury records and leave digest-only tombstones; only staff of the hub read anything. Every value is synthetic.
 */
test('MINE-001 datasets on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const runtime = env.apiPool;
  const worker = env.workerPool(4);
  const world = await datasetsWorld(admin, runtime);
  const { w, as, cmd, owner, activeSource } = world;
  const p = w.people;
  const steward = p.hubOwner;
  const second = p.lead2;
  const register = await activeSource();

  const activeDataset = async (over: Parameters<typeof datasetInput>[1] = {}) => {
    const proposed = await cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], over)));
    return cmd(second, (trx, ctx) => datasets.activate(trx, ctx, proposed.id, proposed.revision, null));
  };

  await t.test('the database vocabularies equal the contract; reputation is never an output', async () => {
    const { rows } = await admin.query<{ s: string[]; o: string[]; b: string[]; c: string[] }>(
      'SELECT trustwork.datasets_subjects() AS s, trustwork.datasets_outputs() AS o, trustwork.datasets_legal_bases() AS b, trustwork.datasets_personal_categories() AS c');
    assert.deepEqual(rows[0], { s: [...DATASET_SUBJECTS], o: [...DatasetOutputSchema.options], b: [...LegalBasisSchema.options], c: [...PersonalDataCategorySchema.options] });
    await rejects(cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { outputs: ['directory_sourced_records', 'reputation'] }))),
      '23514', 'datasets.reputation_not_an_output');
  });

  await t.test('people, court and debt datasets keep their rules', async () => {
    const people = { subject: 'people', personalData: { present: true, naturalPersons: true, categories: ['name', 'professional_role'] }, impactAssessmentRef: randomUUID() };
    await rejects(cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { ...people, legalBasis: 'statutory_public_register', publicDisplay: false }))), '23514');
    await rejects(cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { ...people, legalBasis: 'consent', publicDisplay: true }))), '23514');
    await rejects(cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { ...people, legalBasis: 'consent', publicDisplay: false, impactAssessmentRef: null }))), '23514');
    const court = { subject: 'court_cases', impactAssessmentRef: randomUUID(), personalData: { present: true, naturalPersons: true, categories: ['court_party'] } };
    await rejects(cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { ...court, publicDisplay: true, outputs: ['verification_evidence'] }))), '23514',
      undefined);
    await rejects(cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { ...court, publicDisplay: false, outputs: ['verification_evidence', 'knowledge_base'] }))),
      '23514');
    const ok = await cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { ...court, publicDisplay: false, outputs: ['verification_evidence'] })));
    assert.equal(ok.status, 'proposed');
    await rejects(cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { subject: 'events', outputs: ['matching_eligibility'] }))), '23514');
  });

  await t.test('activation is another person\'s decision; court and personal-data datasets need a second person', async () => {
    const proposed = await cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id])));
    await rejects(cmd(steward, (trx, ctx) => datasets.activate(trx, ctx, proposed.id, proposed.revision, null)), '42501', 'datasets.self_activation');
    await rejects(cmd(p.agent, (trx, ctx) => datasets.activate(trx, ctx, proposed.id, proposed.revision, null)), '42501', 'admin.forbidden');
    await rejects(cmd(p.otherAgent, (trx, ctx) => datasets.activate(trx, ctx, proposed.id, proposed.revision, null)), '42501', 'admin.forbidden');
    const active = await cmd(second, (trx, ctx) => datasets.activate(trx, ctx, proposed.id, proposed.revision, null));
    assert.deepEqual([active.status, active.activated_by, active.approval_id], ['active', second, null]);

    const licences = await cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], {
      subject: 'licences_permits', personalData: { present: true, naturalPersons: true, categories: ['name', 'licence_number'] }, publicDisplay: false })));
    await rejects(cmd(second, (trx, ctx) => datasets.activate(trx, ctx, licences.id, licences.revision, null)), '42501', 'admin.approval_required');
    const d = await as(second, (trx) => datasets.activationDigest(trx, licences.id, licences.revision));
    const request = await cmd(second, (trx, ctx) => approvals.request(trx, ctx, { action: 'pipelines.activate_personal_data_dataset', scope: world.hub, actionDigest: d }));
    await cmd(steward, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', d));
    const live = await cmd(second, (trx, ctx) => datasets.activate(trx, ctx, licences.id, licences.revision, request.id));
    assert.equal(live.approval_id, request.id);
  });

  await t.test('a contract dataset needs a licence in force to activate and to receive records', async () => {
    const operator = await cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], { legalBasis: 'contract', name: 'Synthetic operator list' })));
    await rejects(cmd(second, (trx, ctx) => datasets.activate(trx, ctx, operator.id, operator.revision, null)), '23514', 'datasets.licence_required');
    const today = new Date().toISOString().slice(0, 10);
    const licence = await cmd(steward, (trx, ctx) => datasets.recordLicence(trx, ctx, operator.id, {
      supplier: 'Synthetic Data Supplier', agreementDigest: digest(), agreementRef: 'agreement:SYN-1', purposes: ['directory_sourced_records'],
      uses: { display: true, enrich: true, contactUse: false, syndicate: false }, validFrom: today, validUntil: new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10) }));
    assert.equal(licence.supplier, 'Synthetic Data Supplier');
    const active = await cmd(second, (trx, ctx) => datasets.activate(trx, ctx, operator.id, operator.revision, null));
    await rejects(cmd(steward, (trx, ctx) => datasets.setContactUse(trx, ctx, active.id, active.revision, true)), '23514', 'datasets.licence_forbids_contact');
    const counts = await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, active.id, [record(register.id, 'OP1'), record(register.id, 'OP2')]));
    assert.deepEqual(counts, { stored: 2, unchanged: 0, droppedDoNotCollect: 0 });
    // The licence ends: the next sweep deletes every record of the dataset and leaves tombstones with digests only.
    const swept = await tx(worker, (trx) => datasetsWorker.sweep(trx, new Date(Date.now() + 12 * DAY)));
    assert.ok(swept.licenceEnded >= 2);
    assert.deepEqual(await as(steward, (trx) => datasets.records(trx, active.id)), []);
    const stones = await as(steward, (trx) => datasets.tombstones(trx, active.id));
    assert.deepEqual(stones.map((s) => s.reason), ['licence_ended', 'licence_ended']);
    assert.ok(stones.every((s) => /^[a-f0-9]{64}$/.test(s.key_digest) && !JSON.stringify(s).includes('OP1')));
    await rejects(tx(worker, (trx) => datasetsWorker.ingest(trx, active.id, [record(register.id, 'OP3')], new Date(Date.now() + 12 * DAY))), '23514', 'datasets.licence_required');
  });

  await t.test('every record carries provenance; unchanged records add nothing; records come only from the dataset\'s sources', async () => {
    const companies = await activeDataset({ name: 'Synthetic register mirror' });
    const first = await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [record(register.id, 'C100'), record(register.id, 'C200')]));
    assert.deepEqual(first, { stored: 2, unchanged: 0, droppedDoNotCollect: 0 });
    const again = await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [record(register.id, 'C100'), record(register.id, 'C200')]));
    assert.deepEqual(again, { stored: 0, unchanged: 2, droppedDoNotCollect: 0 });
    const rows = await as(steward, (trx) => datasets.records(trx, companies.id));
    for (const r of rows) {
      assert.deepEqual(Object.keys(r.provenance).sort(), ['licenceSnapshot', 'method', 'observedAt', 'sourceUrl']);
      assert.equal(r.provenance.licenceSnapshot.displayHeadlineAndLink, true);
      assert.ok(r.provenance.sourceUrl.startsWith('https://register.synthetic-state.invalid/'));
    }
    const other = await activeSource({ name: 'Synthetic Other Register', url: 'https://other.synthetic-state.invalid/data' });
    await rejects(cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [record(other.id, 'C300')])), '23514', 'datasets.source_not_in_dataset');
    await rejects(cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [{ ...record(register.id, 'C400'), fields: { trustScore: '99' } }])), '23514');
    await rejects(cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [{ ...record(register.id, 'C500'), sourceUrl: 'http://plain.invalid/x' }])), '23514');
    await rejects(as(steward, (trx) => sql`INSERT INTO trustwork.dataset_record (hub_id) VALUES (${w.hubId}::uuid)`.execute(trx)), '42501');
  });

  await t.test('the do-not-collect list drops records before storage on every refresh and buries stored ones', async () => {
    const companies = await activeDataset({ name: 'Synthetic objection test' });
    await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [record(register.id, 'D7101'), record(register.id, 'D7201'), record(register.id, 'D7301')]));
    const buried = await cmd(steward, (trx, ctx) => datasets.addDoNotCollect(trx, ctx, w.hubId, 'identifier', '71-01', 'objection'));
    assert.equal(buried, 1, 'the stored D7101 record is buried at once');
    assert.equal(await cmd(steward, (trx, ctx) => datasets.addDoNotCollect(trx, ctx, w.hubId, 'domain', 'D7201.synthetic-builders.invalid', 'objection')), 1);
    const refresh = await tx(worker, (trx) => datasetsWorker.ingest(trx, companies.id, [record(register.id, 'D7101'), record(register.id, 'D7201'), record(register.id, 'D7301')], new Date()));
    assert.deepEqual(refresh, { stored: 0, unchanged: 1, droppedDoNotCollect: 2 });
    assert.deepEqual((await as(steward, (trx) => datasets.records(trx, companies.id))).map((r) => r.external_key), ['D7301']);
    const stones = await as(steward, (trx) => datasets.tombstones(trx, companies.id));
    assert.deepEqual(stones.map((s) => s.reason), ['do_not_collect', 'do_not_collect']);
    const list = await owner((trx) => trx.selectFrom('dataset_do_not_collect').selectAll().where('hub_id', '=', w.hubId).execute());
    assert.ok(list.every((e) => /^[a-f0-9]{64}$/.test(e.digest)) && !JSON.stringify(list).includes('synthetic-builders'), 'the list keeps digests only');
    await assert.rejects(as(steward, (trx) => trx.selectFrom('dataset_do_not_collect').selectAll().execute()), /permission denied/);
    await rejects(cmd(p.agent, (trx, ctx) => datasets.addDoNotCollect(trx, ctx, w.hubId, 'identifier', '9', 'objection')), '42501', 'admin.forbidden');
  });

  await t.test('contact points need a person\'s decision, an organisation record and provenance', async () => {
    const companies = await activeDataset({ name: 'Synthetic contact test' });
    await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [record(register.id, 'E8101'), record(register.id, 'E8201', { naturalPerson: true })]));
    const [org, person] = await as(steward, (trx) => datasets.records(trx, companies.id));
    assert.ok(org && person);
    assert.deepEqual(await as(steward, (trx) => datasets.contactPoints(trx, w.hubId, companies.id)), [], 'nothing by default');
    await rejects(cmd(steward, (trx, ctx) => datasets.markContact(trx, ctx, org.id, true)), '23514', 'datasets.contact_not_allowed');
    const allowed = await cmd(steward, (trx, ctx) => datasets.setContactUse(trx, ctx, companies.id, companies.revision, true));
    await rejects(cmd(steward, (trx, ctx) => datasets.markContact(trx, ctx, person.id, true)), '23514', 'datasets.contact_not_allowed');
    await cmd(steward, (trx, ctx) => datasets.markContact(trx, ctx, org.id, true));
    const points = await as(steward, (trx) => datasets.contactPoints(trx, w.hubId, companies.id));
    assert.deepEqual(points.map((c) => c.external_key), ['E8101']);
    assert.ok(points[0]?.provenance.sourceUrl);
    // A changed record loses its contact decision; turning contact use off clears every decision.
    await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [record(register.id, 'E8101', { fields: { legalName: 'Synthetic Builders E8101 Renamed', status: 'active' } })]));
    assert.deepEqual(await as(steward, (trx) => datasets.contactPoints(trx, w.hubId, companies.id)), []);
    await cmd(steward, (trx, ctx) => datasets.markContact(trx, ctx, org.id, true));
    await cmd(steward, (trx, ctx) => datasets.setContactUse(trx, ctx, companies.id, allowed.revision, false));
    assert.deepEqual(await as(steward, (trx) => datasets.contactPoints(trx, w.hubId, companies.id)), []);
    await rejects(as(p.outsider, (trx) => datasets.contactPoints(trx, w.hubId, companies.id)), 'P0002', 'admin.not_found');
    const court = await cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id], {
      subject: 'court_cases', impactAssessmentRef: randomUUID(), personalData: { present: false, naturalPersons: false, categories: [] }, publicDisplay: false, outputs: ['verification_evidence'] })));
    await rejects(cmd(steward, (trx, ctx) => datasets.setContactUse(trx, ctx, court.id, court.revision, true)), '23514');
  });

  await t.test('retention buries records with tombstones; retiring buries the rest', async () => {
    const companies = await activeDataset({ name: 'Synthetic retention test', retention: { className: 'short', days: 2 } });
    await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, companies.id, [record(register.id, 'F9101'), record(register.id, 'F9201')]));
    assert.equal((await tx(worker, (trx) => datasetsWorker.sweep(trx, new Date(Date.now() + DAY)))).retention, 0);
    const swept = await tx(worker, (trx) => datasetsWorker.sweep(trx, new Date(Date.now() + 3 * DAY)));
    assert.ok(swept.retention >= 2);
    assert.deepEqual(await as(steward, (trx) => datasets.records(trx, companies.id)), []);
    const other = await activeDataset({ name: 'Synthetic retire test' });
    await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, other.id, [record(register.id, 'G6101')]));
    await cmd(steward, (trx, ctx) => datasets.setStatus(trx, ctx, other.id, other.revision, 'retired'));
    assert.deepEqual((await as(steward, (trx) => datasets.tombstones(trx, other.id))).map((s) => s.reason), ['dataset_retired']);
    await rejects(cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, other.id, [record(register.id, 'G6201')])), '23514', 'datasets.not_active');
  });

  await t.test('only staff of the hub read; the runtime role cannot call worker functions', async () => {
    assert.ok((await as(p.agent, (trx) => datasets.list(trx, w.hubId))).length > 0);
    assert.deepEqual(await as(p.outsider, (trx) => datasets.list(trx, w.hubId)), []);
    assert.deepEqual(await as(p.otherAgent, (trx) => trx.selectFrom('dataset_record').select('id').execute()), []);
    await assert.rejects(tx(runtime, (trx) => datasetsWorker.sweep(trx, new Date())), /permission denied/);
  });
});
