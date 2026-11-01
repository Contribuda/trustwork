import { installSyntheticServingHub } from '../agent-modules/serving-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { taskAssignments, taskOffers, taskRecords, taskReviews } from '../../packages/data/src/repositories/tasks.js';
import { acceptanceEvents } from '../../packages/data/src/repositories/transactions.js';
import type { PlanContent, PlanItem, PlanVersion, OwnerPlanView } from '../../packages/contracts/src/plans.js';
import type { OfferorTaskOfferView, OwnerTaskRequestView, TaskAssignmentView, TaskOfferPayload } from '../../packages/contracts/src/tasks.js';
import { SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { principalFor } from '../data/helpers/seed.js';

/**
 * TASK-001 database layer under the real runtime role (FORCE RLS, no mocks). The fixture is built through the API;
 * every assertion then runs as a principal against the tables: sent offers are frozen for every role, competing
 * offerors and the owner see exactly what their policy allows, private halves never cross, staleness cannot be forged,
 * task agreements need the owner and the stored digests, an assignment repeats the agreement version and the plan item,
 * the site is readable only by the parties of a live assignment, execution decisions are human-only and reviews wait
 * for completion.
 */
const h = await startHarness('tasks_db');

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
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const PERSON = { via: 'person' as const };
const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };
const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const CONTENT: PlanContent = {
  summary: null, assumptions: [], budget: null, timeline: null, dependencies: [],
  items: [item({ key: 'deck', kind: 'task', title: 'Build a deck', description: 'Pressure-treated deck, 200 sq ft', stepTerms: ['work.envelope.roofing'], privateNotes: 'PRIVATE-deck-note' })],
};
const payload = (price: string): TaskOfferPayload => ({
  price: usd(price), start: '2027-03-01', durationDays: 3, exclusions: [], validUntil: '2027-06-01T00:00:00.000Z', note: null,
  milestones: [{ key: 'all', title: 'Deck built', planItemKey: 'deck', amount: usd(price), due: '2027-03-04' }],
});
function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

