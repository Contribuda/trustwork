import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import type { PlanContent, PlanItem, PlanVersion, OwnerPlanView } from '../../packages/contracts/src/plans.js';
import {
  CONSULTATION_EVENT_PAYLOAD_KEYS, CONSULTATION_EXPERT_FORBIDDEN_KEYS, type BookingView, type ConsultationOffering, type ConsultationOfferingTerms, type ConsultationRequestTerms,
  type ExpertRequestView, type RequesterRequestView,
} from '../../packages/contracts/src/consultations.js';
import { ConsultationsService } from '../../apps/api/src/modules/consultations/consultations.service.js';
import { AllowListConsultationMandates } from '../../apps/api/src/modules/consultations/mandates.js';
import { FixedRateCommission, NoPublishedCommission, ScreeningCommitmentGate, type ConsultationScreeningGate } from '../../apps/api/src/modules/consultations/ports.js';
import { ConfiguredElectronicRecords } from '../../apps/api/src/modules/transactions/electronic-records.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { ApiError, LocalApiError } from '../../apps/api/src/common/errors.js';
import type { AppContext } from '../../apps/api/src/modules/identity/context.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { principalFor } from '../data/helpers/seed.js';
import { screenClear } from './helpers.js';
import { clearHold, holdPerson, setBaselineStale } from '../screening-gates/helpers.js';

/**
 * CONS-001 through the HTTP API (real database, runtime role, CSRF, idempotency, the real screening gate): a
 * homeowner's plan item becomes a consultation request to an expert's offering; the brief carries only the chosen
 * fields and never the budget ceiling; the expert proposes frozen, digest-bound terms with the full price and the hub's
 * commission; the client books by id and digest; capacity is serialized against the window under concurrency; a site
 * visit's address reaches the expert only after booking; licence-requiring advice needs a recorded licence (labelled
 * self-declared); deliverables are EXE-001 claims decided by the client in person, visible to the parties until the
 * author publishes; completed consultations count for the expert's reputation; mentoring is double opt-in. Every
 * person, company, licence and price is synthetic.
 */
const h = await startHarness('consultations_api');

const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const PERSON = { via: 'person' as const };
const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };
const attachment = { evidenceArtifactId: 'artifact-demo-framing-plan', hash: 'a'.repeat(64), audience: 'shared' as const };
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const CONTENT: PlanContent = {
  summary: 'PRIVATE-summary build a small house', assumptions: ['PRIVATE-assumption'], budget: null, timeline: null, dependencies: [],
  items: [
    item({
      key: 'framing-review', kind: 'consultation', title: 'Review the framing drawings', description: 'Check the beam spans on sheets A-101 to A-104', stepTerms: ['work.design.structural'],
      requiredSkills: ['trade.structural_engineer'], quantity: { value: '2000', unit: 'ft2' },
      estimate: { kind: 'estimate_range', low: usd('40000'), high: usd('90000'), basis: 'licensed_source', basisRef: 'dataset-demo-costs', asOf: '2026-10-31' },
      sources: [{ kind: 'own_quote', ref: 'quote-demo-own-9' }], attachments: [attachment], privateNotes: 'PRIVATE-note-ceiling',
    }),
    item({ key: 'footing-check', kind: 'inspection', title: 'Check the footings before the pour', stepTerms: ['inspection.footing'] }),
    item({ key: 'soil-risk', kind: 'risk', title: 'Expansive soil', riskLevel: 'medium' }),
  ],
};
const offeringTerms = (over: Partial<ConsultationOfferingTerms> = {}): ConsultationOfferingTerms => ({
  kind: 'session', modes: ['video', 'phone'], topics: ['work.design.structural'], regions: ['US-CA'], languages: ['en', 'es'], durationMinutes: 60, deliverableKind: 'written_advice',
  pricing: 'hourly', cancellation: { freeUntilHours: 24, lateShareBps: 5000, noShowShareBps: 10000 }, licence: { required: false, credentialId: null }, recordingOffered: true, ...over,
});
const requestTerms = (over: Partial<ConsultationRequestTerms> = {}): ConsultationRequestTerms => ({
  kind: 'session', question: 'Are the beam spans right for a snow load of 20 psf?', fields: ['scope', 'trade', 'locality', 'drawings'], preferredModes: ['video'],
  preferredTimes: [], sharedMaterials: [attachment], licenceRequired: false, languages: ['en'], ...over,
});
const REQUEST_PRIVATE = { budgetCeiling: usd('2000000'), requesterNotes: 'PRIVATE-requester-note' };
/** Strings that never reach the expert before a booking (plan internals, the requester's private half, the site). */
const REQUESTER_SECRETS = ['PRIVATE-', '40000', '90000', '2000000', 'quote-demo-own-9', '100 Demo Street', 'Gate code', 'APN-DEMO', '555 0100'];
function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
function reasonOf(r: Response): string | undefined {
  return (r.body as { details?: { reason?: string } }).details?.reason;
}
function noLeak(value: unknown, keys: readonly string[], secrets: readonly string[]): void {
  const json = JSON.stringify(value);
  for (const key of keys) assert.ok(!json.includes(`"${key}"`), `${key} leaked: ${json.slice(0, 400)}`);
  for (const secret of secrets) assert.ok(!json.includes(secret), `${secret} leaked: ${json.slice(0, 400)}`);
}
async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; hint?: string; message?: string };
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}

