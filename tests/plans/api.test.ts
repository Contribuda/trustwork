import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { INVITED_FORBIDDEN_KEYS, PLAN_EVENT_PAYLOAD_KEYS, type InvitedPlanView, type OwnerPlanView, type PlanContent, type PlanItem, type PlanVersion } from '../../packages/contracts/src/plans.js';
import { PlansService } from '../../apps/api/src/modules/plans/plans.service.js';
import { AllowListPlanMandates } from '../../apps/api/src/modules/plans/mandates.js';
import { FileLicensingFacets } from '../../apps/api/src/modules/plans/facets.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';

/**
 * PLAN-001 through the HTTP API (real database, runtime role, CSRF, idempotency): the "plan to people" journey from a
 * private project to an approved plan, a revised version with a recorded change, and items shared field by field with
 * invited parties; negative authorization for every outsider, concurrent editors and approvers, and agent proposals
 * that need a mandate.
 */
const h = await startHarness('plans_api');

const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const attachment = { evidenceArtifactId: 'artifact-demo-roof-plan', hash: 'a'.repeat(64), audience: 'shared' as const };
const ITEMS: PlanItem[] = [
  item({ key: 'shell', kind: 'phase', title: 'Building shell', stepTerms: ['stage.foundation'] }),
  item({ key: 'permit', kind: 'permit', title: 'Building permit', parentKey: 'shell', stepTerms: ['permit.building'], privateNotes: 'PRIVATE-permit-note', estimate: { kind: 'estimate_range', low: { minorUnits: '150000', currency: 'USD' }, high: { minorUnits: '400000', currency: 'USD' }, basis: 'owner_estimate', basisRef: null, asOf: '2026-10-31' } }),
  item({
    key: 'roofing', kind: 'task', title: 'Re-roof the house', parentKey: 'shell', description: 'Tear off and replace asphalt shingles', stepTerms: ['work.envelope.roofing', 'material.roofing.asphalt_shingles'],
    requiredSkills: ['trade.roofer'], quantity: { value: '2200', unit: 'ft2' }, estimate: { kind: 'estimate_range', low: { minorUnits: '1800000', currency: 'USD' }, high: { minorUnits: '2600000', currency: 'USD' }, basis: 'licensed_source', basisRef: 'dataset-demo-costs', asOf: '2026-10-31' },
    duration: { lowDays: 3, highDays: 6 }, window: { earliestStart: '2027-03-01', latestFinish: '2027-04-15' }, sources: [{ kind: 'own_quote', ref: 'quote-demo-own-1' }], attachments: [attachment], privateNotes: 'PRIVATE-budget-ceiling-21000',
  }),
  item({ key: 'go', kind: 'decision', title: 'Go ahead with the roof', stepTerms: ['decision.go_ahead'], decisionQuestion: 'Proceed with the lowest qualified bid?' }),
];
const CONTENT: PlanContent = {
  summary: 'Replace the roof of a 1970s single-storey house', assumptions: ['No structural repairs'], budget: { kind: 'estimate_range', low: { minorUnits: '2000000', currency: 'USD' }, high: { minorUnits: '3200000', currency: 'USD' }, basis: 'owner_estimate', basisRef: null, asOf: '2026-10-31' },
  timeline: { earliestStart: '2027-02-01', latestFinish: '2027-05-01' }, items: ITEMS,
  dependencies: [{ predecessorKey: 'permit', successorKey: 'roofing', type: 'fs', lagDays: 0 }, { predecessorKey: 'go', successorKey: 'roofing', type: 'fs', lagDays: 2 }],
};
const PRIVATE_STRINGS = ['PRIVATE-', 'quote-demo-own-1', '1800000', '2600000', '150000', 'Proceed with the lowest', '100 Demo Street', 'Gate code', '123-456-78-00', 'No structural repairs'];

