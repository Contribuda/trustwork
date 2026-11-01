import { HistoricalTaskFees } from '../../apps/api/src/modules/billing/fees/task-adapter.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import type { PlanContent, PlanItem, PlanVersion, OwnerPlanView } from '../../packages/contracts/src/plans.js';
import {
  TASK_BRIEF_FORBIDDEN_KEYS, TASK_EVENT_PAYLOAD_KEYS, TASK_OWNER_FORBIDDEN_KEYS, type OfferorTaskOfferView, type OfferorTaskRequestView, type OwnerTaskRequestView, type TaskAssignmentView,
  type TaskOfferPayload, type TaskRequestTerms,
} from '../../packages/contracts/src/tasks.js';
import { TasksService } from '../../apps/api/src/modules/tasks/tasks.service.js';
import { AllowListTaskMandates } from '../../apps/api/src/modules/tasks/mandates.js';
import { ConfiguredElectronicRecords } from '../../apps/api/src/modules/transactions/electronic-records.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';

/**
 * TASK-001 through the HTTP API (real database, runtime role, CSRF, idempotency): a homeowner's approved plan item
 * becomes a task request; the brief carries only the fields the owner chose; invited contractors (a person and a
 * company) draft and send immutable, digest-bound offers that competitors never see; an amendment flags earlier offers
 * stale; exactly one acceptance and one assignment survive concurrent attempts; the assignment names the plan item and
 * the agreement version and only then reveals the site; execution claims are decided by the owner in person; reviews
 * only for completed tasks; outbox and audit carry identifiers only; payment never changes any order.
 */
const h = await startHarness('tasks_api');

const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const PERSON = { via: 'person' as const };
const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };
const attachment = { evidenceArtifactId: 'artifact-demo-roof-plan', hash: 'a'.repeat(64), audience: 'shared' as const };
const evidence = { evidenceArtifactId: 'artifact-demo-tearoff-photo', hash: 'e'.repeat(64), audience: 'shared' as const };
const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const CONTENT: PlanContent = {
  summary: 'PRIVATE-summary replace the roof', assumptions: ['PRIVATE-assumption'], budget: null, timeline: null, dependencies: [],
  items: [
    item({ key: 'shell', kind: 'phase', title: 'Building shell', stepTerms: ['stage.foundation'] }),
    item({
      key: 'roofing', kind: 'task', parentKey: 'shell', title: 'Re-roof the house', description: 'Tear off and replace asphalt shingles', stepTerms: ['work.envelope.roofing'], requiredSkills: ['trade.roofer'],
      quantity: { value: '2200', unit: 'ft2' }, estimate: { kind: 'estimate_range', low: usd('1800000'), high: usd('2600000'), basis: 'licensed_source', basisRef: 'dataset-demo-costs', asOf: '2026-10-31' },
      duration: { lowDays: 3, highDays: 6 }, window: { earliestStart: '2027-03-01', latestFinish: '2027-04-15' }, sources: [{ kind: 'own_quote', ref: 'quote-demo-own-1' }], attachments: [attachment],
      privateNotes: 'PRIVATE-note-ceiling',
    }),
    item({ key: 'tear-off', kind: 'milestone', parentKey: 'roofing', title: 'Old roof removed' }),
    item({ key: 'shingles', kind: 'purchase', title: 'Shingles', stepTerms: ['material.roofing.asphalt_shingles'] }),
    item({ key: 'permit', kind: 'permit', title: 'Building permit', stepTerms: ['permit.building'] }),
    item({ key: 'gutters', kind: 'task', title: 'New gutters', description: 'Seamless aluminium gutters', stepTerms: ['work.envelope.roofing'] }),
  ],
};
const TERMS: TaskRequestTerms = {
  title: 'Re-roof a single-storey house', fields: ['scope', 'trade', 'locality', 'drawings', 'quantities', 'schedule'], scopeNote: 'Two layers to remove', milestoneItemKeys: ['roofing', 'tear-off'],
  acceptanceCriteria: ['Final inspection passed'], responseDeadline: '2027-02-15T17:00:00.000Z', currency: 'USD',
};
const REQUEST_PRIVATE = { budgetCeiling: usd('2100000'), ownerNotes: 'PRIVATE-owner-note' };
const OFFER_PRIVATE = { floorPrice: usd('1900000'), offerorNotes: 'PRIVATE-offeror-note' };
/** Strings that never reach an offeror before assignment (plan internals, the owner's private half, the site). */
const OWNER_SECRETS = ['PRIVATE-summary', 'PRIVATE-assumption', 'PRIVATE-note', 'PRIVATE-owner', 'quote-demo-own-1', '1800000', '2600000', '2100000', '100 Demo Street', 'Gate code', 'APN-DEMO', '555 0100'];
/** Strings that never reach the owner (the offeror's private half). */
const OFFEROR_SECRETS = ['PRIVATE-offeror', '1900000'];
function offerPayload(price = '2000000', over: Partial<TaskOfferPayload> = {}): TaskOfferPayload {
  const first = (BigInt(price) * 2n / 5n).toString();
  const rest = (BigInt(price) - BigInt(first)).toString();
  return {
    price: usd(price), start: '2027-03-01', durationDays: 5, exclusions: ['Permit fees'], validUntil: '2027-06-01T00:00:00.000Z', note: null,
    milestones: [
      { key: 'tear-off', title: 'Tear-off done', planItemKey: 'tear-off', amount: usd(first), due: '2027-03-02' },
      { key: 'final', title: 'Roof complete', planItemKey: 'roofing', amount: usd(rest), due: '2027-03-06' },
    ],
    ...over,
  };
}
function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
function noLeak(value: unknown, keys: readonly string[], secrets: readonly string[]): void {
  const json = JSON.stringify(value);
  for (const key of keys) assert.ok(!json.includes(`"${key}"`), `${key} leaked: ${json.slice(0, 400)}`);
  for (const secret of secrets) assert.ok(!json.includes(secret), `${secret} leaked: ${json.slice(0, 400)}`);
}
type Ref = { id: string; version: number; digest: { algorithm: 'trustwork-digest-1'; value: string } | null };
const refOf = (v: Ref) => ({ id: v.id, version: v.version, digest: v.digest! });