test('consultations API: plan item to booked consultation, deliverables, capacity, site visits, licences, mentoring, with negative authorization and concurrency', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  // Anna (mixed company) runs its design office: she may edit the catalogue and manage deals.
  await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.publish'] }).where('id', '=', seed.memberships.anna).execute());
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const [petr, carl, anna, boris, xenia] = [await as('petr'), await as('carl'), await as('anna'), await as('boris'), await as('xenia')];
  const anonymous = h.client();
  const P = seed.people;
  const mixed = { kind: 'company' as const, id: seed.companies.mixed };
  // Xenia stays unscreened: the gate must refuse her commitments.
  await screenClear(h, [{ kind: 'person', id: P.petr }, { kind: 'person', id: P.carl }, { kind: 'person', id: P.anna }, { kind: 'person', id: P.boris }, mixed]);
  const stateOf = async (client: Client, requestId: string): Promise<RequestState> => {
    const token = client.sessionCookie as string;
    const resolved = await h.services().principals.resolve(token);
    assert.ok(resolved);
    return { requestId, principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
  };
  const outbox = async (since: number) => (await h.db.admin.query<{ id: number; type: string; payload: Record<string, unknown> }>('SELECT id::int, type, payload FROM trustwork.outbox_event WHERE id > $1 ORDER BY id', [since])).rows;
  const lastOutbox = async () => (await h.db.admin.query<{ n: number }>('SELECT coalesce(max(id), 0)::int AS n FROM trustwork.outbox_event')).rows[0]!.n;

  /* ---------- Catalogue offerings the consultations extend ---------- */
  const catalogue = async (client: Client, owner: { kind: 'person' | 'company'; id: string }, title: string, listPrice: { minorUnits: string; currency: string } | null, unit: string) => {
    const created = ok<{ offering: { id: string; revision: number }; versions: { id: string }[] }>(await client.post('/v1/catalogue', {
      owner, kind: 'services', actor: PERSON,
      draft: {
        payload: { title, description: null, specification: {}, unit, listPrice, options: [], availability: { state: 'available', capacity: null, observedAt: new Date().toISOString() }, components: [] },
        publicFields: ['title', 'listPrice', 'unit'], privateKnowledge: { costBasis: null, marginTarget: null, notes: 'PRIVATE-expert-cost-note' },
      },
    }), 201);
    ok(await client.post(`/v1/catalogue/${created.offering.id}/versions/${created.versions[0]!.id}/publish`, { expectedRevision: created.offering.revision, actor: PERSON }));
    return created.offering.id;
  };
  const carlSessionId = await catalogue(carl, { kind: 'person', id: P.carl }, 'Structural advice session', usd('15000'), 'h');
  const carlMentoringId = await catalogue(carl, { kind: 'person', id: P.carl }, 'Mentoring for first-time builders', null, 'ls');
  const annaSiteId = await catalogue(anna, mixed, 'Footing inspection visit', usd('30000'), 'ls');

  let session: ConsultationOffering;
  await t.test('offerings: the catalogue owner registers; terms are checked; the public sees allowlisted fields only', async () => {
    const body = { offeringId: carlSessionId, terms: offeringTerms(), actor: PERSON };
    expectError(await anonymous.post('/v1/consultation-offerings', body, { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await petr.post('/v1/consultation-offerings', body), 404, 'access.not_found');
    expectError(await carl.post('/v1/consultation-offerings', { ...body, terms: { ...offeringTerms(), modes: ['async'] } }), 422, 'validation.schema');
    expectError(await carl.post('/v1/consultation-offerings', { ...body, actor: { via: 'agent', mandateId: 'mandate-demo-consult' } }), 403, 'access.mandate_scope');
    const restricted = await carl.post('/v1/consultation-offerings', { ...body, terms: offeringTerms({ regions: ['RU'] }) });
    expectError(restricted, 422, 'validation.schema');
    assert.equal(reasonOf(restricted), 'restricted_place');
    session = ok<ConsultationOffering>(await carl.post('/v1/consultation-offerings', body), 201);
    assert.equal(session.expertPersonId, P.carl);
    assert.equal(session.credential, null);
    assert.deepEqual(session.currentVersion?.listPrice, usd('15000'));
    expectError(await carl.post('/v1/consultation-offerings', body), 409, 'validation.revision_conflict');
    const changed = ok<ConsultationOffering>(await carl.post(`/v1/consultation-offerings/${carlSessionId}`, { expectedRevision: session.revision, terms: offeringTerms({ languages: ['en'] }), status: 'active', actor: PERSON }));
    assert.deepEqual(changed.terms.languages, ['en']);
    const kindChange = await carl.post(`/v1/consultation-offerings/${carlSessionId}`, { expectedRevision: changed.revision, terms: offeringTerms({ kind: 'mentoring' }), status: 'active', actor: PERSON });
    expectError(kindChange, 422, 'validation.schema');
    session = changed;
    ok(await carl.post('/v1/consultation-offerings', { offeringId: carlMentoringId, terms: offeringTerms({ kind: 'mentoring', modes: ['video'], pricing: 'free', recordingOffered: false }), actor: PERSON }), 201);
    const listing = ok<{ offerings: { offeringId: string; title: string | null; listPrice: unknown; credential: unknown }[] }>(await anonymous.get(`/v1/consultation-offerings/public?ownerKind=person&ownerId=${P.carl}`));
    assert.deepEqual(listing.offerings.map((o) => o.offeringId).sort(), [carlSessionId, carlMentoringId].sort());
    noLeak(listing, ['costBasis', 'expertPersonId', 'cancellation'], ['PRIVATE-']);
    expectError(await anonymous.get('/v1/consultation-offerings/public?ownerKind=person'), 422, 'validation.schema');
  });

  /* ---------- A homeowner's approved plan ---------- */
  const project = ok<{ id: string }>(await petr.post('/v1/projects', { owner: { kind: 'person', id: P.petr }, name: 'Demo house in Escondido', summary: null, leaderPersonId: null }), 201);
  const PL = `/v1/projects/${project.id}/plan`;
  ok(await petr.post(`/v1/projects/${project.id}/location`, {
    address: { lines: ['100 Demo Street'], locality: 'Escondido', region: 'CA', postalCode: '92025', countryCode: 'US' }, regionCode: 'US-CA', cadastralRef: 'APN-DEMO-1',
    siteContact: { name: 'Demo Owner', phone: '+1 555 0100', email: null }, siteAccessNotes: 'Gate code 4321', expectedRevision: null,
  }));
  const created = ok<OwnerPlanView>(await petr.post(PL, { timeZone: 'America/Los_Angeles', actor: PERSON, content: CONTENT }), 201);
  const proposed = ok<PlanVersion>(await petr.post(`${PL}/versions/${created.draft!.id}/propose`, { expectedRevision: created.draft!.revision, actor: PERSON }));
  ok(await petr.post(`${PL}/versions/${created.draft!.id}/approve`, { expectedRevision: proposed.revision, digest: proposed.digest }));
  const itemState = async (key: string) => (await h.db.admin.query<{ status: string; path: string | null; link_kind: string | null; link_id: string | null }>(
    'SELECT s.status, s.path, s.link_kind, s.link_id FROM trustwork.plan_item_state s JOIN trustwork.plan p ON p.id = s.plan_id WHERE p.project_id = $1 AND s.item_key = $2', [project.id, key])).rows[0];

  /* ---------- The expert's availability ---------- */
  const soon = ok<{ id: string; revision: number }>(await carl.post('/v1/consultation-availability', { startsAt: at(MIN), endsAt: at(4 * HOUR), timeZone: 'America/Los_Angeles', capacity: 3, actor: PERSON }), 201);
  const later = ok<{ id: string; revision: number }>(await carl.post('/v1/consultation-availability', { startsAt: at(2 * DAY), endsAt: at(2 * DAY + 8 * HOUR), timeZone: 'America/Los_Angeles', capacity: 1, actor: PERSON }), 201);
  expectError(await carl.post('/v1/consultation-availability', { startsAt: at(-3 * HOUR), endsAt: at(-HOUR), timeZone: 'America/Los_Angeles', capacity: 1, actor: PERSON }), 422, 'validation.schema');
  expectError(await petr.post(`/v1/consultation-availability/${soon.id}/close`, { expectedRevision: soon.revision, actor: PERSON }), 404, 'access.not_found');

  let request: RequesterRequestView;
  await t.test('requests: a plan item becomes a brief with the chosen fields only; the budget ceiling stays with the requester', async () => {
    const body = { source: { kind: 'plan_item', projectId: project.id, itemKey: 'framing-review' }, offeringId: carlSessionId, terms: requestTerms(), mentoringRelationshipId: null, privateConstraint: REQUEST_PRIVATE, actor: PERSON };
    expectError(await anonymous.post('/v1/consultation-requests', body, { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await boris.post('/v1/consultation-requests', body), 404, 'access.not_found');
    expectError(await petr.post('/v1/consultation-requests', { ...body, actor: { via: 'agent', mandateId: 'mandate-demo-consult' } }), 403, 'access.mandate_scope');
    for (const [over, reason] of [
      [{ source: { kind: 'plan_item', projectId: project.id, itemKey: 'soil-risk' } }, 'plan_item_kind'],
      [{ source: { kind: 'plan_item', projectId: project.id, itemKey: 'nowhere' } }, 'item_not_in_baseline'],
      [{ terms: requestTerms({ licenceRequired: true }) }, 'licence_required'],
      [{ terms: requestTerms({ kind: 'mentoring' }) }, 'kind_mismatch'],
    ] as const) {
      const r = await petr.post('/v1/consultation-requests', { ...body, ...over });
      expectError(r, 422, 'validation.schema');
      assert.equal(reasonOf(r), reason, JSON.stringify(over));
    }
    const self = await carl.post('/v1/consultation-requests', { ...body, source: { kind: 'direct' }, privateConstraint: null });
    expectError(self, 422, 'validation.schema');
    assert.equal(reasonOf(self), 'self_invitation');
    request = ok<RequesterRequestView>(await petr.post('/v1/consultation-requests', body), 201);
    assert.equal(request.projection, 'owner_private');
    assert.equal(request.request.status, 'requested');
    assert.deepEqual(request.privateConstraint.budgetCeiling, usd('2000000'));
    assert.deepEqual(request.brief.fields, ['scope', 'trade', 'locality', 'drawings']);
    assert.equal(request.brief.regionCode, 'US-CA');
    noLeak(request.brief, CONSULTATION_EXPERT_FORBIDDEN_KEYS, REQUESTER_SECRETS);
    assert.deepEqual(request.freeWindows.map((w) => [w.id, w.remaining]), [[soon.id, 3], [later.id, 1]]);
    assert.deepEqual(await itemState('framing-review'), { status: 'requested', path: 'consultation', link_kind: 'consultation_request', link_id: request.request.id });
    expectError(await petr.post('/v1/consultation-requests', body), 409, 'validation.revision_conflict');
  });

  await t.test('the expert reads the brief (forbidden-field test): never the budget ceiling, the notes, plan internals or the site', async () => {
    const view = ok<ExpertRequestView>(await carl.get(`/v1/consultation-requests/${request.request.id}`));
    assert.equal(view.projection, 'shared_party');
    noLeak(view, CONSULTATION_EXPERT_FORBIDDEN_KEYS, REQUESTER_SECRETS);
    const listing = ok<{ requests: { id: string; side: string }[] }>(await carl.get('/v1/consultation-requests'));
    assert.deepEqual(listing.requests.map((r) => [r.id, r.side]), [[request.request.id, 'expert']]);
    noLeak(listing, CONSULTATION_EXPERT_FORBIDDEN_KEYS, REQUESTER_SECRETS);
    for (const outsider of [boris, xenia, anna]) expectError(await outsider.get(`/v1/consultation-requests/${request.request.id}`), 404, 'access.not_found');
    expectError(await anonymous.get(`/v1/consultation-requests/${request.request.id}`), 401, 'auth.session_invalid');
    expectError(await carl.post(`/v1/consultation-requests/${request.request.id}/private`, { budgetCeiling: null, requesterNotes: null, expectedRevision: 1 }), 404, 'access.not_found');
  });

  let booking: BookingView['booking'];
  await t.test('the expert proposes exact terms: pinned catalogue version, full price, commission (none published), frozen and digest-bound', async () => {
    const R = `/v1/consultation-requests/${request.request.id}`;
    const slotStart = at(5 * MIN);
    const body = { expectedRevision: request.request.revision, mode: 'video', slot: { windowId: soon.id, start: slotStart }, deliverableDue: null, validUntil: at(DAY), note: null, actor: PERSON };
    expectError(await petr.post(`${R}/proposals`, body), 404, 'access.not_found');
    const notRequested = await carl.post(`${R}/proposals`, { ...body, mode: 'phone' });
    expectError(notRequested, 422, 'validation.schema');
    assert.equal(reasonOf(notRequested), 'mode_not_requested');
    expectError(await carl.post(`${R}/proposals`, { ...body, slot: { windowId: soon.id, start: at(5 * HOUR) } }), 422, 'validation.schema');
    expectError(await carl.post(`${R}/proposals`, { ...body, slot: null }), 422, 'validation.schema');
    const view = ok<ExpertRequestView>(await carl.post(`${R}/proposals`, body), 201);
    assert.equal(view.request.status, 'offered');
    booking = view.bookings[0]!;
    assert.equal(booking.status, 'proposed');
    assert.equal(booking.terms.pricing.price.mode, 'hourly');
    assert.deepEqual(booking.terms.pricing.clientTotal, usd('15000'), 'one hour at the catalogue rate');
    assert.deepEqual(booking.terms.pricing.commission, { status: 'none_published' });
    assert.equal(booking.terms.offering.version.version, 1);
    assert.equal(booking.digest.algorithm, 'trustwork-digest-1');
    noLeak(view, CONSULTATION_EXPERT_FORBIDDEN_KEYS, REQUESTER_SECRETS);
    const second = await carl.post(`${R}/proposals`, { ...body, expectedRevision: view.request.revision });
    expectError(second, 409, 'validation.revision_conflict');
    assert.equal(reasonOf(second), 'proposal_open');
    const mine = ok<RequesterRequestView>(await petr.get(R));
    assert.deepEqual(mine.bookings[0]?.terms.pricing, booking.terms.pricing, 'the client sees the full price and the commission before booking');
    request = mine;
  });

  let agreementId: string;
  await t.test('the client books the exact proposal by id and digest; the expert confirms by digest; the slot, obligations, session and reminders follow', async () => {
    const R = `/v1/consultation-requests/${request.request.id}`;
    const ref = { id: booking.id, version: 1, digest: booking.digest };
    const body = { booking: ref, request: { id: request.request.id, version: 1, digest: request.request.digest }, expectedRevision: request.request.revision, recordingConsent: true, electronicRecords: CONSENT, actor: PERSON };
    expectError(await carl.post(`${R}/acceptances`, body), 404, 'access.not_found');
    expectError(await petr.post(`${R}/acceptances`, { ...body, booking: { ...ref, digest: { algorithm: 'trustwork-digest-1', value: 'f'.repeat(64) } } }), 409, 'commercial.digest_mismatch');
    expectError(await petr.post(`${R}/acceptances`, { ...body, request: { ...body.request, digest: { algorithm: 'trustwork-digest-1', value: 'e'.repeat(64) } } }), 409, 'commercial.rfq_version_mismatch');
    const noConsent = await petr.post(`${R}/acceptances`, { ...body, electronicRecords: null });
    expectError(noConsent, 422, 'validation.schema');
    assert.equal(reasonOf(noConsent), 'electronic_records_consent_required');
    expectError(await petr.post(`${R}/acceptances`, { ...body, actor: { via: 'agent', mandateId: 'mandate-demo-consult' } }), 403, 'access.mandate_scope');
    const accepted = ok<RequesterRequestView>(await petr.post(`${R}/acceptances`, body), 201);
    const agreement = accepted.agreements[0]!;
    agreementId = agreement.id;
    assert.equal(agreement.status, 'accepted_by_buyer');
    assert.deepEqual(agreement.booking, ref);
    assert.equal(accepted.bookings[0]?.agreementId, agreement.id);
    assert.equal(accepted.bookings[0]?.recordingConsent, true);
    expectError(await petr.post(`${R}/acceptances`, { ...body, expectedRevision: accepted.request.revision }), 409, 'commercial.quote_not_acceptable');

    const A = `/v1/consultation-agreements/${agreement.id}`;
    const confirm = { expectedRevision: agreement.revision, acceptedTermsDigest: agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON };
    expectError(await petr.post(`${A}/confirm`, confirm), 404, 'access.not_found');
    expectError(await carl.post(`${A}/confirm`, { ...confirm, acceptedTermsDigest: { algorithm: 'trustwork-digest-1', value: 'c'.repeat(64) } }), 409, 'commercial.digest_mismatch');
    const booked = ok<BookingView>(await carl.post(`${A}/confirm`, confirm), 201);
    assert.equal(booked.side, 'expert');
    assert.equal(booked.booking.status, 'booked');
    assert.equal(booked.agreement?.status, 'accepted_by_both');
    assert.deepEqual(booked.agreement?.obligations.map((o) => [o.party.id, o.kind, o.amount?.minorUnits ?? null]), [[P.carl, 'perform', null], [P.petr, 'pay', '15000'], [P.petr, 'accept', null]]);
    assert.deepEqual(booked.threadContext, { kind: 'agreement', id: agreement.id }, 'the parties talk in the agreement context thread');
    assert.ok(booked.session && booked.session.siteAddressRevealedAt === null, 'no site for an advice session');
    assert.equal(booked.site, null);
    assert.deepEqual(booked.reminders, [], 'a slot starting within the hour has no reminders left to send');
    booking = booked.booking;
    assert.equal(ok<RequesterRequestView>(await petr.get(R)).request.status, 'booked');
    const ics = ok<{ fileName: string; mediaType: string; content: string }>(await petr.get(`/v1/consultation-bookings/${booking.id}/calendar`));
    assert.equal(ics.mediaType, 'text/calendar');
    assert.match(ics.content, /SUMMARY:Structural advice session/);
    noLeak(ics, [], ['Demo Street', '15000', 'Gate']);
    for (const outsider of [boris, xenia, anna]) expectError(await outsider.get(`/v1/consultation-bookings/${booking.id}`), 404, 'access.not_found');
  });

  await t.test('the session, then deliverables: the expert claims delivery, the client decides in person; completion counts for the expert\'s reputation', async () => {
    const B = `/v1/consultation-bookings/${booking.id}`;
    const deliverEarly = await carl.post(`${B}/deliverables`, { expectedRevision: booking.revision, kind: 'written_advice', title: 'Beam span advice', body: 'Use LVL beams.', attachments: [] });
    expectError(deliverEarly, 409, 'validation.revision_conflict');
    assert.equal(reasonOf(deliverEarly), 'not_deliverable');
    expectError(await boris.post(`${B}/session`, { expectedRevision: booking.revision, startedAt: at(-50 * MIN), endedAt: at(-MIN), actor: PERSON }), 404, 'access.not_found');
    const held = ok<BookingView>(await carl.post(`${B}/session`, { expectedRevision: booking.revision, startedAt: at(-50 * MIN), endedAt: at(-MIN), actor: PERSON }));
    assert.equal(held.booking.status, 'held');
    expectError(await petr.post(`${B}/deliverables`, { expectedRevision: held.booking.revision, kind: 'written_advice', title: 'x', body: 'x', attachments: [] }), 403, 'access.forbidden');
    const first = ok<BookingView>(await carl.post(`${B}/deliverables`, { expectedRevision: held.booking.revision, kind: 'written_advice', title: 'Beam span advice', body: 'PRIVATE-first-draft: use 2x10.', attachments: [] }), 201);
    assert.equal(first.booking.status, 'delivered');
    const d1 = first.deliverables[0]!;
    expectError(await carl.post(`/v1/consultation-deliverables/${d1.id}/decision`, { decision: 'accepted', note: null }), 403, 'access.forbidden');
    expectError(await petr.post(`/v1/consultation-deliverables/${d1.id}/decision`, { decision: 'rejected', note: null }), 422, 'validation.schema');
    const rejected = ok<BookingView>(await petr.post(`/v1/consultation-deliverables/${d1.id}/decision`, { decision: 'rejected', note: 'Please check the snow load' }));
    assert.equal(rejected.booking.status, 'held', 'a rejection reopens the delivery');
    const second = ok<BookingView>(await carl.post(`${B}/deliverables`, { expectedRevision: rejected.booking.revision, kind: 'written_advice', title: 'Beam span advice, revised', body: 'Use LVL beams of 1.75 by 11.875 inches for spans over 14 feet.', attachments: [attachment] }), 201);
    const d2 = second.deliverables.at(-1)!;
    const accepted = ok<BookingView>(await petr.post(`/v1/consultation-deliverables/${d2.id}/decision`, { decision: 'accepted', note: null }));
    assert.equal(accepted.booking.status, 'accepted');
    assert.equal(accepted.deliverables.at(-1)?.decision, 'accepted');
    assert.ok(accepted.deliverables.at(-1)?.confirmationId);
    expectError(await petr.post(`/v1/consultation-deliverables/${d2.id}/decision`, { decision: 'accepted', note: null }), 409, 'validation.revision_conflict');
    assert.equal((await itemState('framing-review'))?.status, 'done', 'the plan item is done');
    const observations = await h.db.admin.query<{ dimension: string; outcome: string }>('SELECT dimension, outcome FROM trustwork.performance_observation WHERE agreement_id = $1 ORDER BY dimension', [agreementId]);
    assert.ok(observations.rows.some((o) => o.dimension === 'quality' && o.outcome === 'accepted'), JSON.stringify(observations.rows));
    // REP-001 derives `consultation_given` from the completed consultation agreement (never self-asserted).
    const own = ok<{ contributions: { kind: string; source: { kind: string; id: string } }[] }>(await carl.get(`/v1/reputation-builder/people/${P.carl}/own`));
    assert.ok(own.contributions.some((c) => c.kind === 'consultation_given' && c.source.kind === 'agreement' && c.source.id === agreementId), JSON.stringify(own.contributions));
  });

  await t.test('deliverables are visible only to the parties until the author publishes them; the public projection names no client', async () => {
    const view = ok<BookingView>(await petr.get(`/v1/consultation-bookings/${booking.id}`));
    const d2 = view.deliverables.at(-1)!;
    expectError(await anonymous.get(`/v1/consultation-deliverables/${d2.id}/public`), 404, 'access.not_found');
    expectError(await boris.get(`/v1/consultation-deliverables/${d2.id}/public`), 404, 'access.not_found');
    const notAuthor = await petr.post(`/v1/consultation-deliverables/${d2.id}/publish`, { confirmNoClientData: true });
    expectError(notAuthor, 403, 'access.forbidden');
    expectError(await boris.post(`/v1/consultation-deliverables/${d2.id}/publish`, { confirmNoClientData: true }), 404, 'access.not_found');
    expectError(await carl.post(`/v1/consultation-deliverables/${d2.id}/publish`, { confirmNoClientData: false }), 422, 'validation.schema');
    const published = ok<BookingView>(await carl.post(`/v1/consultation-deliverables/${d2.id}/publish`, { confirmNoClientData: true }));
    assert.ok(published.deliverables.at(-1)?.publishedAt);
    const pub = ok<Record<string, unknown>>(await anonymous.get(`/v1/consultation-deliverables/${d2.id}/public`));
    assert.deepEqual(Object.keys(pub).sort(), ['author', 'body', 'consultationKind', 'id', 'kind', 'publishedAt', 'title']);
    noLeak(pub, ['client', 'attachments', 'agreementId', 'bookingId'], [P.petr, 'artifact-demo']);
    expectError(await anonymous.get(`/v1/consultation-deliverables/${view.deliverables[0]!.id}/public`), 404, 'access.not_found');
    expectError(await carl.post(`/v1/consultation-deliverables/${d2.id}/publish`, { confirmNoClientData: true }), 409, 'validation.revision_conflict');
  });

  await t.test('capacity is serialized against the window: of two concurrent confirmations for a window of one, exactly one books', async () => {
    const direct = async (client: Client) => ok<RequesterRequestView>(await client.post('/v1/consultation-requests', {
      source: { kind: 'direct' }, offeringId: carlSessionId, terms: requestTerms({ fields: [], sharedMaterials: [] }), mentoringRelationshipId: null, privateConstraint: null, actor: PERSON,
    }), 201);
    const parties = [await direct(petr), await direct(boris)];
    const starts = [at(2 * DAY + HOUR), at(2 * DAY + 3 * HOUR)];
    const agreements: { id: string; revision: number; acceptedTermsDigest: unknown }[] = [];
    for (const [i, req] of parties.entries()) {
      const proposedView = ok<ExpertRequestView>(await carl.post(`/v1/consultation-requests/${req.request.id}/proposals`, {
        expectedRevision: req.request.revision, mode: 'video', slot: { windowId: later.id, start: starts[i] }, deliverableDue: null, validUntil: at(DAY), note: null, actor: PERSON,
      }), 201);
      const b = proposedView.bookings[0]!;
      const client = i === 0 ? petr : boris;
      const fresh = ok<RequesterRequestView>(await client.get(`/v1/consultation-requests/${req.request.id}`));
      const acceptedView = ok<RequesterRequestView>(await client.post(`/v1/consultation-requests/${req.request.id}/acceptances`, {
        booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: fresh.request.revision,
        recordingConsent: false, electronicRecords: CONSENT, actor: PERSON,
      }), 201);
      agreements.push(acceptedView.agreements[0]!);
    }
    const results = await Promise.all(agreements.map((a) => carl.post(`/v1/consultation-agreements/${a.id}/confirm`, { expectedRevision: a.revision, acceptedTermsDigest: a.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409], JSON.stringify(results.map((r) => r.body)));
    const refused = results.find((r) => r.status === 409)!;
    assert.equal(reasonOf(refused), 'capacity_exhausted');
    const won = results.find((r) => r.status === 201)!.body as BookingView;
    assert.deepEqual(won.reminders.map((r) => r.offsetMinutes).sort((a, b) => a - b), [60, 1440], 'a day and an hour before');
    assert.ok(won.reminders.every((r) => r.status === 'scheduled'));
    const live = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.consultation_booking WHERE window_id = $1 AND status = 'booked'", [later.id]);
    assert.equal(live.rows[0]!.n, 1, 'one booking holds the only place');
    // A party cancels for its own side; the other side's absence only after the start; reminders are cancelled.
    const client = won.booking.terms.client.id === P.petr ? petr : boris;
    const B = `/v1/consultation-bookings/${won.booking.id}`;
    expectError(await client.post(`${B}/cancel`, { expectedRevision: won.booking.revision, kind: 'expert', absentSide: null, reason: 'Not mine to cancel', actor: PERSON }), 422, 'validation.schema');
    expectError(await carl.post(`${B}/cancel`, { expectedRevision: won.booking.revision, kind: 'no_show', absentSide: 'client', reason: 'Too early', actor: PERSON }), 422, 'validation.schema');
    const cancelled = ok<BookingView>(await carl.post(`${B}/cancel`, { expectedRevision: won.booking.revision, kind: 'expert', absentSide: null, reason: 'Called away to another site', actor: PERSON }));
    assert.equal(cancelled.booking.status, 'cancelled');
    assert.equal(cancelled.booking.cancellation?.charge, null, 'the expert\'s cancellation costs the client nothing');
    assert.ok(cancelled.reminders.every((r) => r.status === 'cancelled'));
    assert.match(ok<{ content: string }>(await client.get(`${B}/calendar`)).content, /METHOD:CANCEL/);
    // The freed place can be booked again by the other client.
    const loser = agreements.find((a) => a.id !== won.agreement!.id)!;
    ok(await carl.post(`/v1/consultation-agreements/${loser.id}/decline`, { expectedRevision: loser.revision, reason: 'The slot was taken', actor: PERSON }));
  });

  await t.test('licence-requiring site visits: a recorded licence labelled self-declared; the site reaches the expert only after booking', async () => {
    const credential = ok<{ credentials: { id: string; status: string }[] }>(await anna.post('/v1/reputation-builder/credentials', {
      holder: { kind: 'person', id: P.anna }, kind: 'licence', jurisdiction: 'US-CA', credentialType: 'US-CA-PE-CIVIL', issuer: 'Synthetic Board of Professional Engineers', number: 'PE-DEMO-0001',
      classification: null, coverage: null, validFrom: null, validUntil: '2030-12-31', visibility: 'private', supersedesId: null,
    }), 201).credentials.find((c) => c.status === 'self_declared')!;
    const terms = offeringTerms({ kind: 'site_visit', modes: ['in_person'], regions: ['US-CA'], durationMinutes: 120, deliverableKind: 'site_report', pricing: 'fixed', licence: { required: true, credentialId: credential.id }, recordingOffered: false });
    expectError(await anna.post('/v1/consultation-offerings', { offeringId: annaSiteId, terms: { ...terms, licence: { required: true, credentialId: '00000000-0000-4000-8000-000000000000' } }, actor: PERSON }), 422, 'validation.schema');
    const offering = ok<ConsultationOffering>(await anna.post('/v1/consultation-offerings', { offeringId: annaSiteId, terms, actor: PERSON }), 201);
    assert.equal(offering.owner.kind, 'company');
    assert.equal(offering.credential?.status, 'self_declared', 'shown as stated by the expert, not checked');
    const pub = ok<{ offerings: { credential: { status: string } | null }[] }>(await anonymous.get(`/v1/consultation-offerings/public?ownerKind=company&ownerId=${mixed.id}`));
    assert.equal(pub.offerings[0]?.credential?.status, 'self_declared');
    noLeak(pub, ['number', 'credentialId'], ['PE-DEMO-0001']);
    const window = ok<{ id: string }>(await anna.post('/v1/consultation-availability', { startsAt: at(3 * DAY), endsAt: at(3 * DAY + 8 * HOUR), timeZone: 'America/Los_Angeles', capacity: 2, actor: PERSON }), 201);
    const req = ok<RequesterRequestView>(await petr.post('/v1/consultation-requests', {
      source: { kind: 'plan_item', projectId: project.id, itemKey: 'footing-check' }, offeringId: annaSiteId, mentoringRelationshipId: null, privateConstraint: REQUEST_PRIVATE, actor: PERSON,
      terms: requestTerms({ kind: 'site_visit', preferredModes: ['in_person'], fields: ['locality'], sharedMaterials: [], licenceRequired: true }),
    }), 201);
    const brief = ok<ExpertRequestView>(await anna.get(`/v1/consultation-requests/${req.request.id}`));
    assert.equal(brief.brief.regionCode, 'US-CA');
    noLeak(brief, CONSULTATION_EXPERT_FORBIDDEN_KEYS, REQUESTER_SECRETS);
    const proposedView = ok<ExpertRequestView>(await anna.post(`/v1/consultation-requests/${req.request.id}/proposals`, {
      expectedRevision: brief.request.revision, mode: 'in_person', slot: { windowId: window.id, start: at(3 * DAY + HOUR) }, deliverableDue: null, validUntil: at(2 * DAY), note: null, actor: PERSON,
    }), 201);
    const b = proposedView.bookings[0]!;
    assert.equal(b.terms.credential?.status, 'self_declared', 'the label is frozen into the booked terms');
    noLeak(b, ['number'], ['PE-DEMO-0001']);
    const before = ok<BookingView>(await anna.get(`/v1/consultation-bookings/${b.id}`));
    assert.equal(before.site, null, 'no address before the booking');
    noLeak(before, CONSULTATION_EXPERT_FORBIDDEN_KEYS, REQUESTER_SECRETS);
    const fresh = ok<RequesterRequestView>(await petr.get(`/v1/consultation-requests/${req.request.id}`));
    const accepted = ok<RequesterRequestView>(await petr.post(`/v1/consultation-requests/${req.request.id}/acceptances`, {
      booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: fresh.request.revision,
      recordingConsent: false, electronicRecords: CONSENT, actor: PERSON,
    }), 201);
    const pending = ok<BookingView>(await anna.get(`/v1/consultation-bookings/${b.id}`));
    assert.equal(pending.site, null, 'still nothing while only the client accepted');
    const agreement = accepted.agreements[0]!;
    const service = new ConsultationsService(h.created.ctx as AppContext, h.services().principals, new AllowListConsultationMandates([]), new ConfiguredElectronicRecords(), new NoPublishedCommission(), new ScreeningCommitmentGate());
    const asAnna = await stateOf(anna, 'held-company-actor');
    await holdPerson(h.db.admin, P.anna);
    try {
      await assert.rejects(service.confirmBooking(agreement.id, { expectedRevision: agreement.revision, acceptedTermsDigest: agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }, 'held-company-actor', asAnna),
        (e: unknown) => e instanceof LocalApiError && e.code === 'jurisdiction.restricted' && e.details?.purpose === 'order_accept');
      const stillPending = ok<BookingView>(await petr.get(`/v1/consultation-bookings/${b.id}`));
      assert.equal(stillPending.agreement?.status, 'accepted_by_buyer');
      assert.equal(stillPending.booking.status, 'proposed');
      assert.equal(stillPending.site, null);
      assert.deepEqual(stillPending.agreement?.obligations, []);
    } finally { await clearHold(h.db.admin, P.anna, P.petr); }
    const booked = ok<BookingView>(await anna.post(`/v1/consultation-agreements/${agreement.id}/confirm`, { expectedRevision: agreement.revision, acceptedTermsDigest: agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }), 201);
    assert.equal(booked.booking.status, 'booked');
    assert.equal((booked.site?.address as { lines: string[] } | null)?.lines[0], '100 Demo Street', 'the booked expert receives the site');
    assert.equal(booked.site?.siteAccessNotes, 'Gate code 4321');
    assert.ok(booked.session?.siteAddressRevealedAt, 'the reveal is recorded');
    noLeak(booked, ['budgetCeiling', 'requesterNotes'], ['2000000', 'PRIVATE-requester-note']);
    expectError(await boris.get(`/v1/consultation-bookings/${b.id}`), 404, 'access.not_found');
  });

  await t.test('a superseded licence cannot bind new acceptance or confirmation of already proposed advice', async () => {
    const credentialBody = {
      holder: { kind: 'person', id: P.carl }, kind: 'licence', jurisdiction: 'US-CA', credentialType: 'US-CA-PE-CIVIL', issuer: 'Synthetic Engineering Board', number: 'PE-DEMO-002',
      classification: null, coverage: null, validFrom: null, validUntil: '2030-12-31', visibility: 'private', supersedesId: null,
    };
    const credential = ok<{ credentials: { id: string }[] }>(await carl.post('/v1/reputation-builder/credentials', credentialBody), 201).credentials[0]!;
    const offeringId = await catalogue(carl, { kind: 'person', id: P.carl }, 'Licensed drawing review', usd('15000'), 'ls');
    ok(await carl.post('/v1/consultation-offerings', { offeringId, terms: offeringTerms({ kind: 'drawing_review', modes: ['async'], pricing: 'fixed', recordingOffered: false, licence: { required: true, credentialId: credential.id } }), actor: PERSON }), 201);
    const prepare = async () => {
      const req = ok<RequesterRequestView>(await petr.post('/v1/consultation-requests', {
        source: { kind: 'direct' }, offeringId, terms: requestTerms({ kind: 'drawing_review', preferredModes: ['async'], fields: [], licenceRequired: true }), mentoringRelationshipId: null, privateConstraint: null, actor: PERSON,
      }), 201);
      const proposed = ok<ExpertRequestView>(await carl.post(`/v1/consultation-requests/${req.request.id}/proposals`, {
        expectedRevision: req.request.revision, mode: 'async', slot: null, deliverableDue: at(3 * DAY).slice(0, 10), validUntil: at(DAY), note: null, actor: PERSON,
      }), 201);
      const b = proposed.bookings[0]!;
      return { req, b, accept: () => petr.post(`/v1/consultation-requests/${req.request.id}/acceptances`, {
        booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: proposed.request.revision,
        recordingConsent: false, electronicRecords: CONSENT, actor: PERSON,
      }) };
    };
    const first = await prepare();
    const second = await prepare();
    const agreement = ok<RequesterRequestView>(await second.accept(), 201).agreements[0]!;
    // The pinned licence read serializes with real FK-backed supersession in both orders.
    const reader = await h.db.admin.connect();
    const writer = await h.db.admin.connect();
    const replacement = `INSERT INTO trustwork.professional_credential
      (holder_person_id, kind, jurisdiction, credential_type, issuer, number, valid_until, supersedes_id, recorded_by_person_id)
      SELECT holder_person_id, kind, jurisdiction, credential_type, issuer, 'PE-DEMO-RACE', valid_until, id, recorded_by_person_id
      FROM trustwork.professional_credential WHERE id = $1`;
    try {
      for (const connection of [reader, writer]) {
        await connection.query('BEGIN');
        await connection.query('SET LOCAL ROLE trustwork_owner');
        await connection.query("SET LOCAL trustwork.maintenance = 'on'");
        await connection.query("SET LOCAL lock_timeout = '150ms'");
      }
      assert.equal((await reader.query('SELECT trustwork.consultation_licence_usable($1, $2) AS usable', [credential.id, P.carl])).rows[0]?.usable, true);
      await assert.rejects(writer.query(replacement, [credential.id]), (e: unknown) => (e as { code?: string }).code === '55P03');
      await reader.query('ROLLBACK');
      await writer.query('ROLLBACK');
      for (const connection of [writer, reader]) {
        await connection.query('BEGIN');
        await connection.query('SET LOCAL ROLE trustwork_owner');
        await connection.query("SET LOCAL trustwork.maintenance = 'on'");
        await connection.query("SET LOCAL lock_timeout = '150ms'");
      }
      await writer.query(replacement, [credential.id]);
      await assert.rejects(reader.query('SELECT trustwork.consultation_licence_usable($1, $2)', [credential.id, P.carl]), (e: unknown) => (e as { code?: string }).code === '55P03');
    } finally {
      await reader.query('ROLLBACK'); reader.release();
      await writer.query('ROLLBACK'); writer.release();
    }
    ok(await carl.post('/v1/reputation-builder/credentials', { ...credentialBody, number: 'PE-DEMO-003', supersedesId: credential.id }), 201);
    const refusedAcceptance = await first.accept();
    expectError(refusedAcceptance, 422, 'validation.schema');
    assert.equal(reasonOf(refusedAcceptance), 'licence_required');
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.agreement WHERE offer_ref_id = $1', [first.b.id])).rowCount, 0);
    const refusedConfirmation = await carl.post(`/v1/consultation-agreements/${agreement.id}/confirm`, { expectedRevision: agreement.revision, acceptedTermsDigest: agreement.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON });
    expectError(refusedConfirmation, 422, 'validation.schema');
    assert.equal(reasonOf(refusedConfirmation), 'licence_required');
    const pending = ok<BookingView>(await petr.get(`/v1/consultation-bookings/${second.b.id}`));
    assert.equal(pending.booking.status, 'proposed');
    assert.equal(pending.agreement?.status, 'accepted_by_buyer');
    assert.deepEqual(pending.agreement?.obligations, []);
    assert.equal(pending.session, null);
  });

  await t.test('real screening: proposals refuse unscreened counterparties; holds and stale lists prevent acceptance without leaking counterparty details', async () => {
    const req = ok<RequesterRequestView>(await xenia.post('/v1/consultation-requests', {
      source: { kind: 'direct' }, offeringId: carlSessionId, terms: requestTerms({ fields: [], sharedMaterials: [] }), mentoringRelationshipId: null, privateConstraint: null, actor: PERSON,
    }), 201);
    const proposal = { expectedRevision: req.request.revision, mode: 'video', slot: { windowId: soon.id, start: at(2 * HOUR) }, deliverableDue: null, validUntil: at(DAY), note: null, actor: PERSON };
    const blocked = await carl.post(`/v1/consultation-requests/${req.request.id}/proposals`, proposal);
    expectError(blocked, 409, 'commercial.counterparty_unavailable');
    assert.equal((blocked.body as { details?: unknown }).details, undefined);
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.consultation_booking WHERE request_id = $1', [req.request.id])).rowCount, 0);
    await screenClear(h, [{ kind: 'person', id: P.xenia }]);
    const b = ok<ExpertRequestView>(await carl.post(`/v1/consultation-requests/${req.request.id}/proposals`, proposal), 201).bookings[0]!;
    const fresh = ok<RequesterRequestView>(await xenia.get(`/v1/consultation-requests/${req.request.id}`));
    const accept = () => xenia.post(`/v1/consultation-requests/${req.request.id}/acceptances`, {
      booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: fresh.request.revision,
      recordingConsent: false, electronicRecords: CONSENT, actor: PERSON,
    });
    await holdPerson(h.db.admin, P.carl);
    try {
      const refused = await accept();
      expectError(refused, 409, 'commercial.counterparty_unavailable');
      assert.equal((refused.body as { details?: unknown }).details, undefined);
    } finally { await clearHold(h.db.admin, P.carl, P.petr); }
    // Use the service too: the HTTP jurisdiction middleware otherwise stops an own-side hold before the gate.
    const service = new ConsultationsService(h.created.ctx as AppContext, h.services().principals, new AllowListConsultationMandates([]), new ConfiguredElectronicRecords(), new NoPublishedCommission(), new ScreeningCommitmentGate());
    const state = await stateOf(xenia, 'own-hold');
    await holdPerson(h.db.admin, P.xenia);
    try {
      await assert.rejects(service.acceptProposal(req.request.id, {
        booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: fresh.request.revision,
        recordingConsent: false, electronicRecords: CONSENT, actor: PERSON,
      }, 'own-hold', state), (e: unknown) => e instanceof LocalApiError && e.code === 'jurisdiction.restricted' && e.details?.purpose === 'terms_accept');
    } finally { await clearHold(h.db.admin, P.xenia, P.petr); }
    await setBaselineStale(h.db.admin, true);
    try { expectError(await accept(), 409, 'screening.unavailable'); }
    finally { await setBaselineStale(h.db.admin, false); }
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.agreement WHERE offer_ref_id = $1', [b.id])).rowCount, 0, 'no rejected acceptance binds');
    const withdrawn = ok<RequesterRequestView>(await xenia.post(`/v1/consultation-requests/${req.request.id}/withdraw`, { expectedRevision: fresh.request.revision, reason: 'Not now', actor: PERSON }));
    assert.equal(withdrawn.request.status, 'withdrawn');
    assert.equal(withdrawn.bookings[0]?.status, 'declined');
  });

  await t.test('real gate concurrency: acceptance holds off a jurisdiction writer; an uncommitted hold fails closed before any agreement', { timeout: 15_000 }, async () => {
    const asPetr = await stateOf(petr, 'gate-race');
    const asCarl = await stateOf(carl, 'gate-race-expert');
    const serviceWith = (screening: ConsultationScreeningGate) => new ConsultationsService(h.created.ctx as AppContext, h.services().principals, new AllowListConsultationMandates([]), new ConfiguredElectronicRecords(), new NoPublishedCommission(), screening);
    const real = new ScreeningCommitmentGate();
    const service = serviceWith(real);
    const prepare = async () => {
      const req = await service.createRequest({ source: { kind: 'direct' }, offeringId: carlSessionId, terms: requestTerms({ fields: [], sharedMaterials: [] }), mentoringRelationshipId: null, privateConstraint: null, actor: PERSON }, asPetr);
      const offered = await service.propose(req.request.id, { expectedRevision: req.request.revision, mode: 'video', slot: { windowId: soon.id, start: at(2 * HOUR) }, deliverableDue: null, validUntil: at(DAY), note: null, actor: PERSON }, asCarl);
      const b = offered.bookings[0]!;
      const fresh = await service.getRequest(req.request.id, asPetr) as RequesterRequestView;
      return { id: req.request.id, bookingId: b.id, body: {
        booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: fresh.request.revision,
        recordingConsent: false, electronicRecords: CONSENT, actor: PERSON,
      } };
    };
    const first = await prepare();
    const second = await prepare();
    const barrier = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const checked = barrier();
    const release = barrier();
    // This wrapper only pauses after the production gate; it never supplies a verdict.
    const paused = serviceWith({ async requireTransactable(...args) { await real.requireTransactable(...args); checked.resolve(); await release.promise; } });
    const accepting = paused.acceptProposal(first.id, first.body, 'gate-first', asPetr);
    const writer = await h.db.admin.connect();
    try {
      await Promise.race([checked.promise, accepting.then(() => assert.fail('acceptance escaped its barrier'))]);
      await writer.query('BEGIN');
      await writer.query('SET LOCAL ROLE trustwork_owner');
      await writer.query("SET LOCAL trustwork.maintenance = 'on'");
      await writer.query("SET LOCAL lock_timeout = '150ms'");
      await assert.rejects(writer.query("INSERT INTO trustwork.jurisdiction_hold (person_id, place, source, dataset) VALUES ($1, 'CU', 'staff_report', 'fixture')", [P.carl]),
        (e: unknown) => (e as { code?: string }).code === '55P03', 'the real commitment transaction retains the hold lock');
      await writer.query('ROLLBACK');
    } finally { release.resolve(); await writer.query('ROLLBACK'); writer.release(); }
    assert.equal((await accepting).agreements[0]?.status, 'accepted_by_buyer');

    // The opposite order: the hold is written but uncommitted. A bounded gate read must refuse, never use old clear state.
    const holder = await h.db.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SET LOCAL ROLE trustwork_owner');
      await holder.query("SET LOCAL trustwork.maintenance = 'on'");
      await holder.query("INSERT INTO trustwork.jurisdiction_hold (person_id, place, source, dataset) VALUES ($1, 'CU', 'staff_report', 'fixture')", [P.carl]);
      const bounded = serviceWith({ async requireTransactable(...args) { await sql`SET LOCAL lock_timeout = '150ms'`.execute(args[0]); await real.requireTransactable(...args); } });
      await assert.rejects(bounded.acceptProposal(second.id, second.body, 'hold-first', asPetr),
        (e: unknown) => e instanceof LocalApiError && e.code === 'screening.unavailable');
      assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.agreement WHERE offer_ref_id = $1', [second.bookingId])).rowCount, 0);
      await holder.query('COMMIT');
      await assert.rejects(service.acceptProposal(second.id, second.body, 'hold-committed', asPetr),
        (e: unknown) => e instanceof LocalApiError && e.code === 'commercial.counterparty_unavailable' && e.details === undefined);
    } finally { await holder.query('ROLLBACK'); holder.release(); await clearHold(h.db.admin, P.carl, P.petr); }
  });

  await t.test('agents and private ceilings with a fake commission and mandate port, using the real screening gate', async () => {
    const ctx = h.created.ctx as AppContext;
    const mandates = new AllowListConsultationMandates([
      { personId: P.petr, mandateId: 'mandate-demo-consult', action: 'place_order', ceiling: usd('10000000') },
      { personId: P.carl, mandateId: 'mandate-demo-expert', action: 'send_quote' },
    ]);
    const commission = new FixedRateCommission({ id: 'price-setting-demo-consultations', version: 2, rateBps: 1000, fixedFee: null, payer: 'client' });
    const service = new ConsultationsService(ctx, h.services().principals, mandates, new ConfiguredElectronicRecords(), commission, new ScreeningCommitmentGate());
    const asPetr = await stateOf(petr, 'req-cons-agent-1');
    const asCarl = await stateOf(carl, 'req-cons-agent-2');
    const req = await service.createRequest({ source: { kind: 'direct' }, offeringId: carlSessionId, terms: requestTerms({ fields: [], sharedMaterials: [] }), mentoringRelationshipId: null, privateConstraint: { budgetCeiling: usd('16000'), requesterNotes: null }, actor: PERSON }, asPetr);
    const proposedView = await service.propose(req.request.id, { expectedRevision: req.request.revision, mode: 'video', slot: { windowId: soon.id, start: at(150 * MIN) }, deliverableDue: null, validUntil: at(DAY), note: null, actor: { via: 'agent', mandateId: 'mandate-demo-expert' } }, asCarl);
    const b = proposedView.bookings[0]!;
    assert.equal(b.terms.pricing.commission.status, 'published');
    assert.deepEqual(b.terms.pricing.clientTotal, usd('16500'), 'price plus the published 10 percent commission');
    assert.deepEqual(b.terms.pricing.expertAmount, usd('15000'));
    assert.equal(mandates.checks.find((c) => c.action === 'send_quote')?.amount?.minorUnits, '16500');
    const fresh = await service.getRequest(req.request.id, asPetr) as RequesterRequestView;
    const acceptBody = { booking: { id: b.id, version: 1, digest: b.digest }, request: { id: req.request.id, version: 1, digest: req.request.digest }, expectedRevision: fresh.request.revision, recordingConsent: false, electronicRecords: CONSENT, actor: { via: 'agent' as const, mandateId: 'mandate-demo-consult' } };
    await assert.rejects(service.acceptProposal(req.request.id, acceptBody, 'idem-cons-agent-1', asPetr), (e: unknown) => e instanceof ApiError && e.code === 'access.mandate_scope' && e.details?.reason === 'outside_private_constraints');
    const foreign = await service.setRequestPrivate(req.request.id, { budgetCeiling: { minorUnits: '999999999', currency: 'EUR' }, requesterNotes: null, expectedRevision: fresh.privateConstraint.revision }, asPetr);
    await assert.rejects(service.acceptProposal(req.request.id, { ...acceptBody, expectedRevision: foreign.request.revision }, 'idem-cons-agent-fx', asPetr),
      (e: unknown) => e instanceof ApiError && e.code === 'access.mandate_scope' && e.details?.reason === 'outside_private_constraints');
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.agreement WHERE offer_ref_id = $1', [b.id])).rowCount, 0, 'different currencies never bypass the private ceiling');
    assert.equal((await h.db.admin.query('SELECT agreement_id FROM trustwork.consultation_booking WHERE id = $1', [b.id])).rows[0]?.agreement_id, null);
    const raised = await service.setRequestPrivate(req.request.id, { budgetCeiling: usd('20000'), requesterNotes: null, expectedRevision: foreign.privateConstraint.revision }, asPetr);
    const accepted = await service.acceptProposal(req.request.id, { ...acceptBody, expectedRevision: raised.request.revision }, 'idem-cons-agent-4', asPetr);
    assert.equal(accepted.agreements[0]?.status, 'accepted_by_buyer', 'within the ceiling and the mandate the agent books');
    assert.equal(new NoPublishedCommission() instanceof NoPublishedCommission, true);
  });

  await t.test('mentoring is double opt-in; mentoring sessions follow an active relationship', async () => {
    const body = { source: { kind: 'direct' }, offeringId: carlMentoringId, terms: requestTerms({ kind: 'mentoring', fields: [], sharedMaterials: [] }), mentoringRelationshipId: null, privateConstraint: null, actor: PERSON };
    const missing = await petr.post('/v1/consultation-requests', body);
    expectError(missing, 422, 'validation.schema');
    assert.equal(reasonOf(missing), 'mentoring_not_active');
    const rel = ok<{ id: string; revision: number; status: string }>(await petr.post('/v1/mentoring', { counterpart: P.carl, myRole: 'mentee', topics: ['First house build'], terms: 'free', offeringId: null, actor: PERSON }), 201);
    expectError(await petr.post('/v1/mentoring', { counterpart: P.carl, myRole: 'mentee', topics: ['Again'], terms: 'free', offeringId: null, actor: PERSON }), 409, 'validation.revision_conflict');
    const early = await petr.post('/v1/consultation-requests', { ...body, mentoringRelationshipId: rel.id });
    expectError(early, 422, 'validation.schema');
    assert.equal(reasonOf(early), 'mentoring_not_active');
    expectError(await petr.post(`/v1/mentoring/${rel.id}/respond`, { expectedRevision: rel.revision, decision: 'accept', actor: PERSON }), 422, 'validation.schema');
    expectError(await boris.post(`/v1/mentoring/${rel.id}/respond`, { expectedRevision: rel.revision, decision: 'accept', actor: PERSON }), 404, 'access.not_found');
    const active = ok<{ id: string; revision: number; status: string; startedAt: string | null }>(await carl.post(`/v1/mentoring/${rel.id}/respond`, { expectedRevision: rel.revision, decision: 'accept', actor: PERSON }));
    assert.equal(active.status, 'active');
    assert.ok(active.startedAt);
    const sessionReq = ok<RequesterRequestView>(await petr.post('/v1/consultation-requests', { ...body, mentoringRelationshipId: rel.id }), 201);
    assert.equal(sessionReq.request.kind, 'mentoring');
    const paused = ok<{ revision: number; status: string }>(await carl.post(`/v1/mentoring/${rel.id}/change`, { expectedRevision: active.revision, to: 'paused', reason: null, actor: PERSON }));
    expectError(await petr.post(`/v1/mentoring/${rel.id}/change`, { expectedRevision: paused.revision, to: 'ended', reason: null, actor: PERSON }), 422, 'validation.schema');
    const ended = ok<{ status: string; endedReason: string | null }>(await petr.post(`/v1/mentoring/${rel.id}/change`, { expectedRevision: paused.revision, to: 'ended', reason: 'Build finished', actor: PERSON }));
    assert.deepEqual([ended.status, ended.endedReason], ['ended', 'Build finished']);
    const listing = ok<{ relationships: unknown[] }>(await carl.get('/v1/mentoring'));
    assert.equal(listing.relationships.length, 1);
    assert.deepEqual(ok<{ relationships: unknown[] }>(await boris.get('/v1/mentoring')).relationships, []);
  });

  await t.test('database guards hold for every role: frozen terms and digests, private halves, retained rows, FORCE RLS', async () => {
    const tables = ['consultation_offering', 'availability_window', 'consultation_request', 'consultation_request_private', 'mentoring_relationship', 'consultation_booking', 'consultation_session', 'consultation_deliverable', 'consultation_reminder'];
    const forced = await h.db.admin.query<{ relname: string; relforcerowsecurity: boolean }>("SELECT relname, relforcerowsecurity FROM pg_class WHERE relnamespace = 'trustwork'::regnamespace AND relname = ANY($1)", [tables]);
    assert.deepEqual(forced.rows.filter((r) => r.relforcerowsecurity).map((r) => r.relname).sort(), [...tables].sort());
    // Booked terms never change, not even for the owner role with maintenance on.
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('consultation_booking').set({ terms: JSON.stringify({ tampered: true }) }).where('id', '=', booking.id).execute()), 'commerce.version_frozen');
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('consultation_booking').set({ slot_start: new Date() }).where('id', '=', booking.id).execute()), 'commerce.version_frozen');
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('agreement').set({ accepted_terms_digest: 'f'.repeat(64) }).where('id', '=', agreementId).execute()), 'commerce.version_frozen');
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('consultation_request').set({ brief: JSON.stringify({}) }).where('id', '=', request.request.id).execute()), 'commerce.version_frozen');
    await fails(withMaintenance(h.db.admin, (trx) => trx.deleteFrom('consultation_booking').where('id', '=', booking.id).execute()), 'commerce.retained');
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('consultation_deliverable').set({ body: 'rewritten' }).where('booking_id', '=', booking.id).execute()), 'commerce.version_frozen');
    // The runtime role has no column grant on the terms at all.
    await fails(withPrincipal(h.pool, await principalFor(h.db.admin, P.petr), (trx) => trx.updateTable('consultation_booking').set({ terms: '{}' }).where('id', '=', booking.id).execute()), '42501');
    // The expert never reads the requester's private half; the requester does.
    const privateRows = async (person: string) => withPrincipal(h.pool, await principalFor(h.db.admin, person), (trx) => trx.selectFrom('consultation_request_private').select('budget_ceiling_minor').execute());
    assert.equal((await privateRows(P.carl)).length, 0);
    assert.ok((await privateRows(P.petr)).length >= 1);
    // Outsiders read no booking, deliverable, session or reminder rows.
    for (const table of ['consultation_booking', 'consultation_deliverable', 'consultation_session', 'consultation_reminder', 'consultation_request'] as const) {
      const rows = await withPrincipal(h.pool, await principalFor(h.db.admin, P.xenia), (trx) => trx.selectFrom(table).selectAll().execute());
      assert.ok(rows.every((r) => JSON.stringify(r).includes(P.xenia)), `${table} rows reach a non-party`);
    }
    // A recorded session is not rewritten.
    await fails(withPrincipal(h.pool, await principalFor(h.db.admin, P.carl), (trx) => trx.updateTable('consultation_session').set({ ended_at: new Date() }).where('booking_id', '=', booking.id).execute()), 'commerce.version_frozen');
  });

  await t.test('outbox events carry identifiers only', async () => {
    const events = await outbox(0);
    const ours = events.filter((e) => e.type.startsWith('consultation.'));
    assert.ok(ours.length >= 10);
    for (const e of ours) for (const key of Object.keys(e.payload)) assert.ok((CONSULTATION_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `${e.type}: ${key}`);
    noLeak(ours, CONSULTATION_EXPERT_FORBIDDEN_KEYS, [...REQUESTER_SECRETS, 'Beam span', 'snow load']);
    assert.ok(await lastOutbox() > 0);
  });
});
