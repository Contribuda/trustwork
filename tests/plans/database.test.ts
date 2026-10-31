import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { planChanges, planItemStates, planParts, plans, planShares, planVersions, projectDiary, projectLocations, permitRecords } from '../../packages/data/src/repositories/plans.js';
import { planVersionDigestInput, type PlanContent, type PlanItem } from '../../packages/contracts/src/plans.js';
import { provisionTestDatabase, SKIP_REASON, untilDatabaseTimePasses } from '../data/helpers/postgres.js';
import { principalFor, seedFixtures } from '../data/helpers/seed.js';

/**
 * PLAN-001 database layer under the real runtime role (FORCE RLS, no mocks): owner-side access through the project,
 * frozen proposed versions and kept approved ones for every role, approval only with `accept`, the acyclic check at
 * proposal, one path per item, immutable shares and the invitee projection, restricted places, the append-only diary,
 * and concurrent writers.
 */
const db = await provisionTestDatabase('plans_db');

const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const roofing = item({
  key: 'roofing', kind: 'task', title: 'Re-roof the house', description: 'Tear off and replace asphalt shingles', stepTerms: ['work.envelope.roofing', 'material.roofing.asphalt_shingles'],
  requiredSkills: ['trade.roofer'], quantity: { value: '2200', unit: 'ft2' }, estimate: { kind: 'estimate_range', low: { minorUnits: '1800000', currency: 'USD' }, high: { minorUnits: '2600000', currency: 'USD' }, basis: 'licensed_source', basisRef: 'dataset-demo-costs', asOf: '2026-10-31' },
  duration: { lowDays: 3, highDays: 6 }, window: { earliestStart: '2027-03-01', latestFinish: '2027-04-15' }, privateNotes: 'PRIVATE-NOTE-roofing',
});
const permit = item({ key: 'permit', kind: 'permit', title: 'Building permit', stepTerms: ['permit.building'], privateNotes: 'PRIVATE-NOTE-permit' });
const CONTENT: PlanContent = { summary: 'Roof replacement', assumptions: [], budget: null, timeline: null, items: [permit, roofing], dependencies: [{ predecessorKey: 'permit', successorKey: 'roofing', type: 'fs', lagDays: 0 }] };