test('tasks API: plan item to task, isolated offers, one assignment, execution and reviews, with negative authorization and concurrency', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const [petr, carl, boris, xenia, anna] = [await as('petr'), await as('carl'), await as('boris'), await as('xenia'), await as('anna')];
  const anonymous = h.client();
  const carlParty = { kind: 'person' as const, id: seed.people.carl };
  const supplier = { kind: 'company' as const, id: seed.companies.supplier };
  const stateOf = async (client: Client, requestId: string): Promise<RequestState> => {
    const token = client.sessionCookie as string;
    const resolved = await h.services().principals.resolve(token);
    assert.ok(resolved);
    return { requestId, principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
  };

  /* ---------- A homeowner's approved plan ---------- */
  const project = ok<{ id: string }>(await petr.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name: 'Demo roof in Escondido', summary: null, leaderPersonId: null }), 201);
  const P = `/v1/projects/${project.id}/plan`;
  ok(await petr.post(`/v1/projects/${project.id}/location`, {
    address: { lines: ['100 Demo Street'], locality: 'Escondido', region: 'CA', postalCode: '92025', countryCode: 'US' }, regionCode: 'US-CA', cadastralRef: 'APN-DEMO-1',
    siteContact: { name: 'Demo Owner', phone: '+1 555 0100', email: null }, siteAccessNotes: 'Gate code 4321', expectedRevision: null,
  }));
  const created = ok<OwnerPlanView>(await petr.post(P, { timeZone: 'America/Los_Angeles', actor: PERSON, content: CONTENT }), 201);
  const proposed = ok<PlanVersion>(await petr.post(`${P}/versions/${created.draft!.id}/propose`, { expectedRevision: created.draft!.revision, actor: PERSON }));
  ok(await petr.post(`${P}/versions/${created.draft!.id}/approve`, { expectedRevision: proposed.revision, digest: proposed.digest }));
  const itemState = async (key: string) => (await h.db.admin.query<{ status: string; path: string | null; link_kind: string | null; link_id: string | null }>(
    'SELECT s.status, s.path, s.link_kind, s.link_id FROM trustwork.plan_item_state s JOIN trustwork.plan p ON p.id = s.plan_id WHERE p.project_id = $1 AND s.item_key = $2', [project.id, key])).rows[0];

  let request: OwnerTaskRequestView;
  const T = () => `/v1/task-requests/${request.request.id}`;
  const createBody = (over: Record<string, unknown> = {}) => ({ source: { projectId: project.id, itemKey: 'roofing' }, audience: 'invited', terms: TERMS, privateConstraint: REQUEST_PRIVATE, actor: PERSON, ...over });

  await t.test('cutting a task from a plan item: the owner only, works only, one path per item; the brief carries only the chosen fields', async () => {
    expectError(await anonymous.post('/v1/task-requests', createBody(), { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await carl.post('/v1/task-requests', createBody()), 404, 'access.not_found');
    expectError(await petr.post('/v1/task-requests', createBody({ actor: { via: 'agent', mandateId: 'mandate-demo-tasks' } })), 403, 'access.mandate_scope');
    for (const [key, reason] of [['shingles', 'plan_item_kind'], ['permit', 'plan_item_kind'], ['nowhere', 'item_not_in_baseline']] as const) {
      const r = await petr.post('/v1/task-requests', createBody({ source: { projectId: project.id, itemKey: key } }));
      expectError(r, 422, 'validation.schema');
      assert.equal((r.body as { details: { reason: string } }).details.reason, reason, key);
    }
    const sibling = await petr.post('/v1/task-requests', createBody({ terms: { ...TERMS, milestoneItemKeys: ['gutters'] } }));
    expectError(sibling, 422, 'validation.schema');
    assert.equal((sibling.body as { details: { reason: string } }).details.reason, 'milestone_item_unknown');
    const unknownField = await petr.post('/v1/task-requests', createBody({ terms: { ...TERMS, fields: ['scope', 'address'] } }));
    expectError(unknownField, 422, 'validation.schema');

    request = ok<OwnerTaskRequestView>(await petr.post('/v1/task-requests', createBody(), { idempotencyKey: 'task-create-1' }), 201);
    assert.equal(request.projection, 'owner_private');
    assert.deepEqual(request.request.planItem.itemKey, 'roofing');
    assert.equal(request.privateConstraint.budgetCeiling?.minorUnits, '2100000');
    const brief = request.versions[0]!.payload;
    assert.equal(request.versions[0]!.status, 'draft');
    assert.equal(brief.description, 'Tear off and replace asphalt shingles');
    assert.equal(brief.regionCode, 'US-CA');
    assert.equal(brief.timeZone, 'America/Los_Angeles');
    noLeak(brief, TASK_BRIEF_FORBIDDEN_KEYS, OWNER_SECRETS);
    assert.deepEqual(ok(await petr.post('/v1/task-requests', createBody(), { idempotencyKey: 'task-create-1' }), 201), request, 'a retry replays the recorded result');
    expectError(await petr.post('/v1/task-requests', createBody()), 409, 'validation.revision_conflict');
    assert.deepEqual(await itemState('roofing'), { status: 'accepted', path: 'task', link_kind: 'task_request', link_id: request.request.id }, 'the plan item records the path task with this request');
    // An RFQ for the same item is refused: an item takes one path only (PLAN-001, COM-001).
    const rfq = await petr.post('/v1/rfqs', {
      owner: { kind: 'person', id: seed.people.petr }, projectId: project.id, category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, actor: PERSON, source: { projectId: project.id, itemKey: 'roofing' },
      payload: { title: 'x', lines: [{ lineId: 'l1', kind: 'works', description: 'Roof', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false }], deliveryTerms: { location: { region: 'US-CA' }, window: null }, acceptanceCriteria: null, paymentTermsRequested: null, currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [] },
    });
    assert.ok(rfq.status === 409 || rfq.status === 422, JSON.stringify(rfq.body));
    // Inside a company everything starts as a requisition (ADR 012 decision 37).
    const companyProject = ok<{ id: string }>(await anna.post('/v1/projects', { owner: { kind: 'company', id: seed.companies.mixed }, name: 'Company office fit-out', summary: null, leaderPersonId: null }), 201);
    const company = await anna.post('/v1/task-requests', createBody({ source: { projectId: companyProject.id, itemKey: 'roofing' } }));
    expectError(company, 422, 'validation.schema');
    assert.equal((company.body as { details: { reason: string } }).details.reason, 'requisition_required');
  });

  await t.test('publishing: a digest-bound version; invitees read the published brief only; outsiders get not found', async () => {
    request = ok<OwnerTaskRequestView>(await petr.post(`${T()}/private`, { ...REQUEST_PRIVATE, budgetCeiling: usd('2100000'), expectedRevision: request.privateConstraint.revision }));
    expectError(await carl.post(`${T()}/publish`, { version: 1, expectedRevision: request.request.revision, amendmentReason: null, actor: PERSON }), 404, 'access.not_found');
    request = ok<OwnerTaskRequestView>(await petr.post(`${T()}/publish`, { version: 1, expectedRevision: request.request.revision, amendmentReason: null, actor: PERSON }));
    assert.equal(request.request.status, 'published');
    assert.equal(request.versions[0]!.status, 'published');
    assert.match(request.versions[0]!.digest!.value, /^[a-f0-9]{64}$/);
    assert.equal((await itemState('roofing'))?.status, 'requested');
    expectError(await petr.post(`${T()}/invitations`, { party: { kind: 'person', id: seed.people.petr }, actor: PERSON }), 422, 'validation.schema');
    expectError(await carl.post(`${T()}/invitations`, { party: carlParty, actor: PERSON }), 404, 'access.not_found');
    ok(await petr.post(`${T()}/invitations`, { party: carlParty, actor: PERSON }), 201);
    ok(await petr.post(`${T()}/invitations`, { party: supplier, actor: PERSON }), 201);
    expectError(await petr.post(`${T()}/invitations`, { party: carlParty, actor: PERSON }), 409, 'validation.revision_conflict');

    for (const client of [carl, boris]) {
      const view = ok<OfferorTaskRequestView>(await client.get(T()));
      assert.equal(view.projection, 'shared_party');
      assert.equal(view.versions.length, 1);
      assert.ok(view.invitation, 'the invitee sees its own invitation');
      noLeak(view, [...TASK_BRIEF_FORBIDDEN_KEYS, 'privateConstraint', 'agreements'], OWNER_SECRETS);
      assert.ok(!JSON.stringify(view).includes(client === carl ? seed.companies.supplier : seed.people.carl), 'never the other invitee');
    }
    expectError(await anonymous.get(T()), 401, 'auth.session_invalid');
    expectError(await xenia.get(T()), 404, 'access.not_found');
    expectError(await anna.get(T()), 404, 'access.not_found');
    const invitations = ok<{ invitations: { title: string }[] }>(await boris.get('/v1/task-invitations'));
    assert.deepEqual(invitations.invitations.map((i) => i.title), [TERMS.title]);
    assert.deepEqual(ok<{ invitations: unknown[] }>(await xenia.get('/v1/task-invitations')).invitations, []);
  });

  let carlOffer: OfferorTaskOfferView;
  let borisOffer: OfferorTaskOfferView;
  const offerBody = (offeror: { kind: 'person' | 'company'; id: string }, price: string, over: Record<string, unknown> = {}) => ({
    taskRequestId: request.request.id, requestVersionId: request.request.currentVersionId, offeror, payload: offerPayload(price), privateConstraint: OFFER_PRIVATE, actor: PERSON, ...over,
  });
  const latest = (view: OfferorTaskOfferView) => view.versions.at(-1)!;
  const send = async (client: Client, view: OfferorTaskOfferView) => ok<OfferorTaskOfferView>(await client.post(`/v1/task-offers/${latest(view).id}/send`, { expectedRevision: latest(view).revision, actor: PERSON }));

  await t.test('offers: invited parties only; drafts never reach the owner; sent offers are immutable; competitors never see each other', async () => {
    expectError(await xenia.post('/v1/task-offers', offerBody({ kind: 'person', id: seed.people.xenia }, '2000000')), 404, 'access.not_found');
    expectError(await carl.post('/v1/task-offers', offerBody(supplier, '2000000')), 403, 'access.forbidden');
    expectError(await petr.post('/v1/task-offers', offerBody({ kind: 'person', id: seed.people.petr }, '2000000')), 422, 'validation.schema');
    const stray = await carl.post('/v1/task-offers', offerBody(carlParty, '2000000', { payload: offerPayload('2000000', { milestones: [{ key: 'x', title: 'X', planItemKey: 'gutters', amount: usd('2000000'), due: '2027-03-03' }] }) }));
    expectError(stray, 422, 'validation.schema');
    assert.equal((stray.body as { details: { reason: string } }).details.reason, 'milestone_item_unknown');

    carlOffer = ok<OfferorTaskOfferView>(await carl.post('/v1/task-offers', offerBody(carlParty, '2000000')), 201);
    assert.equal(latest(carlOffer).status, 'draft');
    assert.equal(carlOffer.privateConstraint?.floorPrice?.minorUnits, '1900000');
    expectError(await carl.post('/v1/task-offers', offerBody(carlParty, '2000000')), 409, 'validation.revision_conflict');
    let owner = ok<OwnerTaskRequestView>(await petr.get(T()));
    assert.deepEqual(owner.offers, [], 'the owner never sees a draft');
    carlOffer = ok<OfferorTaskOfferView>(await carl.post(`/v1/task-offers/${latest(carlOffer).id}`, { expectedRevision: latest(carlOffer).revision, payload: offerPayload('1950000'), privateConstraint: null, actor: PERSON }));
    expectError(await carl.post(`/v1/task-offers/${latest(carlOffer).id}/send`, { expectedRevision: latest(carlOffer).revision, actor: { via: 'agent', mandateId: 'mandate-demo-send' } }), 403, 'access.mandate_scope');
    carlOffer = await send(carl, carlOffer);
    const sent = latest(carlOffer);
    assert.equal(sent.status, 'sent');
    assert.match(sent.digest!.value, /^[a-f0-9]{64}$/);
    assert.equal(sent.requestVersion.id, request.request.currentVersionId);
    const frozen = await carl.post(`/v1/task-offers/${sent.id}`, { expectedRevision: sent.revision, payload: offerPayload('100'), privateConstraint: null, actor: PERSON });
    expectError(frozen, 409, 'commercial.version_immutable');
    expectError(await carl.post(`/v1/task-offers/${sent.id}/send`, { expectedRevision: sent.revision, actor: PERSON }), 409, 'commercial.version_immutable');
    assert.deepEqual(ok<OfferorTaskOfferView>(await carl.get(`/v1/task-offers/${sent.id}`)).versions.at(-1), sent, 'a sent offer reads back exactly as sent');

    borisOffer = await send(boris, ok<OfferorTaskOfferView>(await boris.post('/v1/task-offers', offerBody(supplier, '2050000')), 201));
    // Competing offerors are isolated: not found for the other's desk, nothing of it in their own views.
    expectError(await carl.get(`/v1/task-offers/${latest(borisOffer).id}`), 404, 'access.not_found');
    expectError(await boris.get(`/v1/task-offers/${sent.id}`), 404, 'access.not_found');
    expectError(await carl.post(`/v1/task-offers/${latest(borisOffer).id}/withdraw`, { expectedRevision: 1, reason: 'not mine', actor: PERSON }), 404, 'access.not_found');
    for (const [client, other] of [[carl, borisOffer], [boris, carlOffer]] as const) {
      const views = [ok(await client.get(T())), ok(await client.get('/v1/task-offers')), ok(await client.get(`/v1/task-offers/${latest(client === carl ? carlOffer : borisOffer).id}`))];
      for (const v of views) {
        const json = JSON.stringify(v);
        assert.ok(!json.includes(latest(other).id) && !json.includes(latest(other).digest!.value), 'never the competitor offer');
        assert.ok(!json.includes(client === carl ? '2050000' : '1950000'), 'never the competitor price');
      }
    }
    expectError(await petr.get(`/v1/task-offers/${sent.id}`), 404, 'access.not_found');
    owner = ok<OwnerTaskRequestView>(await petr.get(T()));
    assert.deepEqual(owner.offers.map((o) => o.offeror.id).sort(), [seed.people.carl, seed.companies.supplier].sort());
    noLeak(owner.offers, TASK_OWNER_FORBIDDEN_KEYS, OFFEROR_SECRETS);
    noLeak(owner, ['sentBy', 'mandateId', 'floorPrice', 'offerorNotes'], OFFEROR_SECRETS);
  });

  await t.test('an amendment flags every earlier offer stale in the same transaction; a stale offer is never accepted', async () => {
    request = ok<OwnerTaskRequestView>(await petr.get(T()));
    const v1Ref = refOf(request.versions[0]!);
    request = ok<OwnerTaskRequestView>(await petr.post(`${T()}/draft`, { expectedRevision: request.request.revision, terms: { ...TERMS, acceptanceCriteria: ['Final inspection passed', 'Site cleaned'] }, actor: PERSON }));
    assert.equal(request.versions.at(-1)!.status, 'draft');
    expectError(await petr.post(`${T()}/publish`, { version: 2, expectedRevision: request.request.revision, amendmentReason: null, actor: PERSON }), 422, 'validation.schema');
    request = ok<OwnerTaskRequestView>(await petr.post(`${T()}/publish`, { version: 2, expectedRevision: request.request.revision, amendmentReason: 'Site cleaning added', actor: PERSON }));
    assert.equal(request.request.currentVersion, 2);
    assert.deepEqual(request.offers.map((o) => o.staleReason), ['request_amended', 'request_amended']);
    const v2Ref = refOf(request.versions.find((v) => v.version === 2)!);
    const stale = request.offers.find((o) => o.offeror.id === seed.people.carl)!;
    const accept = (offer: Ref, requestVersion: ReturnType<typeof refOf>) => petr.post(`${T()}/acceptances`, { offer: refOf(offer), requestVersion, expectedRevision: request.request.revision, electronicRecords: CONSENT, actor: PERSON });
    expectError(await accept(stale, v2Ref), 409, 'commercial.stale_version');
    expectError(await accept(stale, v1Ref), 409, 'commercial.rfq_version_mismatch');
    // Sending the stale draft is refused; a new version pinned to v2 answers the amendment.
    expectError(await carl.post('/v1/task-offers', offerBody(carlParty, '1950000', { requestVersionId: v1Ref.id })), 409, 'commercial.rfq_version_not_current');
    carlOffer = await send(carl, ok<OfferorTaskOfferView>(await carl.post('/v1/task-offers', offerBody(carlParty, '1950000', { requestVersionId: v2Ref.id })), 201));
    borisOffer = await send(boris, ok<OfferorTaskOfferView>(await boris.post('/v1/task-offers', offerBody(supplier, '2050000', { requestVersionId: v2Ref.id })), 201));
    assert.deepEqual(carlOffer.versions.map((v) => [v.version, v.status, v.staleReason]), [[1, 'superseded', 'request_amended'], [2, 'sent', null]]);
  });

  await t.test('acceptance: consent and digests required, agents bounded, exactly one live acceptance under concurrency; decline and withdrawal', async () => {
    request = ok<OwnerTaskRequestView>(await petr.get(T()));
    const current = refOf(request.versions.find((v) => v.id === request.request.currentVersionId)!);
    const body = (offer: OfferorTaskOfferView, over: Record<string, unknown> = {}) => ({ offer: refOf(latest(offer)), requestVersion: current, expectedRevision: request.request.revision, electronicRecords: CONSENT, actor: PERSON, ...over });
    expectError(await carl.post(`${T()}/acceptances`, body(carlOffer)), 404, 'access.not_found');
    expectError(await petr.post(`${T()}/acceptances`, body(carlOffer, { actor: { via: 'agent', mandateId: 'mandate-demo-accept' } })), 403, 'access.mandate_scope');
    const noConsent = await petr.post(`${T()}/acceptances`, body(carlOffer, { electronicRecords: null }));
    expectError(noConsent, 422, 'validation.schema');
    assert.equal((noConsent.body as { details: { reason: string } }).details.reason, 'electronic_records_consent_required');
    expectError(await petr.post(`${T()}/acceptances`, body(carlOffer, { offer: { ...refOf(latest(carlOffer)), digest: { algorithm: 'trustwork-digest-1', value: 'f'.repeat(64) } } })), 409, 'commercial.digest_mismatch');

    // Two acceptances of different offers at the same moment: exactly one commits.
    const race = await Promise.all([petr.post(`${T()}/acceptances`, body(carlOffer)), petr.post(`${T()}/acceptances`, body(borisOffer))]);
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409], JSON.stringify(race.map((r) => r.body)));
    const live = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.agreement a JOIN trustwork.task_request_version v ON v.id = a.request_ref_id WHERE v.task_request_id = $1 AND a.status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both')", [request.request.id]);
    assert.equal(live.rows[0]!.n, 1, 'one live agreement per task request');
    request = ok<OwnerTaskRequestView>(await petr.get(T()));
    const pending = request.agreements.find((a) => a.status === 'accepted_by_buyer')!;
    assert.equal(pending.termsKind, 'task');
    assert.deepEqual(pending.events.map((e) => e.kind), ['buyer_accepts_terms']);
    assert.equal(pending.events[0]!.acceptedTermsDigest.value, pending.acceptedTermsDigest.value);
    // While the acceptance is pending: no amendment, no cancellation, the accepted offer cannot be withdrawn.
    const amend = await petr.post(`${T()}/draft`, { expectedRevision: request.request.revision, terms: TERMS, actor: PERSON });
    const amended = ok<OwnerTaskRequestView>(amend);
    expectError(await petr.post(`${T()}/publish`, { version: 3, expectedRevision: amended.request.revision, amendmentReason: 'Change', actor: PERSON }), 409, 'validation.revision_conflict');
    expectError(await petr.post(`${T()}/cancel`, { expectedRevision: amended.request.revision, reason: 'Changed my mind', actor: PERSON }), 409, 'validation.revision_conflict');
    const winner = pending.seller.id === seed.people.carl ? carl : boris;
    const winnerOffer = winner === carl ? carlOffer : borisOffer;
    expectError(await winner.post(`/v1/task-offers/${latest(winnerOffer).id}/withdraw`, { expectedRevision: latest(winnerOffer).revision, reason: 'Busy', actor: PERSON }), 409, 'validation.revision_conflict');

    // The owner withdraws the pending acceptance, accepts the company's offer, the company declines; then Carl's.
    expectError(await winner.post(`/v1/task-agreements/${pending.id}/withdraw`, { expectedRevision: pending.revision, reason: 'not yours', actor: PERSON }), 404, 'access.not_found');
    request = ok<OwnerTaskRequestView>(await petr.post(`/v1/task-agreements/${pending.id}/withdraw`, { expectedRevision: pending.revision, reason: 'Comparing again', actor: PERSON }));
    assert.equal(request.agreements.find((a) => a.id === pending.id)?.status, 'withdrawn');
    borisOffer = ok<OfferorTaskOfferView>(await boris.get(`/v1/task-offers/${latest(borisOffer).id}`));
    request = ok<OwnerTaskRequestView>(await petr.post(`${T()}/acceptances`, body(borisOffer, { expectedRevision: request.request.revision })), 201);
    const toBoris = request.agreements.find((a) => a.status === 'accepted_by_buyer')!;
    expectError(await carl.post(`/v1/task-agreements/${toBoris.id}/confirm`, { expectedRevision: toBoris.revision, acceptedTermsDigest: toBoris.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }), 404, 'access.not_found');
    borisOffer = ok<OfferorTaskOfferView>(await boris.post(`/v1/task-agreements/${toBoris.id}/decline`, { expectedRevision: toBoris.revision, reason: 'Crew unavailable in March', actor: PERSON }));
    assert.equal(borisOffer.agreements[0]?.status, 'declined');
    assert.equal(latest(borisOffer).status, 'withdrawn', 'declining withdraws the offer');
    request = ok<OwnerTaskRequestView>(await petr.get(T()));
    carlOffer = ok<OfferorTaskOfferView>(await carl.get(`/v1/task-offers/${latest(carlOffer).id}`));
    request = ok<OwnerTaskRequestView>(await petr.post(`${T()}/acceptances`, body(carlOffer, { expectedRevision: request.request.revision })), 201);
  });

  let assignment: TaskAssignmentView;
  await t.test('confirmation: the offeror states the digest; exactly one assignment under concurrency; it names the plan item and the agreement version', async () => {
    carlOffer = ok<OfferorTaskOfferView>(await carl.get(`/v1/task-offers/${latest(carlOffer).id}`));
    const agreement = carlOffer.agreements.find((a) => a.status === 'accepted_by_buyer')!;
    noLeak(carlOffer, [...TASK_BRIEF_FORBIDDEN_KEYS, 'buyerPrivate'], OWNER_SECRETS);
    const confirm = (over: Record<string, unknown> = {}) => carl.post(`/v1/task-agreements/${agreement.id}/confirm`, { expectedRevision: agreement.revision, acceptedTermsDigest: agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON, ...over });
    expectError(await petr.post(`/v1/task-agreements/${agreement.id}/confirm`, { expectedRevision: agreement.revision, acceptedTermsDigest: agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }), 404, 'access.not_found');
    expectError(await confirm({ acceptedTermsDigest: { algorithm: 'trustwork-digest-1', value: '0'.repeat(64) } }), 409, 'commercial.digest_mismatch');
    expectError(await confirm({ actor: { via: 'agent', mandateId: 'mandate-demo-confirm' } }), 403, 'access.mandate_scope');
    const race = await Promise.all([confirm(), confirm()]);
    assert.equal(race.filter((r) => r.status === 201).length, 1, JSON.stringify(race.map((r) => r.body)));
    assert.ok(race.some((r) => r.status === 409 || r.status === 422));
    assignment = race.find((r) => r.status === 201)!.body as TaskAssignmentView;
    assert.equal((await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.task_assignment WHERE task_request_id = $1', [request.request.id])).rows[0]!.n, 1, 'exactly one assignment');

    const a = assignment.assignment;
    assert.deepEqual(a.planItem, request.request.planItem, 'the assignment names the plan item of its request');
    assert.equal(a.planItem.itemKey, 'roofing');
    assert.equal(a.agreement.id, agreement.id);
    assert.deepEqual(a.agreement.acceptedTermsDigest, agreement.acceptedTermsDigest, 'and the agreement version');
    assert.deepEqual(a.offer, refOf(latest(carlOffer)));
    assert.deepEqual(a.milestones, latest(carlOffer).payload.milestones);
    assert.equal(assignment.agreement.status, 'accepted_by_both');
    assert.deepEqual(assignment.agreement.events.map((e) => e.kind), ['buyer_accepts_terms', 'seller_accepts_order']);
    assert.ok(assignment.agreement.events.every((e) => e.acceptedTermsDigest.value === agreement.acceptedTermsDigest.value), 'both parties accepted the same digest');
    assert.deepEqual(assignment.agreement.obligations.map((o) => o.kind), ['perform', 'pay', 'perform', 'pay', 'accept']);
    // The site is revealed only now, and only to the parties.
    assert.equal(assignment.site?.address?.lines[0], '100 Demo Street');
    assert.equal(assignment.site?.siteAccessNotes, 'Gate code 4321');
    for (const outsider of [boris, xenia, anna]) expectError(await outsider.get(`/v1/task-assignments/${a.id}`), 404, 'access.not_found');
    noLeak(ok(await boris.get(T())), [], ['100 Demo Street', 'Gate code']);
    request = ok<OwnerTaskRequestView>(await petr.get(T()));
    assert.equal(request.request.status, 'closed', 'the assignment closes the request');
    assert.equal(request.assignment?.id, a.id);
    const owner = ok<TaskAssignmentView>(await petr.get(`/v1/task-assignments/${a.id}`));
    assert.equal(owner.side, 'owner');
    assert.deepEqual(ok<{ assignments: { id: string }[] }>(await carl.get('/v1/task-assignments')).assignments.map((x) => x.id), [a.id]);
    assert.deepEqual(ok<{ assignments: unknown[] }>(await boris.get('/v1/task-assignments')).assignments, []);
  });

  await t.test('execution: the assignee claims with evidence, the owner decides in person; reviews only for completed tasks', async () => {
    const A = `/v1/task-assignments/${assignment.assignment.id}`;
    const rev = () => assignment.assignment.revision;
    expectError(await petr.post(`${A}/reviews`, { rating: 5, text: 'Great' }), 422, 'validation.schema');
    expectError(await petr.post(`${A}/records`, { kind: 'delivery_claim', expectedRevision: rev(), milestoneKey: 'tear-off', evidence: [evidence], note: null, actor: PERSON }), 403, 'access.forbidden');
    expectError(await boris.post(`${A}/records`, { kind: 'delivery_claim', expectedRevision: rev(), milestoneKey: 'tear-off', evidence: [evidence], note: null, actor: PERSON }), 404, 'access.not_found');
    assignment = ok<TaskAssignmentView>(await carl.post(`${A}/records`, { kind: 'delivery_claim', expectedRevision: rev(), milestoneKey: 'tear-off', evidence: [evidence], note: 'Old shingles removed', actor: PERSON }), 201);
    assert.equal(assignment.assignment.status, 'in_progress');
    assert.deepEqual(assignment.milestoneStates.map((s) => s.state), ['asserted', 'open']);
    expectError(await carl.post(`${A}/records`, { kind: 'delivery_claim', expectedRevision: rev(), milestoneKey: 'tear-off', evidence: [evidence], note: null, actor: PERSON }), 409, 'validation.revision_conflict');
    expectError(await carl.post(`${A}/records`, { kind: 'acceptance', expectedRevision: rev(), milestoneKey: 'tear-off', claimId: assignment.milestoneStates[0]!.claimId, note: null }), 403, 'access.forbidden');
    const claim1 = assignment.milestoneStates[0]!.claimId!;
    assignment = ok<TaskAssignmentView>(await petr.post(`${A}/records`, { kind: 'rejection', expectedRevision: rev(), milestoneKey: 'tear-off', claimId: claim1, note: 'Debris left on site' }), 201);
    assert.equal(assignment.milestoneStates[0]!.state, 'open');
    assignment = ok<TaskAssignmentView>(await carl.post(`${A}/records`, { kind: 'delivery_claim', expectedRevision: rev(), milestoneKey: 'tear-off', evidence: [evidence], note: 'Cleaned', actor: PERSON }), 201);
    expectError(await petr.post(`${A}/records`, { kind: 'acceptance', expectedRevision: rev(), milestoneKey: 'tear-off', claimId: claim1, note: null }), 409, 'validation.revision_conflict');
    assignment = ok<TaskAssignmentView>(await petr.post(`${A}/records`, { kind: 'acceptance', expectedRevision: rev(), milestoneKey: 'tear-off', claimId: assignment.milestoneStates[0]!.claimId, note: null }), 201);
    assignment = ok<TaskAssignmentView>(await carl.post(`${A}/records`, { kind: 'delivery_claim', expectedRevision: rev(), milestoneKey: 'final', evidence: [evidence], note: null, actor: PERSON }), 201);
    assert.equal(assignment.assignment.status, 'delivered');
    expectError(await carl.post(`${A}/reviews`, { rating: 4, text: null }), 422, 'validation.schema');
    assignment = ok<TaskAssignmentView>(await petr.post(`${A}/records`, { kind: 'acceptance', expectedRevision: rev(), milestoneKey: 'final', claimId: assignment.milestoneStates[1]!.claimId, note: 'Inspection passed' }), 201);
    assert.equal(assignment.assignment.status, 'accepted');
    assert.ok(assignment.assignment.completedAt);
    assert.equal((await itemState('roofing'))?.status, 'done', 'the plan item is done when the task completes');
    assignment = ok<TaskAssignmentView>(await petr.post(`${A}/reviews`, { rating: 5, text: 'Clean and on time' }), 201);
    assignment = ok<TaskAssignmentView>(await carl.post(`${A}/reviews`, { rating: 4, text: 'Clear brief' }), 201);
    assert.deepEqual(assignment.reviews.map((r) => [r.authorSide, r.rating]), [['owner', 5], ['assignee', 4]]);
    expectError(await petr.post(`${A}/reviews`, { rating: 1, text: null }), 409, 'validation.revision_conflict');
    expectError(await xenia.post(`${A}/reviews`, { rating: 1, text: null }), 404, 'access.not_found');
    expectError(await carl.post(`${A}/records`, { kind: 'delivery_claim', expectedRevision: rev(), milestoneKey: 'final', evidence: [evidence], note: null, actor: PERSON }), 422, 'validation.schema');
  });

  await t.test('agents act only under mandates and never beyond the private ceiling or floor (fake mandate store)', async () => {
    const mandates = new AllowListTaskMandates([
      { personId: seed.people.petr, mandateId: 'mandate-demo-owner', action: 'prepare' }, { personId: seed.people.petr, mandateId: 'mandate-demo-owner', action: 'publish' },
      { personId: seed.people.petr, mandateId: 'mandate-demo-owner', action: 'communicate' }, { personId: seed.people.petr, mandateId: 'mandate-demo-owner', action: 'place_order', ceiling: usd('5000000') },
      { personId: seed.people.carl, mandateId: 'mandate-demo-carl', action: 'prepare' }, { personId: seed.people.carl, mandateId: 'mandate-demo-carl', action: 'send_quote', ceiling: usd('5000000') },
    ]);
    const service = new TasksService(h.created.ctx!, h.services().principals, mandates, new ConfiguredElectronicRecords(), new HistoricalTaskFees());
    const owner = { via: 'agent' as const, mandateId: 'mandate-demo-owner' };
    let n = 0;
    const ps = async () => stateOf(petr, `req-agent-${++n}`);
    const cs = async () => stateOf(carl, `req-agent-${++n}`);
    let view = await service.createRequest({ source: { projectId: project.id, itemKey: 'gutters' }, audience: 'invited', terms: { ...TERMS, title: 'Gutters', milestoneItemKeys: ['gutters'] }, privateConstraint: { budgetCeiling: usd('300000'), ownerNotes: null }, actor: owner }, await ps());
    view = await service.publish(view.request.id, { version: 1, expectedRevision: view.request.revision, amendmentReason: null, actor: owner }, await ps());
    await service.invite(view.request.id, { party: carlParty, actor: owner }, await ps());
    const payload = (price: string): TaskOfferPayload => ({ price: usd(price), start: '2027-03-01', durationDays: 2, exclusions: [], validUntil: '2027-06-01T00:00:00.000Z', note: null, milestones: [{ key: 'all', title: 'Gutters installed', planItemKey: 'gutters', amount: usd(price), due: '2027-03-03' }] });
    let offer = await service.createOffer({ taskRequestId: view.request.id, requestVersionId: view.request.currentVersionId!, offeror: carlParty, payload: payload('250000'), privateConstraint: { floorPrice: usd('260000'), offerorNotes: null }, actor: { via: 'agent', mandateId: 'mandate-demo-carl' } }, await cs());
    await assert.rejects(service.sendOffer(latest(offer).id, { expectedRevision: latest(offer).revision, actor: { via: 'agent', mandateId: 'mandate-demo-carl' } }, await cs()), (e: { code?: string; details?: { reason?: string } }) => e.code === 'access.mandate_scope' && e.details?.reason === 'outside_private_constraints');
    offer = await service.saveOffer(latest(offer).id, { expectedRevision: latest(offer).revision, payload: payload('400000'), privateConstraint: null, actor: { via: 'agent', mandateId: 'mandate-demo-carl' } }, await cs());
    offer = await service.sendOffer(latest(offer).id, { expectedRevision: latest(offer).revision, actor: { via: 'agent', mandateId: 'mandate-demo-carl' } }, await cs());
    view = await service.getRequest(view.request.id, await ps()) as OwnerTaskRequestView;
    const current = refOf(view.versions.find((v) => v.id === view.request.currentVersionId)!);
    await assert.rejects(service.acceptOffer(view.request.id, { offer: refOf(latest(offer)), requestVersion: current, expectedRevision: view.request.revision, electronicRecords: CONSENT, actor: owner }, 'agent-accept-1', await ps()),
      (e: { code?: string; details?: { reason?: string } }) => e.code === 'access.mandate_scope' && e.details?.reason === 'outside_private_constraints', 'the owner agent never accepts above the private ceiling');
    await assert.rejects(service.confirmAgreement('00000000-0000-4000-8000-000000000001', { expectedRevision: 1, acceptedTermsDigest: { algorithm: 'trustwork-digest-1', value: 'a'.repeat(64) }, electronicRecords: CONSENT, actor: { via: 'agent', mandateId: 'mandate-demo-carl' } }, 'agent-confirm-1', await cs()), (e: { code?: string }) => e.code === 'access.not_found');
    assert.ok(mandates.checks.some((c) => c.action === 'place_order' && c.amount?.minorUnits === '400000'), 'money actions pass the amount to the mandate check');
    assert.ok(!JSON.stringify(mandates.checks).includes('300000') && !JSON.stringify(mandates.checks).includes('260000'), 'private limits never enter the mandate check');
    const audits = await h.db.admin.query<{ basis: unknown }>("SELECT basis FROM trustwork.audit_event WHERE action LIKE 'task.%'");
    for (const row of audits.rows) noLeak(row.basis, ['floorPrice', 'budgetCeiling', 'ownerNotes', 'offerorNotes'], ['PRIVATE-', '300000', '260000', '2100000', '1900000']);
  });

  await t.test('outbox events of the tasks module carry identifiers only; nothing private', async () => {
    const rows = await h.db.admin.query<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM trustwork.outbox_event WHERE type LIKE 'task.%'");
    assert.ok(rows.rows.length >= 15);
    for (const row of rows.rows) {
      for (const key of Object.keys(row.payload)) assert.ok((TASK_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `${row.type}: ${key} is not an identifier`);
      noLeak(row.payload, [], [...OWNER_SECRETS, ...OFFEROR_SECRETS, 'Re-roof', 'Gutters']);
    }
  });

  await t.test('payment never buys order or invitations: the open board, invitations and offers are identical with and without entitlements', async () => {
    const anotherProject = ok<{ id: string }>(await petr.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name: 'Demo fence', summary: null, leaderPersonId: null }), 201);
    const P2 = `/v1/projects/${anotherProject.id}/plan`;
    const fence: PlanContent = { summary: null, assumptions: [], budget: null, timeline: null, dependencies: [], items: [item({ key: 'fence', kind: 'task', title: 'Build a fence', stepTerms: ['work.envelope.roofing'] })] };
    const p2 = ok<OwnerPlanView>(await petr.post(P2, { timeZone: 'America/Los_Angeles', actor: PERSON, content: fence }), 201);
    const p2v = ok<PlanVersion>(await petr.post(`${P2}/versions/${p2.draft!.id}/propose`, { expectedRevision: p2.draft!.revision, actor: PERSON }));
    ok(await petr.post(`${P2}/versions/${p2.draft!.id}/approve`, { expectedRevision: p2v.revision, digest: p2v.digest }));
    let board = ok<OwnerTaskRequestView>(await petr.post('/v1/task-requests', { source: { projectId: anotherProject.id, itemKey: 'fence' }, audience: 'open', terms: { ...TERMS, title: 'Fence on the open board', fields: ['trade', 'locality'], milestoneItemKeys: ['fence'] }, privateConstraint: null, actor: PERSON }), 201);
    board = ok<OwnerTaskRequestView>(await petr.post(`/v1/task-requests/${board.request.id}/publish`, { version: 1, expectedRevision: board.request.revision, amendmentReason: null, actor: PERSON }));
    const fencePayload = (price: string): TaskOfferPayload => ({ price: usd(price), start: '2027-03-01', durationDays: 2, exclusions: [], validUntil: '2027-06-01T00:00:00.000Z', note: null, milestones: [{ key: 'all', title: 'Fence', planItemKey: 'fence', amount: usd(price), due: '2027-03-03' }] });
    for (const [client, offeror, price] of [[carl, carlParty, '500000'], [boris, supplier, '510000']] as const) {
      const draft = ok<OfferorTaskOfferView>(await client.post('/v1/task-offers', { taskRequestId: board.request.id, requestVersionId: board.request.currentVersionId, offeror, payload: fencePayload(price), privateConstraint: null, actor: PERSON }), 201);
      await send(client, draft);
    }
    const snapshot = async () => ({
      carlBoard: ok(await carl.get('/v1/task-requests/open')), borisBoard: ok(await boris.get('/v1/task-requests/open')), xeniaBoard: ok(await xenia.get('/v1/task-requests/open')),
      petrBoard: ok(await petr.get('/v1/task-requests/open')), invitations: ok(await carl.get('/v1/task-invitations')), offers: ok<OwnerTaskRequestView>(await petr.get(`/v1/task-requests/${board.request.id}`)).offers,
    });
    const before = await snapshot();
    assert.deepEqual((before.xeniaBoard as { requests: { title: string }[] }).requests.map((r) => r.title), ['Fence on the open board'], 'an open request reaches every signed-in person');
    assert.deepEqual((before.petrBoard as { requests: unknown[] }).requests, [], 'never the own request');
    noLeak(before.xeniaBoard, TASK_BRIEF_FORBIDDEN_KEYS, OWNER_SECRETS);
    expectError(await anonymous.get('/v1/task-requests/open'), 401, 'auth.session_invalid');
    await withMaintenance(h.db.admin, async (trx) => {
      const hub = '00000000-0000-4000-8000-00000000c003';
      const offer = await trx.insertInto('offer').values({ hub_id: hub, code: 'premium_task_marketplace', name: 'Premium', kind: 'plan', status: 'active', created_by: seed.people.anna }).returning('id').executeTakeFirstOrThrow();
      for (const owner of [{ owner_company_id: seed.companies.supplier, owner_person_id: null }, { owner_company_id: null, owner_person_id: seed.people.carl }, { owner_company_id: null, owner_person_id: seed.people.petr }]) {
        const account = await trx.insertInto('billing_account').values({ hub_id: hub, ...owner, currency: 'USD', created_by: seed.people.anna }).returning('id').executeTakeFirstOrThrow();
        for (const source of ['sponsorship', 'credit'] as const) {
          await trx.insertInto('entitlement').values({ billing_account_id: account.id, offer_id: offer.id, module_code: 'task_marketplace', limits: JSON.stringify({ priority: 1, boost: 10 }), valid_from: new Date('2026-10-01T00:00:00Z'), source }).execute();
        }
      }
    });
    assert.deepEqual(await snapshot(), before, 'identical results and order with and without payment');
  });

  await t.test('COM-002 agreement routes never return task agreements; the tasks desk is the only way in', async () => {
    const taskAgreementId = assignment.agreement.id;
    expectError(await petr.get(`/v1/agreements/${taskAgreementId}`), 404, 'access.not_found');
    expectError(await carl.get(`/v1/agreements/${taskAgreementId}`), 404, 'access.not_found');
    const listed = ok<{ agreements: { id: string }[] }>(await petr.get('/v1/agreements'));
    assert.ok(!listed.agreements.some((a) => a.id === taskAgreementId));
    expectError(await carl.post(`/v1/agreements/${taskAgreementId}/accept`, { expectedRevision: 1, acceptedTermsDigest: assignment.agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }), 404, 'access.not_found');
  });
});