test('tasks database: frozen offers, isolation, private halves, staleness, agreements, assignments, site, records and reviews', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  await installSyntheticServingHub(h);
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, trx => trx.updateTable('company').set({ claim_status: 'verified' }).where('id', 'in', Object.values(seed.companies)).execute());
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const { petr, carl, boris, xenia } = seed.people;
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(h.pool, await principalFor(h.db.admin, personId), fn);
  const client = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const [petrApi, carlApi, borisApi] = [await client('petr'), await client('carl'), await client('boris')];
  const carlParty = { kind: 'person' as const, id: carl };
  const supplier = { kind: 'company' as const, id: seed.companies.supplier };

  /* ---------- Fixture through the API ---------- */
  const project = ok<{ id: string }>(await petrApi.post('/v1/projects', { owner: { kind: 'person', id: petr }, name: 'Demo deck', summary: null, leaderPersonId: null }), 201);
  ok(await petrApi.post(`/v1/projects/${project.id}/location`, { address: { lines: ['7 Demo Lane'], locality: 'Vista', region: 'CA', postalCode: '92081', countryCode: 'US' }, regionCode: 'US-CA', cadastralRef: null, siteContact: null, siteAccessNotes: 'Side gate', expectedRevision: null }));
  const P = `/v1/projects/${project.id}/plan`;
  const plan = ok<OwnerPlanView>(await petrApi.post(P, { timeZone: 'America/Los_Angeles', actor: PERSON, content: CONTENT }), 201);
  const proposed = ok<PlanVersion>(await petrApi.post(`${P}/versions/${plan.draft!.id}/propose`, { expectedRevision: plan.draft!.revision, actor: PERSON }));
  ok(await petrApi.post(`${P}/versions/${plan.draft!.id}/approve`, { expectedRevision: proposed.revision, digest: proposed.digest }));
  let request = ok<OwnerTaskRequestView>(await petrApi.post('/v1/task-requests', {
    source: { projectId: project.id, itemKey: 'deck' }, audience: 'invited', actor: PERSON, privateConstraint: { budgetCeiling: usd('900000'), ownerNotes: 'PRIVATE-owner' },
    terms: { title: 'Build a deck', fields: ['scope'], scopeNote: null, milestoneItemKeys: ['deck'], acceptanceCriteria: [], responseDeadline: '2027-02-15T17:00:00.000Z', currency: 'USD' },
  }), 201);
  const R = `/v1/task-requests/${request.request.id}`;
  request = ok<OwnerTaskRequestView>(await petrApi.post(`${R}/publish`, { version: 1, expectedRevision: request.request.revision, amendmentReason: null, actor: PERSON }));
  for (const party of [carlParty, supplier]) ok(await petrApi.post(`${R}/invitations`, { party, actor: PERSON }), 201);
  const offerOf = async (api: Client, offeror: typeof carlParty | typeof supplier, price: string, sendIt = true) => {
    const draft = ok<OfferorTaskOfferView>(await api.post('/v1/task-offers', { taskRequestId: request.request.id, requestVersionId: request.request.currentVersionId, offeror, payload: payload(price), privateConstraint: { floorPrice: usd('700000'), offerorNotes: 'PRIVATE-offeror' }, actor: PERSON }), 201);
    if (!sendIt) return draft.versions.at(-1)!;
    const v = draft.versions.at(-1)!;
    return ok<OfferorTaskOfferView>(await api.post(`/v1/task-offers/${v.id}/send`, { expectedRevision: v.revision, actor: PERSON })).versions.at(-1)!;
  };
  const carlSent = await offerOf(carlApi, carlParty, '800000');
  const borisDraft = await offerOf(borisApi, supplier, '820000', false);

  await t.test('sent offers are frozen for every role, the owner and maintenance included; drafts change only through the offeror', async () => {
    await fails(as(carl, (trx) => trx.updateTable('task_offer').set({ payload: JSON.stringify(payload('1')) }).where('id', '=', carlSent.id).execute()), 'commercial.version_frozen');
    await fails(as(carl, (trx) => trx.updateTable('task_offer').set({ valid_until: '2030-01-01T00:00:00Z' }).where('id', '=', carlSent.id).execute()), 'commercial.version_frozen');
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('task_offer').set({ digest: 'f'.repeat(64) }).where('id', '=', carlSent.id).execute()), 'commercial.version_frozen');
    await fails(withMaintenance(h.db.admin, (trx) => trx.deleteFrom('task_offer').where('id', '=', carlSent.id).execute()), 'commerce.retained');
    const blind = await as(petr, (trx) => trx.updateTable('task_offer').set({ status: 'withdrawn', withdrawn_reason: 'owner tries' }).where('id', '=', carlSent.id).executeTakeFirst());
    assert.equal(Number(blind.numUpdatedRows), 0, 'the owner updates no offer');
    await fails(as(carl, (trx) => sql`UPDATE trustwork.task_offer SET stale_reason = 'request_closed', stale_at = now() WHERE id = ${carlSent.id}`.execute(trx)), '42501');
    const version = request.versions[0]!;
    await fails(as(petr, (trx) => trx.updateTable('task_request_version').set({ payload: JSON.stringify({ title: 'changed' }) }).where('id', '=', version.id).execute()), 'commercial.version_frozen');
  });

  await t.test('isolation: offerors see only their own offers and private halves; the owner sees sent offers and no private half; outsiders nothing', async () => {
    const count = (personId: string, table: 'task_offer' | 'task_offer_private' | 'task_invitation' | 'task_request_private') => as(personId, async (trx) => {
      const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(`trustwork.${table}`)}`.execute(trx);
      return rows.rows[0]!.n;
    });
    assert.equal(await count(carl, 'task_offer'), 1, 'Carl: his own sent offer only');
    assert.equal(await count(boris, 'task_offer'), 1, 'Boris: his company draft only');
    assert.equal(await count(petr, 'task_offer'), 1, 'the owner: the sent offer, never the draft');
    assert.equal(await count(xenia, 'task_offer'), 0);
    assert.equal(await count(carl, 'task_offer_private'), 1);
    assert.equal(await count(boris, 'task_offer_private'), 1);
    assert.equal(await count(petr, 'task_offer_private'), 0, 'never the offeror private half');
    assert.equal(await count(petr, 'task_request_private'), 1);
    assert.equal(await count(carl, 'task_request_private'), 0, 'never the owner private half');
    assert.equal(await count(carl, 'task_invitation'), 1, 'the invitee sees its own invitation only');
    assert.equal(await count(petr, 'task_invitation'), 2);
    const seenByCarl = await as(carl, (trx) => taskOffers.listForRequest(trx, request.request.id));
    assert.deepEqual(seenByCarl.map((o) => o.id), [carlSent.id]);
    assert.equal((await as(xenia, (trx) => trx.selectFrom('task_request').select('id').execute())).length, 0, 'an invited request is invisible to outsiders');
    assert.equal((await as(xenia, (trx) => trx.selectFrom('task_request_version').select('id').execute())).length, 0);
  });

  await t.test('task agreements: only the owner, only stored digests, only sent offers on the current version; consultation agreements pin consultation requests', async () => {
    const versionRow = await as(petr, (trx) => trx.selectFrom('task_request_version').selectAll().where('id', '=', request.request.currentVersionId!).executeTakeFirstOrThrow());
    const offerRow = await as(petr, (trx) => trx.selectFrom('task_offer').selectAll().where('id', '=', carlSent.id).executeTakeFirstOrThrow());
    const row = (over: Record<string, unknown> = {}) => ({
      terms_kind: 'task' as const, buyer_person_id: petr, buyer_company_id: null, seller_person_id: carl, seller_company_id: null, rfq_id: null, quote_id: null, quote_version_id: null, rfq_version_id: null,
      offer_ref_id: offerRow.id, request_ref_id: versionRow.id, offer_version: offerRow.version, offer_digest: offerRow.digest as string, request_version: versionRow.version, request_digest: versionRow.digest as string,
      accepted_terms_digest: 'a'.repeat(64), status: 'accepted_by_buyer' as const, supersedes_id: null, created_by_person_id: petr, ...over,
    });
    await fails(as(carl, (trx) => trx.insertInto('agreement').values(row({ created_by_person_id: carl })).execute()), '42501');
    await fails(as(petr, (trx) => trx.insertInto('agreement').values(row({ offer_digest: 'b'.repeat(64) })).execute()), 'commercial.digest_mismatch');
    await fails(as(petr, (trx) => trx.insertInto('agreement').values(row({ seller_person_id: xenia })).execute()), 'commerce.not_authorised');
    await fails(as(petr, (trx) => trx.insertInto('agreement').values(row({ status: 'accepted_by_both' })).execute()), 'commerce.invalid_transition');
    // A consultation agreement (CONS-001) pins a consultation request of the client, never a task request version.
    await fails(as(petr, (trx) => trx.insertInto('agreement').values(row({ terms_kind: 'consultation' })).execute()), 'commerce.not_authorised');
    const borisRow = await as(boris, (trx) => trx.selectFrom('task_offer').selectAll().where('id', '=', borisDraft.id).executeTakeFirstOrThrow());
    await fails(as(petr, (trx) => trx.insertInto('agreement').values(row({ offer_ref_id: borisRow.id, seller_person_id: null, seller_company_id: seed.companies.supplier, offer_digest: 'c'.repeat(64) })).execute()), 'commercial.rfq_version_mismatch');
  });

  let assignment: TaskAssignmentView;
  await t.test('assignment: the database repeats the agreement version and the plan item; one per agreement; the site for the parties only', async () => {
    request = ok<OwnerTaskRequestView>(await petrApi.get(R));
    const current = request.versions.find((v) => v.id === request.request.currentVersionId)!;
    request = ok<OwnerTaskRequestView>(await petrApi.post(`${R}/acceptances`, { offer: { id: carlSent.id, version: carlSent.version, digest: carlSent.digest }, requestVersion: { id: current.id, version: current.version, digest: current.digest }, expectedRevision: request.request.revision, electronicRecords: CONSENT, actor: PERSON }), 201);
    const agreement = request.agreements[0]!;
    // Before the assignment exists nobody reads the site through the definer.
    const siteRows = async (personId: string, id: string) => as(personId, async (trx) => (await sql<{ address: unknown }>`SELECT * FROM trustwork.task_assignment_site(${id}::uuid)`.execute(trx)).rows);
    assignment = ok<TaskAssignmentView>(await carlApi.post(`/v1/task-agreements/${agreement.id}/confirm`, { expectedRevision: agreement.revision, acceptedTermsDigest: agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }), 201);
    const a = await as(carl, (trx) => taskAssignments.get(trx, assignment.assignment.id));
    assert.ok(a);
    assert.equal(a.plan_item_key, 'deck');
    assert.equal(a.agreement_id, agreement.id);
    assert.equal(a.agreement_digest, agreement.acceptedTermsDigest.value);
    assert.equal(a.plan_version_id, request.request.planItem.planVersionId);
    const copy = {
      task_request_id: a.task_request_id, task_offer_id: a.task_offer_id, agreement_id: a.agreement_id, agreement_digest: a.agreement_digest, offer_version: a.offer_version, offer_digest: a.offer_digest,
      request_version_id: a.request_version_id, request_version: a.request_version, request_digest: a.request_digest, project_id: a.project_id, plan_id: a.plan_id, plan_version_id: a.plan_version_id,
      plan_item_key: a.plan_item_key, owner_person_id: a.owner_person_id, assignee_person_id: a.assignee_person_id, assignee_company_id: a.assignee_company_id, milestones: a.milestones, created_by_person_id: carl,
    };
    await fails(as(carl, (trx) => taskAssignments.insert(trx, copy)), '23505');
    await fails(as(carl, (trx) => trx.updateTable('task_assignment').set({ status: 'accepted', completed_at: new Date() }).where('id', '=', a.id).execute()), 'commerce.invalid_transition');
    await fails(as(petr, (trx) => trx.updateTable('task_assignment').set({ status: 'accepted', completed_at: new Date() }).where('id', '=', a.id).execute()), 'commerce.invalid_transition');
    assert.equal((await siteRows(carl, a.id)).length, 1, 'the assignee reads the site');
    assert.equal((await siteRows(petr, a.id)).length, 1);
    assert.equal((await siteRows(boris, a.id)).length, 0, 'a competitor never');
    assert.equal((await siteRows(xenia, a.id)).length, 0);
    assert.equal((await as(boris, (trx) => trx.selectFrom('project_location').select('project_id').execute())).length, 0, 'the location table stays owner-private');
    const closed = await as(petr, (trx) => trx.selectFrom('task_request').select(['status', 'closed_reason']).where('id', '=', request.request.id).executeTakeFirstOrThrow());
    assert.deepEqual(closed, { status: 'closed', closed_reason: 'assigned' });
    const borisOffer = await as(boris, (trx) => taskOffers.get(trx, borisDraft.id));
    assert.equal(borisOffer?.stale_reason, 'request_closed', 'remaining offers are flagged when the task is assigned');
    await fails(as(boris, (trx) => trx.updateTable('task_offer').set({ status: 'sent', digest: 'd'.repeat(64), sent_at: new Date(), sent_by_person_id: boris, sent_via: 'person' }).where('id', '=', borisDraft.id).execute()), 'commerce.rfq_version_not_current');
    const events = await as(carl, (trx) => acceptanceEvents.listFor(trx, agreement.id));
    assert.deepEqual(events.map((e) => e.kind), ['buyer_accepts_terms', 'seller_accepts_order']);
    assert.ok(events.every((e) => e.accepted_terms_digest === agreement.acceptedTermsDigest.value && e.terms_kind === 'task'));
    await fails(as(petr, (trx) => trx.updateTable('agreement').set({ status: 'superseded', superseded_by: agreement.id }).where('id', '=', agreement.id).execute()), 'commerce.invalid_transition');
  });

  await t.test('execution records are append-only; decisions are human-only and the owner\'s; reviews wait for completion', async () => {
    const id = assignment.assignment.id;
    const base = { assignment_id: id, milestone_key: 'all', note: null, recorded_by_person_id: carl, mandate_id: null };
    await fails(as(petr, (trx) => taskReviews.insert(trx, { assignment_id: id, author_side: 'owner', author_person_id: petr, author_company_id: null, subject_person_id: carl, subject_company_id: null, written_by_person_id: petr, rating: 5, text: null })), 'tasks.review_not_allowed');
    await fails(as(carl, (trx) => taskRecords.insert(trx, { ...base, kind: 'delivery_claim', claim_id: null, evidence: [], by_person_id: carl, by_company_id: null, via: 'person' })), '23514');
    const claim = await as(carl, (trx) => taskRecords.insert(trx, { ...base, kind: 'delivery_claim', claim_id: null, evidence: [{ evidenceArtifactId: 'artifact-demo-deck', hash: 'e'.repeat(64), audience: 'shared' }], by_person_id: carl, by_company_id: null, via: 'person' }));
    await fails(as(carl, (trx) => taskRecords.insert(trx, { ...base, kind: 'acceptance', claim_id: claim.id, evidence: [], by_person_id: petr, by_company_id: null, via: 'person' })), 'commerce.not_authorised');
    await fails(as(petr, (trx) => taskRecords.insert(trx, { ...base, recorded_by_person_id: petr, kind: 'acceptance', claim_id: claim.id, evidence: [], by_person_id: petr, by_company_id: null, via: 'agent', mandate_id: 'mandate-demo' })), '23514');
    await fails(as(petr, (trx) => taskRecords.insert(trx, { ...base, recorded_by_person_id: petr, milestone_key: 'nope', kind: 'acceptance', claim_id: claim.id, evidence: [], by_person_id: petr, by_company_id: null, via: 'person' })), 'tasks.unknown_milestone');
    await fails(as(carl, (trx) => trx.updateTable('task_execution_record').set({ note: 'rewritten' }).where('id', '=', claim.id).execute()), '42501');
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('task_execution_record').set({ note: 'rewritten' }).where('id', '=', claim.id).execute()), 'audit.append_only');
    assert.equal((await as(boris, (trx) => taskRecords.listFor(trx, id))).length, 0, 'a competitor reads no record');
  });
});