interface PgError { code?: string; hint?: string; message?: string }
async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('plans database: RLS, frozen versions, approval authority, shares and concurrency', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  const reference = await kernelReference.fromRepository();
  await withMaintenance(db.admin, (trx) => kernelSync.apply(trx, reference));
  const project = seed.project;
  const { petr, pure, boris, carl, anna } = seed.people;
  // pure: an editor the owner authorised (owner-private audience, write.draft) but without `accept`.
  await withMaintenance(db.admin, (trx) => trx.insertInto('object_participation').values({
    resource_kind: 'project', resource_id: project, party_person_id: pure, party_company_id: null, side: 'participant', capabilities: ['read.shared', 'read.owner_private', 'write.draft'],
    audience: 'owner_private', granted_by_person_id: petr,
  }).execute());
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(db.app, await principalFor(db.admin, personId), fn);
  const proposeAs = (personId: string, versionId: string, content: PlanContent, version: number, planId: string) => as(personId, async (trx) => {
    await planVersions.lock(trx, versionId);
    await planParts.materialise(trx, versionId, content);
    return planVersions.propose(trx, versionId, { digest: computeDigest(planVersionDigestInput({ planId, version, content })).value, personId, via: 'person', mandateId: null, at: new Date() });
  });

  let planId = '';
  let v1 = '';
  await t.test('only the owner side creates and reads a plan; others see nothing and cannot write', async () => {
    const created = await as(petr, async (trx) => {
      const plan = await plans.insert(trx, { project_id: project, time_zone: 'America/Los_Angeles', created_by_person_id: petr, drafted_via: 'person', drafted_mandate_id: null });
      const draft = await planVersions.insertDraft(trx, { plan_id: plan.id, project_id: project, version: 1, content: CONTENT, based_on_version_id: null, drafted_by_person_id: petr, drafted_via: 'person', drafted_mandate_id: null });
      return { plan, draft };
    });
    planId = created.plan.id;
    v1 = created.draft.id;
    assert.equal(created.draft.status, 'draft');
    assert.equal((await as(pure, (trx) => plans.getByProject(trx, project)))?.id, planId, 'an owner-private participant reads it');
    for (const outsider of [boris, carl, anna]) {
      assert.equal(await as(outsider, (trx) => plans.getByProject(trx, project)), undefined, 'a shared_party participant, an unrelated administrator and another company see no plan');
      assert.deepEqual(await as(outsider, (trx) => planVersions.listForPlan(trx, planId)), []);
    }
    const anonymous = await db.app.query('SELECT count(*)::int AS n FROM trustwork.plan');
    assert.equal(anonymous.rows[0].n, 0, 'no identity, no rows');
    await fails(as(carl, (trx) => planVersions.insertDraft(trx, { plan_id: planId, project_id: project, version: 9, content: CONTENT, based_on_version_id: null, drafted_by_person_id: carl, drafted_via: 'person', drafted_mandate_id: null })), '42501');
    await fails(as(boris, (trx) => plans.insert(trx, { project_id: project, time_zone: 'UTC', created_by_person_id: boris, drafted_via: 'person', drafted_mandate_id: null })), '42501');
    await fails(as(petr, (trx) => planVersions.insertDraft(trx, { plan_id: planId, project_id: project, version: 2, content: CONTENT, based_on_version_id: null, drafted_by_person_id: pure, drafted_via: 'person', drafted_mandate_id: null })), 'plans.not_authorised');
    await fails(as(petr, (trx) => sql`INSERT INTO trustwork.plan_version (plan_id, project_id, version, content, drafted_by_person_id, drafted_via) VALUES (${planId}, ${project}, 2, '{"items":[],"dependencies":[]}', ${petr}, 'agent')`.execute(trx)), '23514');
  });

  await t.test('two editors save the same draft revision at once: exactly one wins', async () => {
    const edited = (title: string): PlanContent => ({ ...CONTENT, summary: title });
    const results = await Promise.allSettled([
      as(petr, (trx) => planVersions.saveContent(trx, v1, 1, edited('by owner'))),
      as(pure, (trx) => planVersions.saveContent(trx, v1, 1, edited('by editor'))),
    ]);
    const saved = results.filter((r) => r.status === 'fulfilled' && r.value !== undefined);
    assert.equal(saved.length, 1, JSON.stringify(results));
    const row = await as(petr, (trx) => planVersions.get(trx, v1));
    assert.equal(row?.revision, 2);
    await as(petr, (trx) => planVersions.saveContent(trx, v1, 2, CONTENT));
    await fails(as(boris, async (trx) => {
      const r = await planVersions.saveContent(trx, v1, 3, edited('outsider'));
      if (!r) throw Object.assign(new Error('invisible'), { code: 'invisible' });
    }), 'invisible');
  });

  await t.test('a proposal racing an item insert: the insert waits for the version lock, then finds it frozen', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const proposal = as(petr, async (trx) => {
      await planVersions.lock(trx, v1);
      await planParts.materialise(trx, v1, CONTENT);
      started();
      await gate;
      return planVersions.propose(trx, v1, { digest: computeDigest(planVersionDigestInput({ planId, version: 1, content: CONTENT })).value, personId: petr, via: 'person', mandateId: null, at: new Date() });
    });
    await startedP;
    const late = as(pure, (trx) => trx.insertInto('plan_item').values({ plan_version_id: v1, item_key: 'late', position: 9, kind: 'milestone', title: 'Late', step_terms: [], required_skills: [], sources: '[]', attachments: '[]' }).execute());
    await sleep(300);
    release();
    const proposed = await proposal;
    assert.equal(proposed.status, 'proposed');
    await fails(late, 'plans.version_frozen');
    assert.equal((await as(petr, (trx) => planParts.items(trx, v1))).length, 2, 'the frozen version has exactly its proposed items');
  });

  await t.test('a proposed version is frozen for every role, including maintenance; nothing is ever deleted', async () => {
    await fails(as(petr, (trx) => trx.updateTable('plan_version').set({ content: JSON.stringify({ ...CONTENT, summary: 'sneaky' }) }).where('id', '=', v1).execute()), 'plans.version_frozen');
    await fails(as(petr, (trx) => trx.updateTable('plan_version').set({ digest: 'f'.repeat(64) }).where('id', '=', v1).execute()), 'plans.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('plan_version').set({ content: JSON.stringify({ ...CONTENT, summary: 'repair' }) }).where('id', '=', v1).execute()), 'plans.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('plan_item').set({ title: 'Edited' }).where('plan_version_id', '=', v1).execute()), 'plans.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.deleteFrom('plan_item').where('plan_version_id', '=', v1).execute()), 'plans.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.deleteFrom('plan_version').where('id', '=', v1).execute()), 'plans.version_frozen');
    await fails(as(petr, (trx) => sql`DELETE FROM trustwork.plan_version WHERE id = ${v1}`.execute(trx)), '42501');
    await fails(as(petr, (trx) => trx.updateTable('plan_version').set({ status: 'draft' }).where('id', '=', v1).execute()), 'plans.invalid_version_transition');
  });

  await t.test('approval is the owner act: an editor without accept cannot approve; the owner can; approved stays immutable', async () => {
    await fails(as(pure, (trx) => planVersions.approve(trx, v1, { personId: pure, at: new Date(), changeId: null })), 'plans.not_authorised');
    await fails(as(petr, (trx) => planVersions.approve(trx, v1, { personId: pure, at: new Date(), changeId: null })), 'plans.not_authorised');
    await as(petr, async (trx) => {
      await planVersions.approve(trx, v1, { personId: petr, at: new Date(), changeId: null });
      await plans.setBaseline(trx, planId, v1);
    });
    await fails(as(petr, (trx) => trx.updateTable('plan_version').set({ content: JSON.stringify({ ...CONTENT, summary: 'after approval' }) }).where('id', '=', v1).execute()), 'plans.version_frozen');
    await fails(as(petr, (trx) => trx.updateTable('plan_version').set({ approved_at: new Date() }).where('id', '=', v1).execute()), 'plans.version_frozen');
    await fails(as(pure, (trx) => trx.updateTable('plan').set({ current_version_id: null, status: 'drafting' }).where('id', '=', planId).execute()), 'plans.version_frozen');
    await fails(as(petr, (trx) => trx.updateTable('plan').set({ status: 'drafting' }).where('id', '=', planId).execute()), 'plans.version_frozen');
  });

  await t.test('the database refuses cycles, missing parts, unknown terms and kind/term mismatches at proposal', async () => {
    const v2 = await as(petr, (trx) => planVersions.insertDraft(trx, { plan_id: planId, project_id: project, version: 2, content: CONTENT, based_on_version_id: v1, drafted_by_person_id: petr, drafted_via: 'person', drafted_mandate_id: null }));
    await fails(as(petr, (trx) => planVersions.insertDraft(trx, { plan_id: planId, project_id: project, version: 3, content: CONTENT, based_on_version_id: v1, drafted_by_person_id: petr, drafted_via: 'person', drafted_mandate_id: null })), '23505');
    const cyclic: PlanContent = { ...CONTENT, dependencies: [...CONTENT.dependencies, { predecessorKey: 'roofing', successorKey: 'permit', type: 'fs', lagDays: 0 }] };
    await fails(as(petr, async (trx) => {
      await planParts.materialise(trx, v2.id, cyclic);
      await sql`UPDATE trustwork.plan_version SET content = ${JSON.stringify(cyclic)}::jsonb WHERE id = ${v2.id}`.execute(trx);
      await planVersions.propose(trx, v2.id, { digest: 'e'.repeat(64), personId: petr, via: 'person', mandateId: null, at: new Date() });
    }), 'plans.dependency_cycle');
    await fails(as(petr, (trx) => planVersions.propose(trx, v2.id, { digest: 'e'.repeat(64), personId: petr, via: 'person', mandateId: null, at: new Date() })), 'plans.parts_missing');
    await fails(as(petr, (trx) => planParts.materialise(trx, v2.id, { ...CONTENT, items: [item({ key: 'x', kind: 'task', stepTerms: ['work.not_a_term'] })], dependencies: [] })), 'plans.unknown_term');
    await fails(as(petr, (trx) => planParts.materialise(trx, v2.id, { ...CONTENT, items: [item({ key: 'x', kind: 'permit', stepTerms: ['work.envelope.roofing'] })], dependencies: [] })), 'plans.unknown_term');
    await fails(as(petr, (trx) => planParts.materialise(trx, v2.id, { ...CONTENT, items: [item({ key: 'x', kind: 'task', stepTerms: ['work.envelope.roofing'], requiredSkills: ['material.roofing'] })], dependencies: [] })), 'plans.unknown_term');
    const est = { ...roofing, key: 'single', estimate: { ...roofing.estimate!, high: { minorUnits: '1800000', currency: 'USD' } } };
    await fails(as(petr, (trx) => planParts.materialise(trx, v2.id, { ...CONTENT, items: [est], dependencies: [] })), '23514');
    const proposed = await proposeAs(pure, v2.id, CONTENT, 2, planId);
    assert.equal(proposed.proposed_by_person_id, pure, 'an authorised editor proposes; approval stays with the owner');
    assert.equal(proposed.status, 'proposed');
  });

  await t.test('an agent proposal names its mandate; a change is never rewritten; approving a change needs its version approved', async () => {
    const v2 = await as(petr, (trx) => planVersions.inStatus(trx, planId, 'proposed'));
    assert.ok(v2);
    const change = await as(petr, (trx) => planChanges.insert(trx, {
      plan_id: planId, project_id: project, from_version_id: v1, to_version_id: v2.id, reason: 'Owner added a skylight', cause: 'owner_request', requested_by_person_id: petr, requested_by_company_id: null,
      accountable_person_id: petr, accountable_company_id: null, agreement_id: null, schedule_impact_days: 5, created_by_person_id: petr,
    }));
    await fails(as(petr, (trx) => trx.updateTable('plan_change').set({ status: 'approved', decided_by_person_id: petr, decided_at: new Date() }).where('id', '=', change.id).execute()), 'plans.invalid_change');
    await fails(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.plan_change SET reason = 'rewritten' WHERE id = ${change.id}`.execute(trx)), 'plans.change_immutable');
    await fails(as(pure, (trx) => planChanges.decide(trx, change.id, 1, { status: 'rejected', personId: pure, at: new Date() })), 'plans.not_authorised');
    await fails(as(pure, (trx) => planChanges.decide(trx, change.id, 1, { status: 'withdrawn', personId: pure, at: new Date() })), 'plans.not_authorised');
    await as(petr, async (trx) => {
      await planVersions.supersede(trx, v1, { byVersionId: v2.id, reason: 'replaced', at: new Date() });
      await planVersions.approve(trx, v2.id, { personId: petr, at: new Date(), changeId: change.id });
      await plans.setBaseline(trx, planId, v2.id);
      await planChanges.decide(trx, change.id, 1, { status: 'approved', personId: petr, at: new Date() });
    });
    const versions = await as(petr, (trx) => planVersions.listForPlan(trx, planId));
    assert.deepEqual(versions.map((v) => [v.version, v.status, v.superseded_reason]), [[1, 'superseded', 'replaced'], [2, 'approved', null]], 'original and revised versions are both kept');
    assert.ok(versions[0]?.approved_at, 'the superseded baseline keeps its approval facts');
    assert.equal((await as(petr, (trx) => planParts.items(trx, v1))).length, 2, 'the original items are kept');
  });

  await t.test('execution state: in the baseline only, one path per item, terminal states stay terminal', async () => {
    await fails(as(petr, (trx) => planItemStates.insert(trx, { plan_id: planId, project_id: project, item_key: 'ghost', status: 'proposed', path: null, link_kind: null, link_id: null, blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: petr })), 'plans.item_not_in_baseline');
    const s = await as(petr, (trx) => planItemStates.insert(trx, { plan_id: planId, project_id: project, item_key: 'roofing', status: 'accepted', path: 'rfq', link_kind: null, link_id: null, blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: petr }));
    await fails(as(petr, (trx) => planItemStates.update(trx, planId, 'roofing', s.revision, { status: 'requested', path: 'task', link_kind: 'task_request', link_id: 'task-1', blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: petr })), 'plans.item_path_taken');
    await fails(as(petr, (trx) => planItemStates.update(trx, planId, 'roofing', s.revision, { status: 'requested', path: 'rfq', link_kind: null, link_id: null, blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: petr })), '23514');
    const requested = await as(petr, (trx) => planItemStates.update(trx, planId, 'roofing', s.revision, { status: 'requested', path: 'rfq', link_kind: 'rfq', link_id: 'rfq-demo-1', blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: petr }));
    assert.equal(requested?.status, 'requested');
    await fails(as(petr, (trx) => planItemStates.update(trx, planId, 'roofing', requested!.revision, { status: 'requested', path: 'rfq', link_kind: 'rfq', link_id: 'rfq-demo-2', blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: petr })), 'plans.item_path_taken');
    const cancelled = await as(petr, (trx) => planItemStates.update(trx, planId, 'roofing', requested!.revision, { status: 'cancelled', path: 'rfq', link_kind: 'rfq', link_id: 'rfq-demo-1', blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: petr }));
    await fails(as(petr, (trx) => planItemStates.update(trx, planId, 'roofing', cancelled!.revision, { status: 'in_progress', path: 'rfq', link_kind: 'rfq', link_id: 'rfq-demo-1', blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: petr })), 'plans.invalid_item_transition');
  });

  let shareId = '';
  await t.test('shares: invitees read only their listed fields through the definer, never the plan tables', async () => {
    await as(petr, (trx) => projectLocations.insert(trx, { project_id: project, address: { lines: ['100 Demo Street'], locality: 'Escondido', region: 'CA', postalCode: '92025', countryCode: 'US' }, region_code: 'US-CA', cadastral_ref: '123-456-78-00', site_contact: { name: 'Demo Owner', phone: null, email: null }, site_access_notes: 'Gate code 4321', updated_by_person_id: petr }));
    await fails(as(petr, (trx) => planShares.insert(trx, { plan_id: planId, project_id: project, item_key: 'roofing', audience: 'invited', invitee_person_id: carl, invitee_company_id: null, fields: ['scope', 'address'], acceptance_kind: null, acceptance_id: null, preview_digest: 'a'.repeat(64), confirmed_by_person_id: petr, confirmed_at: new Date(), valid_until: null })), '23514');
    await fails(as(petr, (trx) => planShares.insert(trx, { plan_id: planId, project_id: project, item_key: 'ghost', audience: 'invited', invitee_person_id: carl, invitee_company_id: null, fields: ['scope'], acceptance_kind: null, acceptance_id: null, preview_digest: 'a'.repeat(64), confirmed_by_person_id: petr, confirmed_at: new Date(), valid_until: null })), 'plans.item_not_in_baseline');
    await fails(as(pure, (trx) => planShares.insert(trx, { plan_id: planId, project_id: project, item_key: 'roofing', audience: 'invited', invitee_person_id: carl, invitee_company_id: null, fields: ['scope'], acceptance_kind: null, acceptance_id: null, preview_digest: 'a'.repeat(64), confirmed_by_person_id: pure, confirmed_at: new Date(), valid_until: null })), '42501');
    const share = await as(petr, (trx) => planShares.insert(trx, { plan_id: planId, project_id: project, item_key: 'roofing', audience: 'invited', invitee_person_id: carl, invitee_company_id: null, fields: ['scope', 'trade', 'locality'], acceptance_kind: null, acceptance_id: null, preview_digest: 'a'.repeat(64), confirmed_by_person_id: petr, confirmed_at: new Date(), valid_until: null }));
    shareId = share.id;
    await as(petr, (trx) => planShares.insert(trx, { plan_id: planId, project_id: project, item_key: 'permit', audience: 'invited', invitee_company_id: seed.companies.supplier, invitee_person_id: null, fields: ['scope'], acceptance_kind: null, acceptance_id: null, preview_digest: 'a'.repeat(64), confirmed_by_person_id: petr, confirmed_at: new Date(), valid_until: null }));
    const rows = await as(carl, (trx) => planShares.sharedView(trx, project));
    assert.deepEqual(rows.map((r) => r.item_key), ['roofing'], 'only the item shared with carl');
    const [row] = rows;
    assert.equal(row?.description, roofing.description);
    assert.deepEqual(row?.required_skills, ['trade.roofer']);
    assert.equal(row?.region_code, 'US-CA');
    for (const hidden of ['estimate_low', 'estimate_high', 'quantity_value', 'window_start', 'address', 'site_contact', 'site_access_notes'] as const) assert.equal(row?.[hidden], null, `${hidden} not shared`);
    assert.ok(!JSON.stringify(rows).includes('PRIVATE-NOTE') && !JSON.stringify(rows).includes('123-456-78-00'), 'no notes, no cadastral reference');
    assert.deepEqual((await as(carl, (trx) => trx.selectFrom('plan_share').select(['item_key', 'invitee_person_id', 'invitee_company_id']).execute())), [{ item_key: 'roofing', invitee_person_id: carl, invitee_company_id: null }], 'an invitee sees only its own share rows');
    for (const table of ['plan', 'plan_version', 'plan_item', 'plan_dependency', 'plan_item_state', 'plan_change', 'project_location'] as const) {
      assert.deepEqual(await as(carl, (trx) => trx.selectFrom(table).selectAll().execute()), [], `${table} stays invisible to an invitee`);
    }
    assert.deepEqual((await as(boris, (trx) => planShares.sharedView(trx, project))).map((r) => r.item_key), ['permit'], 'a company invitee through its authorised member');
    assert.deepEqual(await as(anna, (trx) => planShares.sharedView(trx, project)), [], 'uninvited: nothing');
    await fails(as(petr, (trx) => sql`UPDATE trustwork.plan_share SET fields = ARRAY['scope','budget_range'] WHERE id = ${shareId}`.execute(trx)), '42501');
    await fails(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.plan_share SET fields = ARRAY['scope','budget_range'] WHERE id = ${shareId}`.execute(trx)), 'plans.share_immutable');
    await fails(as(carl, (trx) => planShares.revoke(trx, shareId, share.revision, { personId: carl, reason: 'not mine', at: new Date() }).then((r) => { if (!r) throw Object.assign(new Error('invisible'), { code: 'invisible' }); })), 'invisible');
    await as(petr, (trx) => planShares.revoke(trx, shareId, share.revision, { personId: petr, reason: 'Contractor chosen', at: new Date() }));
    assert.deepEqual(await as(carl, (trx) => planShares.sharedView(trx, project)), [], 'revocation takes effect immediately');
    await fails(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.plan_share SET revoked_at = NULL, revoked_by_person_id = NULL, revoked_reason = NULL WHERE id = ${shareId}`.execute(trx)), 'plans.share_immutable');
    const short = await as(petr, (trx) => planShares.insert(trx, { plan_id: planId, project_id: project, item_key: 'roofing', audience: 'invited', invitee_person_id: anna, invitee_company_id: null, fields: ['scope'], acceptance_kind: null, acceptance_id: null, preview_digest: 'a'.repeat(64), confirmed_by_person_id: petr, confirmed_at: new Date(), valid_until: new Date(Date.now() + 1500) }));
    assert.equal((await as(anna, (trx) => planShares.sharedView(trx, project))).length, 1);
    await untilDatabaseTimePasses(db.admin, short.valid_until as Date);
    assert.deepEqual(await as(anna, (trx) => planShares.sharedView(trx, project)), [], 'an expired share reveals nothing');
    const after = await as(petr, (trx) => planShares.insert(trx, { plan_id: planId, project_id: project, item_key: 'roofing', audience: 'after_acceptance', invitee_person_id: carl, invitee_company_id: null, fields: ['address', 'contact'], acceptance_kind: 'task_assignment', acceptance_id: 'assignment-demo-1', preview_digest: 'a'.repeat(64), confirmed_by_person_id: petr, confirmed_at: new Date(), valid_until: null }));
    const accepted = await as(carl, (trx) => planShares.sharedView(trx, project));
    assert.equal(accepted.length, 1);
    assert.deepEqual((accepted[0]?.address as { lines: string[] }).lines, ['100 Demo Street'], 'address only after acceptance');
    assert.equal(accepted[0]?.share_id, after.id);
  });

  await t.test('location and permits refuse restricted places; permits name released permit types; the diary is append-only', async () => {
    await fails(as(petr, (trx) => projectLocations.update(trx, project, 1, { address: null, region_code: 'UA-43', cadastral_ref: null, site_contact: null, site_access_notes: null, updated_by_person_id: petr })), 'plans.restricted_place');
    await fails(as(petr, (trx) => projectLocations.update(trx, project, 1, { address: { lines: ['x'], locality: 'y', region: null, postalCode: null, countryCode: 'RU' }, region_code: null, cadastral_ref: null, site_contact: null, site_access_notes: null, updated_by_person_id: petr })), 'plans.restricted_place');
    const base = { project_id: project, plan_item_key: 'permit', permit_type: 'permit.building', authority: 'Demo County Building Department', number: null, applied_at: '2027-01-10', issued_at: null, expires_at: null, inspection_results: [], evidence: [], status: 'applied' as const, created_by_person_id: petr };
    await fails(as(petr, (trx) => permitRecords.insert(trx, { ...base, jurisdiction: 'IR' })), 'plans.restricted_place');
    await fails(as(petr, (trx) => permitRecords.insert(trx, { ...base, jurisdiction: 'US-CA', permit_type: 'permit.unknown_kind' })), 'plans.unknown_term');
    await fails(as(petr, (trx) => permitRecords.insert(trx, { ...base, jurisdiction: 'US-CA', status: 'issued' })), '23514');
    const record = await as(petr, (trx) => permitRecords.insert(trx, { ...base, jurisdiction: 'US-CA' }));
    assert.equal(record.status, 'applied');
    assert.deepEqual(await as(carl, (trx) => permitRecords.list(trx, project)), [], 'permits are owner-private');
    await as(petr, (trx) => projectDiary.insert(trx, { project_id: project, author_person_id: petr, entry_date: '2027-03-02', body: 'PRIVATE diary: tear-off started', evidence: [], plan_item_key: 'roofing', visibility: 'owner_private' }));
    await as(petr, (trx) => projectDiary.insert(trx, { project_id: project, author_person_id: petr, entry_date: '2027-03-03', body: 'Crew on site for the participants', evidence: [], plan_item_key: null, visibility: 'participants' }));
    assert.equal((await as(petr, (trx) => projectDiary.list(trx, project))).length, 2);
    assert.deepEqual((await as(boris, (trx) => projectDiary.list(trx, project))).map((e) => e.visibility), ['participants'], 'participants see only participant entries');
    assert.deepEqual(await as(carl, (trx) => projectDiary.list(trx, project)), [], 'plan invitees never see the diary');
    await fails(as(boris, (trx) => projectDiary.insert(trx, { project_id: project, author_person_id: boris, entry_date: '2027-03-03', body: 'x', evidence: [], plan_item_key: null, visibility: 'participants' })), '42501');
    await fails(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.project_diary_entry SET body = 'rewritten'`.execute(trx)), 'audit.append_only');
  });

  await t.test('company members need company.deals.manage: an ended or permissionless member sees nothing', async () => {
    const { rows } = await withMaintenance(db.admin, (trx) => sql<{ id: string }>`SELECT id FROM trustwork.person WHERE id = ${seed.people.xenia}`.execute(trx));
    assert.equal(rows.length, 1);
    assert.equal(await as(seed.people.xenia, (trx) => plans.getByProject(trx, project)), undefined);
    const can = await as(carl, (trx) => sql<{ ok: boolean }>`SELECT trustwork.plan_project_can(${project}::uuid, 'read.owner_private') AS ok`.execute(trx));
    assert.equal(can.rows[0]?.ok, false);
    const unknownCapability = await as(petr, (trx) => sql<{ ok: boolean }>`SELECT trustwork.plan_project_can(${project}::uuid, 'transfer_ownership') AS ok`.execute(trx));
    assert.equal(unknownCapability.rows[0]?.ok, false, 'capabilities outside the plan vocabulary always deny');
  });
});