function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
function noLeak(value: unknown, allow: readonly string[] = []): void {
  const json = JSON.stringify(value);
  for (const key of INVITED_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} reached an invitee`);
  for (const secret of PRIVATE_STRINGS.filter((s) => !allow.includes(s))) assert.ok(!json.includes(secret), `${secret} leaked: ${json.slice(0, 300)}`);
}

test('plans API: plan to people with versions, changes, shares and negative authorization', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const reference = await kernelReference.fromRepository();
  await withMaintenance(h.db.admin, (trx) => kernelSync.apply(trx, reference));
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const petr = await as('petr');
  const xenia = await as('xenia');
  const carl = await as('carl');
  const boris = await as('boris');
  const anna = await as('anna');
  const anonymous = h.client();

  const project = ok<{ id: string; revision: number }>(await petr.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name: 'Demo roof in Escondido', summary: null, leaderPersonId: null }), 201);
  const P = `/v1/projects/${project.id}/plan`;
  let view: OwnerPlanView;

  await t.test('creating a plan: owner side only, taxonomy terms checked, acyclic, one plan per project, idempotent', async () => {
    expectError(await anonymous.post(P, { timeZone: 'America/Los_Angeles', actor: { via: 'person' }, content: CONTENT }, { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await carl.post(P, { timeZone: 'America/Los_Angeles', actor: { via: 'person' }, content: CONTENT }), 404, 'access.not_found');
    expectError(await petr.post(P, { timeZone: 'America/Los_Angeles', actor: { via: 'agent', mandateId: 'mandate-demo-plan' }, content: CONTENT }), 403, 'access.mandate_scope');
    const unknown = await petr.post(P, { timeZone: 'America/Los_Angeles', actor: { via: 'person' }, content: { ...CONTENT, items: [item({ key: 'x', kind: 'task', stepTerms: ['work.made_up_step'] })], dependencies: [] } });
    expectError(unknown, 422, 'validation.schema');
    assert.deepEqual((unknown.body as { details: { codes: string[] } }).details.codes, ['work.made_up_step']);
    const cyclic = { ...CONTENT, dependencies: [...CONTENT.dependencies, { predecessorKey: 'roofing', successorKey: 'permit', type: 'fs', lagDays: 0 }] };
    expectError(await petr.post(P, { timeZone: 'America/Los_Angeles', actor: { via: 'person' }, content: cyclic }), 422, 'validation.schema');
    const body = { timeZone: 'America/Los_Angeles', actor: { via: 'person' }, content: CONTENT };
    const first = await petr.post(P, body, { idempotencyKey: 'plan-create-1' });
    view = ok<OwnerPlanView>(first, 201);
    assert.equal(view.projection, 'owner_private');
    assert.equal(view.draft?.version, 1);
    assert.equal(view.draft?.status, 'draft');
    assert.deepEqual(ok(await petr.post(P, body, { idempotencyKey: 'plan-create-1' }), 201), view, 'a retry replays the recorded result');
    expectError(await petr.post(P, { ...body, timeZone: 'UTC' }, { idempotencyKey: 'plan-create-1' }), 409, 'validation.idempotency_conflict');
    expectError(await petr.post(P, body), 409, 'validation.revision_conflict');
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.plan WHERE project_id = $1', [project.id])).rows[0].n, 1);
  });

  await t.test('reading: the owner sees everything; anonymous, unrelated, other companies and project participants without owner-private audience get not found', async () => {
    const own = ok<OwnerPlanView>(await petr.get(P));
    assert.equal(own.draft?.content.items.find((i) => i.key === 'roofing')?.privateNotes, 'PRIVATE-budget-ceiling-21000');
    expectError(await anonymous.get(P), 404, 'access.not_found');
    for (const outsider of [carl, boris, anna]) {
      expectError(await outsider.get(P), 404, 'access.not_found');
      expectError(await outsider.get(`${P}/versions/${own.draft?.id}`), 404, 'access.not_found');
      expectError(await outsider.get(`${P}/shares`), 404, 'access.not_found');
      expectError(await outsider.get(`${P}/shared`), 404, 'access.not_found');
    }
    ok(await petr.post(`/v1/projects/${project.id}/participants`, { party: { kind: 'company', id: seed.companies.supplier }, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', validUntil: null }), 201);
    expectError(await boris.get(P), 404, 'access.not_found');
    expectError(await boris.post(`${P}/versions/${own.draft?.id}/content`, { expectedRevision: 1, content: CONTENT, actor: { via: 'person' } }), 404, 'access.not_found');
  });

  await t.test('two editors save the same draft revision concurrently: one wins, the other gets a conflict', async () => {
    ok(await petr.post(`/v1/projects/${project.id}/participants`, { party: { kind: 'person', id: seed.people.xenia }, side: 'participant', capabilities: ['read.shared', 'read.owner_private', 'write.draft'], audience: 'owner_private', validUntil: null }), 201);
    const draftId = view.draft?.id as string;
    const edit = (summary: string) => ({ expectedRevision: 1, content: { ...CONTENT, summary }, actor: { via: 'person' } });
    const [a, b] = await Promise.all([petr.post(`${P}/versions/${draftId}/content`, edit('owner edit')), xenia.post(`${P}/versions/${draftId}/content`, edit('architect edit'))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
    const loser = a.status === 409 ? a : b;
    assert.equal((loser.body as { code: string }).code, 'validation.revision_conflict');
    const winner = ok<PlanVersion>(a.status === 200 ? a : b);
    assert.equal(winner.revision, 2);
    expectError(await xenia.post(`${P}/versions/${draftId}/content`, edit('stale')), 409, 'validation.revision_conflict');
    ok(await petr.post(`${P}/versions/${draftId}/content`, { expectedRevision: 2, content: CONTENT, actor: { via: 'person' } }));
  });

  let v1: PlanVersion;
  await t.test('proposing freezes the version; approval is the owner act with the digest seen, once', async () => {
    const draftId = view.draft?.id as string;
    v1 = ok<PlanVersion>(await xenia.post(`${P}/versions/${draftId}/propose`, { expectedRevision: 3, actor: { via: 'person' } }));
    assert.equal(v1.status, 'proposed');
    assert.ok(v1.digest);
    assert.equal(v1.proposed?.actor.personId, seed.people.xenia);
    expectError(await petr.post(`${P}/versions/${draftId}/content`, { expectedRevision: v1.revision, content: { ...CONTENT, summary: 'too late' }, actor: { via: 'person' } }), 409, 'commercial.version_immutable');
    expectError(await xenia.post(`${P}/versions/${draftId}/approve`, { expectedRevision: v1.revision, digest: v1.digest }), 403, 'access.forbidden');
    expectError(await carl.post(`${P}/versions/${draftId}/approve`, { expectedRevision: v1.revision, digest: v1.digest }), 404, 'access.not_found');
    expectError(await petr.post(`${P}/versions/${draftId}/approve`, { expectedRevision: v1.revision, digest: { algorithm: 'trustwork-digest-1', value: 'f'.repeat(64) } }), 409, 'commercial.digest_mismatch');
    expectError(await petr.post(`${P}/versions/${draftId}/approve`, { expectedRevision: v1.revision, digest: v1.digest, actor: { via: 'agent', mandateId: 'm' } }), 422, 'validation.unknown_field');
    const [x, y] = await Promise.all([
      petr.post(`${P}/versions/${draftId}/approve`, { expectedRevision: v1.revision, digest: v1.digest }),
      petr.post(`${P}/versions/${draftId}/approve`, { expectedRevision: v1.revision, digest: v1.digest }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], JSON.stringify([x.body, y.body]));
    v1 = ok<PlanVersion>(x.status === 200 ? x : y);
    assert.equal(v1.status, 'approved');
    assert.equal(v1.approved?.personId, seed.people.petr);
    const after = ok<OwnerPlanView>(await petr.get(P));
    assert.equal(after.plan.status, 'active');
    assert.equal(after.plan.currentVersionId, v1.id);
    assert.equal((await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.plan_version WHERE plan_id = $1 AND status = 'approved'", [after.plan.id])).rows[0].n, 1);
  });

  await t.test('a revised version with a recorded change: both versions kept, the change attributed for fair timing', async () => {
    const draft = ok<PlanVersion>(await petr.post(`${P}/versions`, { basedOnVersionId: null, actor: { via: 'person' } }), 201);
    assert.equal(draft.version, 2);
    assert.equal(draft.basedOnVersionId, v1.id);
    expectError(await petr.post(`${P}/versions`, { basedOnVersionId: null, actor: { via: 'person' } }), 409, 'validation.revision_conflict');
    const revised: PlanContent = { ...CONTENT, items: CONTENT.items.map((i) => (i.key === 'roofing' ? { ...i, duration: { lowDays: 5, highDays: 9 }, title: 'Re-roof the house with a skylight' } : i)) };
    const saved = ok<PlanVersion>(await petr.post(`${P}/versions/${draft.id}/content`, { expectedRevision: draft.revision, content: revised, actor: { via: 'person' } }));
    const proposed = ok<PlanVersion>(await petr.post(`${P}/versions/${draft.id}/propose`, { expectedRevision: saved.revision, actor: { via: 'person' } }));
    const change = ok<{ id: string; revision: number; status: string }>(await petr.post(`${P}/changes`, {
      fromVersionId: v1.id, toVersionId: draft.id, reason: 'Owner added a skylight', cause: 'owner_request', requestedBy: { kind: 'person', id: seed.people.petr }, accountable: { kind: 'person', id: seed.people.petr },
      agreementId: 'agreement-demo-roof', scheduleImpactDays: 3,
    }), 201);
    expectError(await xenia.post(`${P}/changes/${change.id}/decide`, { decision: 'approve', expectedRevision: 1, digest: proposed.digest }), 403, 'access.forbidden');
    expectError(await xenia.post(`${P}/changes/${change.id}/decide`, { decision: 'withdraw', expectedRevision: 1 }), 403, 'access.forbidden');
    const decided = ok<{ status: string }>(await petr.post(`${P}/changes/${change.id}/decide`, { decision: 'approve', expectedRevision: 1, digest: proposed.digest }));
    assert.equal(decided.status, 'approved');
    const owner = ok<OwnerPlanView>(await petr.get(P));
    assert.deepEqual(owner.versions.map((v) => [v.version, v.status]), [[1, 'superseded'], [2, 'approved']]);
    const original = ok<PlanVersion>(await petr.get(`${P}/versions/${v1.id}`));
    assert.equal(original.content.items.find((i) => i.key === 'roofing')?.title, 'Re-roof the house', 'the original version is retained unchanged');
    assert.deepEqual(original.digest, v1.digest);
    assert.equal(original.approved?.personId, seed.people.petr);
    assert.equal(owner.approved?.changeId, change.id);
    const timing = ok<{ items: { fromVersion: number; toVersion: number; attribution: string; excludedFromCounterpartyTiming: boolean }[] }>(await petr.get(`${P}/timing`));
    assert.deepEqual(timing.items.map((f) => [f.fromVersion, f.toVersion, f.attribution, f.excludedFromCounterpartyTiming]), [[1, 2, 'client', true]]);
    expectError(await carl.get(`${P}/timing`), 404, 'access.not_found');
    expectError(await carl.get(`${P}/changes`), 404, 'access.not_found');
  });

  await t.test('returning a proposal keeps it frozen and continues its content as the open draft', async () => {
    const draft = ok<PlanVersion>(await petr.post(`${P}/versions`, { basedOnVersionId: null, actor: { via: 'person' } }), 201);
    const proposed = ok<PlanVersion>(await petr.post(`${P}/versions/${draft.id}/propose`, { expectedRevision: draft.revision, actor: { via: 'person' } }));
    expectError(await xenia.post(`${P}/versions/${draft.id}/return`, { expectedRevision: proposed.revision, reason: 'not mine' }), 403, 'access.forbidden');
    const returned = ok<PlanVersion>(await petr.post(`${P}/versions/${draft.id}/return`, { expectedRevision: proposed.revision, reason: 'Ask for metal roofing options' }));
    assert.equal(returned.status, 'superseded');
    assert.equal(returned.superseded?.reason, 'returned');
    const owner = ok<OwnerPlanView>(await petr.get(P));
    assert.equal(owner.draft?.basedOnVersionId, draft.id);
    assert.deepEqual(owner.draft?.content, proposed.content);
    assert.equal(owner.approved?.version, 2, 'the baseline is untouched');
  });

  let carlShareId = '';
  await t.test('sharing one item with one invitee: preview, confirm the digest, exactly the listed fields', async () => {
    ok(await petr.post(`/v1/projects/${project.id}/location`, {
      address: { lines: ['100 Demo Street'], locality: 'Escondido', region: 'CA', postalCode: '92025', countryCode: 'US' }, regionCode: 'US-CA', cadastralRef: '123-456-78-00',
      siteContact: { name: 'Demo Owner', phone: '+1 555 0100', email: null }, siteAccessNotes: 'Gate code 4321', expectedRevision: null,
    }));
    expectError(await petr.post(`/v1/projects/${project.id}/location`, { address: null, regionCode: 'UA-43', cadastralRef: null, siteContact: null, siteAccessNotes: null, expectedRevision: 1 }), 422, 'validation.schema');
    const request = { itemKey: 'roofing', audience: 'invited', invitee: { kind: 'person', id: seed.people.carl }, fields: ['scope', 'trade', 'locality', 'budget_range'], acceptanceRef: null };
    expectError(await petr.post(`${P}/shares/preview`, { ...request, fields: ['scope', 'address'] }), 422, 'validation.schema');
    expectError(await carl.post(`${P}/shares/preview`, request), 404, 'access.not_found');
    const preview = ok<{ preview: Record<string, unknown>; previewDigest: { value: string }; notice: string }>(await petr.post(`${P}/shares/preview`, request));
    assert.equal(preview.notice, 'plans.share.forwarding_notice');
    noLeak(preview.preview, ['1800000', '2600000']);
    expectError(await petr.post(`${P}/shares`, { ...request, validUntil: null, previewDigest: { algorithm: 'trustwork-digest-1', value: 'e'.repeat(64) } }), 409, 'commercial.digest_mismatch');
    expectError(await xenia.post(`${P}/shares`, { ...request, validUntil: null, previewDigest: preview.previewDigest }), 403, 'access.forbidden');
    const share = ok<{ id: string; revision: number }>(await petr.post(`${P}/shares`, { ...request, validUntil: null, previewDigest: preview.previewDigest }), 201);
    carlShareId = share.id;
    const invited = ok<InvitedPlanView>(await carl.get(P));
    assert.equal(invited.projection, 'invited');
    assert.deepEqual(invited.items.map((i) => i.itemKey), ['roofing'], 'only the shared item, from the approved baseline');
    const [roof] = invited.items;
    assert.deepEqual(roof?.fields, ['scope', 'trade', 'locality', 'budget_range']);
    assert.equal(roof?.title, 'Re-roof the house with a skylight');
    assert.equal(roof?.regionCode, 'US-CA');
    assert.deepEqual(roof?.budgetRange, { kind: 'estimate_range', low: { minorUnits: '1800000', currency: 'USD' }, high: { minorUnits: '2600000', currency: 'USD' }, basis: 'licensed_source', basisRef: 'dataset-demo-costs', asOf: '2026-10-31' });
    for (const key of ['address', 'attachments', 'quantity', 'window', 'siteContact', 'siteAccessNotes']) assert.equal(roof && key in roof, false, `${key} not shared`);
    noLeak(invited, ['1800000', '2600000']);
    assert.deepEqual(ok(await carl.get(`${P}/shared`)), invited);
    for (const route of ['versions/' + v1.id, 'shares', 'changes', 'timing', 'items/states', 'licensing']) expectError(await carl.get(`${P}/${route}`), 404, 'access.not_found');
    expectError(await carl.get(`/v1/projects/${project.id}`), 404, 'access.not_found');
    expectError(await carl.get(`/v1/projects/${project.id}/location`), 404, 'access.not_found');
    expectError(await carl.get(`/v1/projects/${project.id}/diary`), 404, 'access.not_found');
    expectError(await anna.get(P), 404, 'access.not_found');
  });

  await t.test('a company invitee, address only after acceptance, revocation and expiry', async () => {
    const permitReq = { itemKey: 'permit', audience: 'invited', invitee: { kind: 'company', id: seed.companies.supplier }, fields: ['scope', 'schedule'], acceptanceRef: null };
    const pv = ok<{ previewDigest: { value: string } }>(await petr.post(`${P}/shares/preview`, permitReq));
    ok(await petr.post(`${P}/shares`, { ...permitReq, validUntil: null, previewDigest: pv.previewDigest }), 201);
    const borisView = ok<InvitedPlanView>(await boris.get(P));
    assert.deepEqual(borisView.items.map((i) => i.itemKey), ['permit']);
    noLeak(borisView);
    assert.deepEqual(ok<InvitedPlanView>(await carl.get(P)).items.map((i) => i.itemKey), ['roofing'], 'other invitees and their items stay invisible');
    expectError(await anna.get(P), 404, 'access.not_found');

    const acceptReq = { itemKey: 'roofing', audience: 'after_acceptance', invitee: { kind: 'person', id: seed.people.carl }, fields: ['address', 'contact'], acceptanceRef: { kind: 'task_assignment', id: 'assignment-demo-1' } };
    expectError(await petr.post(`${P}/shares/preview`, { ...acceptReq, acceptanceRef: null }), 422, 'validation.schema');
    const av = ok<{ previewDigest: { value: string } }>(await petr.post(`${P}/shares/preview`, acceptReq));
    const accepted = ok<{ id: string; revision: number }>(await petr.post(`${P}/shares`, { ...acceptReq, validUntil: null, previewDigest: av.previewDigest }), 201);
    const withAddress = ok<InvitedPlanView>(await carl.get(P));
    assert.equal(withAddress.items[0]?.address?.lines[0], '100 Demo Street');
    assert.equal(withAddress.items[0]?.siteAccessNotes, 'Gate code 4321');
    assert.deepEqual(withAddress.items[0]?.audiences, ['invited', 'after_acceptance']);
    noLeak(withAddress, ['1800000', '2600000', '100 Demo Street', 'Gate code']);

    const shares = ok<{ items: { id: string; revision: number }[] }>(await petr.get(`${P}/shares`));
    const carlInvited = shares.items.find((s) => s.id === carlShareId);
    expectError(await carl.post(`${P}/shares/${carlShareId}/revoke`, { expectedRevision: 1, reason: 'mine now' }), 404, 'access.not_found');
    expectError(await petr.post(`${P}/shares/${carlShareId}/revoke`, { expectedRevision: 9, reason: 'stale' }), 409, 'validation.revision_conflict');
    ok(await petr.post(`${P}/shares/${carlShareId}/revoke`, { expectedRevision: carlInvited?.revision, reason: 'Scope settled' }));
    expectError(await petr.post(`${P}/shares/${carlShareId}/revoke`, { expectedRevision: (carlInvited?.revision ?? 0) + 1, reason: 'again' }), 409, 'commercial.version_immutable');
    const afterRevoke = ok<InvitedPlanView>(await carl.get(P));
    assert.deepEqual(afterRevoke.items[0]?.fields, ['address', 'contact'], 'revocation takes effect at once');
    ok(await petr.post(`${P}/shares/${accepted.id}/revoke`, { expectedRevision: accepted.revision, reason: 'Task done' }));
    expectError(await carl.get(P), 404, 'access.not_found');

    const soonReq = { itemKey: 'roofing', audience: 'invited', invitee: { kind: 'person', id: seed.people.anna }, fields: ['scope'], acceptanceRef: null };
    const sv = ok<{ previewDigest: { value: string } }>(await petr.post(`${P}/shares/preview`, soonReq));
    expectError(await petr.post(`${P}/shares`, { ...soonReq, validUntil: new Date(Date.now() - 1000).toISOString(), previewDigest: sv.previewDigest }), 422, 'validation.schema');
    ok(await petr.post(`${P}/shares`, { ...soonReq, validUntil: new Date(Date.now() + 60_000).toISOString(), previewDigest: sv.previewDigest }), 201);
    assert.equal(ok<InvitedPlanView>(await anna.get(P)).items.length, 1);
    h.clock.advance(120_000);
    try {
      expectError(await anna.get(P), 404, 'access.not_found');
    } finally {
      h.clock.reset();
    }
  });

  await t.test('execution state beside the frozen version: one path per item; outsiders cannot touch it', async () => {
    const s = ok<{ revision: number; path: string }>(await petr.post(`${P}/items/roofing/state`, { status: 'accepted', path: 'task', link: null, actualStart: null, actualEnd: null, expectedRevision: null }));
    expectError(await petr.post(`${P}/items/roofing/state`, { status: 'requested', path: 'rfq', link: { kind: 'rfq', id: 'rfq-demo-1' }, actualStart: null, actualEnd: null, expectedRevision: s.revision }), 409, 'validation.revision_conflict');
    expectError(await petr.post(`${P}/items/roofing/state`, { status: 'requested', path: 'task', link: { kind: 'rfq', id: 'rfq-demo-1' }, actualStart: null, actualEnd: null, expectedRevision: s.revision }), 422, 'validation.schema');
    const requested = ok<{ status: string; revision: number }>(await petr.post(`${P}/items/roofing/state`, { status: 'requested', path: 'task', link: { kind: 'task_request', id: 'task-demo-1' }, actualStart: null, actualEnd: null, expectedRevision: s.revision }));
    assert.equal(requested.status, 'requested');
    expectError(await petr.post(`${P}/items/ghost/state`, { status: 'accepted', path: null, link: null, actualStart: null, actualEnd: null, expectedRevision: null }), 422, 'validation.schema');
    expectError(await carl.post(`${P}/items/roofing/state`, { status: 'in_progress', path: 'task', link: { kind: 'task_request', id: 'task-demo-1' }, actualStart: null, actualEnd: null, expectedRevision: requested.revision }), 404, 'access.not_found');
    const owner = ok<OwnerPlanView>(await petr.get(P));
    assert.equal(owner.approved?.content.items.find((i) => i.key === 'roofing')?.title, 'Re-roof the house with a skylight', 'linking a request never edits the frozen item');
  });

  await t.test('permits, diary and licensing notices are owner-private records', async () => {
    const permit = ok<{ id: string; status: string }>(await petr.post(`/v1/projects/${project.id}/permits`, {
      planItemKey: 'permit', jurisdiction: 'US-CA', permitType: 'permit.building', authority: 'Demo County Building Department', number: null, appliedAt: '2027-01-10', issuedAt: null, expiresAt: null,
      inspectionResults: [], evidence: [], status: 'applied',
    }), 201);
    assert.equal(permit.status, 'applied');
    expectError(await petr.post(`/v1/projects/${project.id}/permits`, { planItemKey: null, jurisdiction: 'KP', permitType: 'permit.building', authority: 'x', number: null, appliedAt: null, issuedAt: null, expiresAt: null, inspectionResults: [], evidence: [], status: 'planned' }), 422, 'validation.schema');
    expectError(await carl.get(`/v1/projects/${project.id}/permits`), 404, 'access.not_found');
    ok(await petr.post(`/v1/projects/${project.id}/diary`, { entryDate: '2027-03-02', text: 'PRIVATE-diary tear-off started', evidence: [], planItemKey: 'roofing', visibility: 'owner_private' }), 201);
    ok(await petr.post(`/v1/projects/${project.id}/diary`, { entryDate: '2027-03-03', text: 'Crew on site', evidence: [], planItemKey: null, visibility: 'participants' }), 201);
    assert.equal(ok<{ items: unknown[] }>(await petr.get(`/v1/projects/${project.id}/diary`)).items.length, 2);
    assert.deepEqual(ok<{ items: { text: string }[] }>(await boris.get(`/v1/projects/${project.id}/diary`)).items.map((e) => e.text), ['Crew on site'], 'project participants see participant entries only');
    const licensing = ok<{ facets: { pack: string | null; regionCode: string | null }; items: { itemKey: string; status: string; facts: { scope: string }[] }[] }>(await petr.get(`${P}/licensing`));
    assert.deepEqual(licensing.facets, { pack: 'US', regionCode: 'US-CA' });
    const roof = licensing.items.find((n) => n.itemKey === 'roofing');
    assert.equal(roof?.status, 'likely', 'roofers are licensed by state; the California pack names the board');
    assert.ok(roof?.facts.some((f) => f.scope === 'US-CA'));
  });

  await t.test('an agent drafts and proposes only under a mandate and never approves', async () => {
    const token = petr.sessionCookie as string;
    const resolved = await h.services().principals.resolve(token);
    assert.ok(resolved);
    const state: RequestState = { requestId: 'plans-agent-test', principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
    const mandates = new AllowListPlanMandates([{ personId: seed.people.petr, mandateId: 'mandate-demo-plan', projectId: project.id }]);
    const agentService = new PlansService(h.created.ctx!, h.services().principals, h.services().participations, mandates, new FileLicensingFacets());
    const owner = ok<OwnerPlanView>(await petr.get(P));
    const draft = owner.draft as PlanVersion;
    await assert.rejects(agentService.saveDraft(project.id, draft.id, { expectedRevision: draft.revision, content: CONTENT, actor: { via: 'agent', mandateId: 'mandate-other' } }, state), (e: { code?: string }) => e.code === 'access.mandate_scope');
    const saved = await agentService.saveDraft(project.id, draft.id, { expectedRevision: draft.revision, content: { ...CONTENT, summary: 'Drafted by the agent' }, actor: { via: 'agent', mandateId: 'mandate-demo-plan' } }, state);
    const proposed = await agentService.propose(project.id, draft.id, { expectedRevision: saved.revision, actor: { via: 'agent', mandateId: 'mandate-demo-plan' } }, state);
    assert.deepEqual(proposed.proposed?.actor, { via: 'agent', personId: seed.people.petr, mandateId: 'mandate-demo-plan' });
    assert.equal(proposed.status, 'proposed', 'a proposal, not an approval');
    assert.deepEqual(mandates.checks.map((c) => [c.mandateId, c.action]), [['mandate-other', 'prepare'], ['mandate-demo-plan', 'prepare'], ['mandate-demo-plan', 'prepare']]);
    expectError(await petr.post(`${P}/versions/${draft.id}/approve`, { expectedRevision: proposed.revision, digest: proposed.digest, actor: { via: 'agent', mandateId: 'mandate-demo-plan' } }), 422, 'validation.unknown_field');
    const audit = await h.db.admin.query("SELECT basis FROM trustwork.audit_event WHERE action = 'plan.version_proposed' AND object_id = $1", [draft.id]);
    assert.equal((audit.rows[0]?.basis as { mandateId: string }).mandateId, 'mandate-demo-plan');
  });

  await t.test('a plan never reaches public projections, other parties or notification payloads', async () => {
    const fresh = ok<{ revision: number }>(await petr.get(`/v1/projects/${project.id}`)) as unknown as { project: { revision: number } };
    ok(await petr.post(`/v1/projects/${project.id}/publish`, { projectId: project.id, publishedStory: 'We are replacing our roof', openNeedIds: [], expectedRevision: fresh.project.revision }));
    const pub = ok<{ projection: string; project: Record<string, unknown> }>(await anonymous.get(`/v1/projects/${project.id}`));
    assert.equal(pub.projection, 'public');
    assert.equal(Object.keys(pub.project).some((k) => /plan|budget/i.test(k)), false);
    for (const secret of [...PRIVATE_STRINGS, 'Re-roof', 'roofing']) assert.ok(!JSON.stringify(pub).includes(secret), `${secret} in the public projection`);
    expectError(await anonymous.get(P), 404, 'access.not_found');
    // Publishing the project shares nothing of the plan; revoked invitees see nothing.
    expectError(await carl.get(P), 404, 'access.not_found');
    const events = await h.db.admin.query<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM trustwork.outbox_event WHERE aggregate_kind = 'plan' ORDER BY id");
    assert.ok(events.rows.length >= 10, `plan events recorded (${events.rows.length})`);
    for (const event of events.rows) {
      for (const key of Object.keys(event.payload)) assert.ok((PLAN_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `${event.type}: ${key} is not an identifier`);
      for (const secret of [...PRIVATE_STRINGS, 'Re-roof', 'roofing', 'Escondido']) assert.ok(!JSON.stringify(event.payload).includes(secret), `${event.type}: ${secret} in an event`);
    }
  });
});
