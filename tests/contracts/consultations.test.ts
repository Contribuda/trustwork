import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as c from '../../packages/contracts/src/index.js';
import * as k from '../../packages/contracts/src/consultations.js';
import type { PlanItem, ProjectLocation } from '../../packages/contracts/src/plans.js';

/* Synthetic US demo data (San Diego County homeowner and a fictional engineer); no real people, companies or prices. */
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const digest = (ch: string) => ({ algorithm: 'trustwork-digest-1' as const, value: ch.repeat(64) });
const attachment = { evidenceArtifactId: 'artifact-demo-framing-plan', hash: 'a'.repeat(64), audience: 'shared' as const };
const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const framing = item({
  key: 'framing-review', kind: 'consultation', title: 'Review the framing drawings', description: 'Check the beam spans on sheets A-101 to A-104', stepTerms: ['work.structure.framing'],
  requiredSkills: ['trade.structural_engineer'], quantity: { value: '2000', unit: 'ft2' },
  estimate: { kind: 'estimate_range', low: usd('40000'), high: usd('90000'), basis: 'licensed_source', basisRef: 'dataset-demo-costs', asOf: '2026-10-31' },
  duration: { lowDays: 1, highDays: 3 }, window: { earliestStart: '2027-02-01', latestFinish: '2027-02-20' }, sources: [{ kind: 'own_quote', ref: 'quote-demo-own-9' }], attachments: [attachment],
  privateNotes: 'PRIVATE-budget-ceiling-note', riskLevel: 'high', decisionQuestion: 'PRIVATE-decision',
});
const location: ProjectLocation = {
  projectId: 'project-demo-1', address: { lines: ['100 Demo Street'], locality: 'Escondido', region: 'CA', postalCode: '92025', countryCode: 'US' }, regionCode: 'US-CA',
  cadastralRef: 'APN-DEMO-1', siteContact: { name: 'Demo Owner', phone: '+1 555 0100', email: null }, siteAccessNotes: 'Gate code 4321', revision: 1, updatedAt: '2026-10-31T10:00:00.000Z',
};
const requestTerms: k.ConsultationRequestTerms = {
  kind: 'drawing_review', question: 'Are the beam spans right for a snow load of 20 psf?', fields: ['scope', 'trade', 'locality', 'drawings'], preferredModes: ['async'],
  preferredTimes: [], sharedMaterials: [attachment], licenceRequired: true, languages: ['en'],
};
const offeringTerms: k.ConsultationOfferingTerms = {
  kind: 'drawing_review', modes: ['async', 'video'], topics: ['work.structure.framing'], regions: ['US-CA'], languages: ['en', 'es'], durationMinutes: 90, deliverableKind: 'marked_up_document',
  pricing: 'fixed', cancellation: { freeUntilHours: 24, lateShareBps: 5000, noShowShareBps: 10000 }, licence: { required: true, credentialId: 'credential-demo-pe' }, recordingOffered: true,
};
const SECRETS = ['PRIVATE-', '40000', '90000', 'quote-demo-own-9', '100 Demo Street', 'Gate code', 'APN-DEMO', '555 0100'];
function noLeak(value: unknown): void {
  const json = JSON.stringify(value);
  for (const key of k.CONSULTATION_EXPERT_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} reached the expert: ${json.slice(0, 300)}`);
  for (const secret of SECRETS) assert.ok(!json.includes(secret), `${secret} reached the expert`);
}
const selfDeclared: k.CredentialLabel = { credentialId: 'credential-demo-pe', status: 'self_declared', jurisdiction: 'US-CA', credentialType: 'US-CA-PE-CIVIL', checkedOn: null };
function bookingTerms(over: Partial<k.BookingTerms> = {}): k.BookingTerms {
  const price = k.consultationPrice({ pricing: 'fixed', listPrice: usd('45000'), unit: 'ls', minutes: 90 });
  return {
    request: { id: 'request-demo-1', version: 1, digest: digest('b') }, offering: { offeringId: 'offering-demo-1', version: { id: 'offering-version-demo-1', version: 2, digest: digest('c') }, title: 'Drawing review by a civil engineer' },
    expert: { party: { kind: 'person', id: 'person-demo-expert' }, personId: 'person-demo-expert' }, client: { kind: 'person', id: 'person-demo-owner' }, kind: 'drawing_review', mode: 'async',
    slot: null, windowId: null, durationMinutes: 90, deliverableKind: 'marked_up_document', deliverableDue: '2027-02-10', pricing: k.pricingSummary(price, { status: 'none_published' }),
    cancellation: offeringTerms.cancellation, recordingOffered: false, credential: selfDeclared, timeZone: 'America/Los_Angeles', validUntil: '2027-01-31T00:00:00.000Z', note: null, ...over,
  };
}

test('a plan item becomes a brief with only the chosen fields; budgets, the address and plan internals never reach the expert', () => {
  const brief = k.buildConsultationBrief({ item: framing, location, terms: requestTerms, timeZone: 'America/Los_Angeles' });
  assert.deepEqual(brief.fields, ['scope', 'trade', 'locality', 'drawings']);
  assert.equal(brief.regionCode, 'US-CA');
  assert.equal(brief.description, framing.description);
  assert.deepEqual(brief.attachments, [attachment]);
  assert.equal('quantity' in brief || 'window' in brief || 'duration' in brief, false, 'unchosen fields are absent');
  noLeak(brief);
  const narrow = k.buildConsultationBrief({ item: framing, location, terms: { ...requestTerms, fields: [] }, timeZone: 'America/Los_Angeles' });
  assert.equal('description' in narrow || 'regionCode' in narrow, false);
  const direct = k.buildConsultationBrief({ item: null, location: null, terms: requestTerms, timeZone: 'UTC' });
  assert.deepEqual([direct.fields, direct.planItem], [[], null], 'a direct question shares no plan field');
  assert.throws(() => k.buildConsultationBrief({ item: { ...framing, kind: 'risk' }, location, terms: requestTerms, timeZone: 'UTC' }), k.ConsultationBriefError);
  assert.equal((k.CONSULTATION_SHARE_FIELDS as readonly string[]).includes('budget_range'), false, 'a budget range is never a shareable field');
  assert.equal(k.ConsultationRequestTermsSchema.safeParse({ ...requestTerms, fields: ['address'] }).success, false);
  assert.equal(k.ConsultationRequestTermsSchema.safeParse({ ...requestTerms, preferredModes: ['in_person'] }).success, false, 'a drawing review is not in person');
});

test('the requester budget ceiling lives only in the private half: no expert-facing schema has a key for it (forbidden-field test)', () => {
  const keysOf = (schema: unknown, seen = new Set<unknown>()): string[] => {
    if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
    seen.add(schema);
    const s = schema as { shape?: Record<string, unknown>; def?: Record<string, unknown>; _zod?: { def?: Record<string, unknown> } };
    const def = (s._zod?.def ?? s.def ?? {}) as Record<string, unknown>;
    const shape = (def.shape ?? s.shape) as Record<string, unknown> | undefined;
    const own = shape ? Object.keys(shape) : [];
    const children = [...(shape ? Object.values(shape) : []), def.innerType, def.element, def.in, def.out, def.schema, ...((def.options as unknown[]) ?? [])].filter(Boolean);
    return [...own, ...children.flatMap((x) => keysOf(x, seen))];
  };
  for (const [name, schema] of [['ExpertRequestView', k.ExpertRequestViewSchema], ['BookingView', k.BookingViewSchema], ['ConsultationBrief', k.ConsultationBriefSchema], ['BookingTerms', k.BookingTermsSchema]] as const) {
    const keys = new Set(keysOf(schema));
    for (const forbidden of ['budgetCeiling', 'requesterNotes', 'privateNotes', 'estimate', 'budgetRange', 'sources']) assert.equal(keys.has(forbidden), false, `${name} has ${forbidden}`);
  }
  assert.ok(new Set(keysOf(k.RequesterRequestViewSchema)).has('budgetCeiling'), 'the requester sees its own ceiling');
  assert.equal(k.CONSULTATION_EGRESS.requestPrivate.sharedProjection, false);
  for (const key of k.CONSULTATION_EVENT_PAYLOAD_KEYS) assert.equal(['budgetCeiling', 'price', 'amount', 'address', 'question', 'body'].includes(key), false, `${key} in event payloads`);
});

test('booked terms are digest-bound: every field is in the digest, the digest is stable, and the shape rules hold', () => {
  const terms = bookingTerms();
  const base = c.computeDigest(k.bookingTermsDigestInput({ bookingId: 'booking-demo-1', terms }));
  assert.deepEqual(c.computeDigest(k.bookingTermsDigestInput({ bookingId: 'booking-demo-1', terms: structuredClone(terms) })), base, 'stable');
  assert.notDeepEqual(c.computeDigest(k.bookingTermsDigestInput({ bookingId: 'booking-demo-2', terms })), base, 'bound to the booking');
  const variants: Partial<k.BookingTerms>[] = [
    { deliverableDue: '2027-02-11' }, { note: 'another note' }, { validUntil: '2027-01-30T00:00:00.000Z' }, { credential: null },
    { pricing: k.pricingSummary(k.consultationPrice({ pricing: 'fixed', listPrice: usd('45001'), unit: 'ls', minutes: 90 }), { status: 'none_published' }) },
    { pricing: k.pricingSummary(k.consultationPrice({ pricing: 'fixed', listPrice: usd('45000'), unit: 'ls', minutes: 90 }), k.commissionOn(usd('45000'), { id: 'price-setting-demo', version: 1, rateBps: 1000, fixedFee: null, payer: 'client' })) },
    { cancellation: { ...offeringTerms.cancellation, lateShareBps: 4000 } },
  ];
  for (const v of variants) assert.notDeepEqual(c.computeDigest(k.bookingTermsDigestInput({ bookingId: 'booking-demo-1', terms: { ...terms, ...v } })), base, JSON.stringify(Object.keys(v)));
  assert.equal(k.BookingTermsSchema.safeParse({ ...terms, mode: 'video' }).success, false, 'a synchronous mode books a slot');
  assert.equal(k.BookingTermsSchema.safeParse({ ...terms, mode: 'video', deliverableDue: null, slot: { start: '2027-02-02T17:00:00.000Z', end: '2027-02-02T18:00:00.000Z' }, windowId: 'window-demo' }).success, false, 'the slot lasts the offered duration');
  assert.ok(k.BookingTermsSchema.safeParse({ ...terms, mode: 'video', deliverableDue: null, slot: { start: '2027-02-02T17:00:00.000Z', end: '2027-02-02T18:30:00.000Z' }, windowId: 'window-demo' }).success);
  assert.equal(k.BookingTermsSchema.safeParse({ ...terms, kind: 'site_visit' }).success, false, 'a site visit is in person');
});

test('acceptance checks the exact proposal, the request digest, the status and the validity', () => {
  const now = new Date('2027-01-20T00:00:00.000Z');
  const booking = { id: 'booking-demo-1', status: 'proposed' as const, digest: 'd'.repeat(64), validUntil: '2027-01-31T00:00:00.000Z', agreementId: null };
  const request = { id: 'request-demo-1', status: 'offered' as const, digest: 'b'.repeat(64) };
  const ref = { id: booking.id, version: 1, digest: digest('d') };
  assert.equal(k.checkBookingAcceptance({ booking, bookingRef: ref, request, requestRefDigest: request.digest, now }), 'ok');
  assert.equal(k.checkBookingAcceptance({ booking, bookingRef: { ...ref, digest: digest('e') }, request, requestRefDigest: request.digest, now }), 'commercial.digest_mismatch');
  assert.equal(k.checkBookingAcceptance({ booking, bookingRef: ref, request, requestRefDigest: 'f'.repeat(64), now }), 'commercial.rfq_version_mismatch');
  assert.equal(k.checkBookingAcceptance({ booking: { ...booking, agreementId: 'agreement-demo' }, bookingRef: ref, request, requestRefDigest: request.digest, now }), 'commercial.quote_not_acceptable');
  assert.equal(k.checkBookingAcceptance({ booking, bookingRef: ref, request, requestRefDigest: request.digest, now: new Date('2027-02-01T00:00:00.000Z') }), 'commercial.quote_expired');
});

test('prices come from the pinned catalogue version; the hub commission is shown with full totals before booking', () => {
  assert.deepEqual(k.consultationPrice({ pricing: 'free', listPrice: null, unit: 'ls', minutes: 30 }), { mode: 'free' });
  assert.throws(() => k.consultationPrice({ pricing: 'free', listPrice: usd('100'), unit: 'ls', minutes: 30 }), k.ConsultationPriceError);
  assert.throws(() => k.consultationPrice({ pricing: 'fixed', listPrice: null, unit: 'ls', minutes: 30 }), k.ConsultationPriceError);
  assert.throws(() => k.consultationPrice({ pricing: 'hourly', listPrice: usd('15000'), unit: 'ls', minutes: 30 }), k.ConsultationPriceError);
  const hourly = k.consultationPrice({ pricing: 'hourly', listPrice: usd('15000'), unit: 'h', minutes: 90 });
  assert.deepEqual(k.priceAmount(hourly), usd('22500'));
  assert.deepEqual(k.priceAmount(k.consultationPrice({ pricing: 'hourly', listPrice: usd('10001'), unit: 'h', minutes: 30 })), usd('5001'), 'half up');
  const clientPays = k.pricingSummary(hourly, k.commissionOn(usd('22500'), { id: 'price-setting-demo', version: 3, rateBps: 1000, fixedFee: usd('100'), payer: 'client' }));
  assert.deepEqual([clientPays.clientTotal, clientPays.expertAmount], [usd('24850'), usd('22500')]);
  const expertPays = k.pricingSummary(hourly, k.commissionOn(usd('22500'), { id: 'price-setting-demo', version: 3, rateBps: 1000, fixedFee: null, payer: 'expert' }));
  assert.deepEqual([expertPays.clientTotal, expertPays.expertAmount], [usd('22500'), usd('20250')]);
  const none = k.pricingSummary(hourly, { status: 'none_published' });
  assert.deepEqual([none.clientTotal, none.expertAmount], [usd('22500'), usd('22500')], 'no hidden fee when the hub publishes none');
  const free = k.pricingSummary({ mode: 'free' }, { status: 'none_published' });
  assert.deepEqual([free.clientTotal, free.expertAmount], [null, null]);
});

test('licence-requiring advice needs a usable recorded licence (self-declared allowed and labelled); proposals fit the request and the offering', () => {
  const brief = k.buildConsultationBrief({ item: framing, location, terms: requestTerms, timeZone: 'America/Los_Angeles' });
  const now = new Date('2027-01-20T00:00:00.000Z');
  const base = { brief, offering: offeringTerms, mode: 'async' as const, slot: null, window: null, deliverableDue: '2027-02-10', now };
  assert.deepEqual(k.proposalMisfits({ ...base, credential: selfDeclared }), []);
  assert.ok(k.licenceUsable({ status: 'checked' }));
  for (const status of ['expired', 'suspended', 'revoked'] as const) assert.deepEqual(k.proposalMisfits({ ...base, credential: { ...selfDeclared, status } }), ['licence_required'], status);
  assert.deepEqual(k.proposalMisfits({ ...base, credential: null }), ['licence_required']);
  assert.deepEqual(k.proposalMisfits({ ...base, credential: selfDeclared, mode: 'video', slot: { start: '2027-01-21T17:00:00.000Z', end: '2027-01-21T18:30:00.000Z' }, window: { startsAt: '2027-01-21T18:00:00.000Z', endsAt: '2027-01-21T22:00:00.000Z' }, deliverableDue: null }), ['mode_not_requested', 'slot_outside_window']);
  assert.deepEqual(k.proposalMisfits({ ...base, credential: selfDeclared, deliverableDue: '2027-01-19' }), ['due_in_past']);
  assert.equal(k.ConsultationOfferingTermsSchema.safeParse({ ...offeringTerms, licence: { required: true, credentialId: null } }).success, false, 'licence-requiring advice names the licence');
  assert.equal(k.ConsultationOfferingTermsSchema.safeParse({ ...offeringTerms, kind: 'site_visit', modes: ['in_person'], regions: [] }).success, false, 'a site visit names its places');
  assert.equal(k.ConsultationOfferingTermsSchema.safeParse({ ...offeringTerms, modes: ['async'], recordingOffered: true }).success, false, 'recording only for video');
});

test('obligations, cancellation charges, reminders and the calendar file follow the booked terms; no money is held', () => {
  const async = bookingTerms();
  assert.deepEqual(k.deriveConsultationObligations(async).map((o) => [o.party.id, o.kind, o.amount?.minorUnits ?? null]), [
    ['person-demo-expert', 'perform', null], ['person-demo-owner', 'pay', '45000'], ['person-demo-owner', 'accept', null],
  ]);
  assert.equal(k.deriveConsultationObligations(async)[0]?.due, '2027-02-11T08:00:00.000Z', 'an async review is due by the start of the next business day');
  const free = bookingTerms({ pricing: k.pricingSummary({ mode: 'free' }, { status: 'none_published' }) });
  assert.deepEqual(k.deriveConsultationObligations(free).map((o) => o.kind), ['perform', 'accept'], 'a free consultation has no payment obligation');
  const slot = { start: '2027-02-02T17:00:00.000Z', end: '2027-02-02T18:30:00.000Z' };
  const session = bookingTerms({ mode: 'video', slot, windowId: 'window-demo', deliverableDue: null });
  const at = (iso: string) => new Date(iso);
  assert.equal(k.cancellationCharge(session, { kind: 'client', absentSide: null, at: at('2027-01-30T00:00:00.000Z') }), null, 'timely');
  assert.deepEqual(k.cancellationCharge(session, { kind: 'client', absentSide: null, at: at('2027-02-02T10:00:00.000Z') }), usd('22500'), 'late: half');
  assert.deepEqual(k.cancellationCharge(session, { kind: 'no_show', absentSide: 'client', at: at('2027-02-02T17:30:00.000Z') }), usd('45000'));
  assert.equal(k.cancellationCharge(session, { kind: 'no_show', absentSide: 'expert', at: at('2027-02-02T17:30:00.000Z') }), null, 'the expert\'s absence costs the client nothing');
  assert.equal(k.cancellationCharge(session, { kind: 'expert', absentSide: null, at: at('2027-02-02T16:00:00.000Z') }), null);
  assert.deepEqual(k.reminderTimes(slot, at('2027-01-30T00:00:00.000Z')), [{ remindAt: '2027-02-01T17:00:00.000Z', offsetMinutes: 1440 }, { remindAt: '2027-02-02T16:00:00.000Z', offsetMinutes: 60 }]);
  assert.deepEqual(k.reminderTimes(slot, at('2027-02-02T00:00:00.000Z')).map((r) => r.offsetMinutes), [60]);
  const ics = k.bookingCalendar({ bookingId: 'booking-demo-1', title: 'Drawing review, beams; spans', slot, sequence: 0, cancelled: false, hubHost: 'hub.example.invalid', stamp: at('2027-01-30T00:00:00.000Z') });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.match(ics, /\r\nUID:consultation-booking-demo-1@hub\.example\.invalid\r\n/);
  assert.match(ics, /\r\nDTSTART:20270202T170000Z\r\nDTEND:20270202T183000Z\r\n/);
  assert.match(ics, /SUMMARY:Drawing review\\, beams\\; spans/);
  for (const secret of ['Demo Street', 'Gate', '45000', 'http']) assert.ok(!ics.includes(secret), `${secret} in a calendar file`);
  assert.ok(ics.split('\r\n').every((line) => line.length <= 75));
  assert.match(k.bookingCalendar({ bookingId: 'b', title: 'x', slot, sequence: 1, cancelled: true, hubHost: 'h', stamp: at('2027-01-30T00:00:00.000Z') }), /METHOD:CANCEL[\s\S]*STATUS:CANCELLED/);
});

test('deliverable decisions and mentoring follow their rules; lists are payment-blind', () => {
  assert.equal(k.statusAfterDecision('accepted', 'video'), 'accepted');
  assert.equal(k.statusAfterDecision('rejected', 'video'), 'held');
  assert.equal(k.statusAfterDecision('rejected', 'async'), 'booked');
  assert.equal(k.DecideDeliverableCommandSchema.safeParse({ decision: 'rejected', note: null }).success, false, 'a rejection states its reason');
  assert.equal(k.PublishDeliverableCommandSchema.safeParse({ confirmNoClientData: false }).success, false);
  assert.equal(Object.keys(k.PublicDeliverableSchema.shape).some((key) => ['client', 'attachments', 'agreementId', 'bookingId', 'terms'].includes(key)), false, 'the public projection names no client');
  assert.ok(k.mentoringTransitionAllowed('proposed', 'active', 'other'));
  assert.equal(k.mentoringTransitionAllowed('proposed', 'active', 'proposer'), false, 'double opt-in');
  assert.ok(k.mentoringTransitionAllowed('proposed', 'ended', 'proposer'));
  assert.ok(k.mentoringTransitionAllowed('active', 'paused', 'proposer') && k.mentoringTransitionAllowed('paused', 'active', 'other') && k.mentoringTransitionAllowed('paused', 'ended', 'other'));
  assert.equal(k.mentoringTransitionAllowed('ended', 'active', 'other'), false);
  assert.equal(k.ProposeMentoringCommandSchema.safeParse({ counterpart: 'person-demo', myRole: 'mentee', topics: ['Framing'], terms: 'paid', offeringId: null, actor: { via: 'person' } }).success, false);
  const items = [{ id: 'b', at: '2027-01-02T00:00:00.000Z', sponsored: true }, { id: 'a', at: '2027-01-02T00:00:00.000Z', sponsored: false }, { id: 'c', at: '2027-01-03T00:00:00.000Z', sponsored: false }];
  const plain = items.map(({ id, at }) => ({ id, at }));
  assert.deepEqual(k.paymentBlindOrder(items).map((x) => x.id), k.paymentBlindOrder(plain).map((x) => x.id));
  assert.deepEqual(k.paymentBlindOrder(plain).map((x) => x.id), ['c', 'a', 'b']);
});

test('the consultation module registers every operation once in the AGT-002 shape: parity, mandate kinds, human-only decisions, localized labels', async () => {
  const manifest = k.CONSULTATION_MANIFEST;
  assert.ok(c.AgentModuleManifestSchema.safeParse(manifest).success);
  const registry = c.buildCapabilityRegistry({ registryVersion: 1, hubId: null, manifests: [manifest], extensionCapabilities: [] });
  assert.deepEqual(c.parityGaps(registry.capabilities), [], 'every capability is in the interface and the agent');
  for (const cap of registry.capabilities) {
    assert.deepEqual(c.capabilityViolations(cap), [], cap.id);
    for (const r of [cap.input, cap.output]) {
      const mod = (await import(`../../packages/contracts/src/${r.contract}.js`)) as Record<string, unknown>;
      assert.ok(mod[r.schema] && typeof (mod[r.schema] as { safeParse?: unknown }).safeParse === 'function', `${cap.id}: ${r.contract}.${r.schema}`);
    }
    if (cap.kind === 'commit') assert.ok(cap.mandateAction !== null && !cap.acceptsUntrustedText, `${cap.id} needs a mandate and structured input`);
    assert.notEqual(cap.budgetKind, 'platform', `${cap.id} charges no platform budget`);
  }
  const byId = new Map(registry.capabilities.map((x) => [x.id, x]));
  assert.equal(byId.get('consultation.accept_proposal')?.confirmation, 'person_each', 'a client books in person');
  assert.equal(byId.get('consultation.accept_proposal')?.budgetKind, 'transaction');
  assert.equal(byId.get('consultation.decide_deliverable')?.mandateAction, 'confirm_execution');
  assert.equal(byId.get('consultation.decide_deliverable')?.surfaces.includes('mcp'), false);
  assert.ok(byId.get('consultation.decide_deliverable')?.sideEffects.includes('reputation_signal'));
  // Every label key exists, with text, in every engine language.
  const root = join(import.meta.dirname, '../../apps/web/locales');
  const languages = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(languages, ['az-Latn', 'en', 'es', 'hy', 'ka', 'ru', 'uz-Latn']);
  for (const language of languages) {
    const messages = JSON.parse(readFileSync(join(root, language, 'consultations.json'), 'utf8')) as Record<string, unknown>;
    const lookup = (key: string) => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages);
    for (const cap of registry.capabilities) assert.ok(typeof lookup(cap.labelKey) === 'string' && (lookup(cap.labelKey) as string).length > 0, `${language}: ${cap.labelKey}`);
    for (const kind of k.CONSULTATION_KINDS) assert.ok(typeof lookup(`consultations.kind.${kind}`) === 'string', `${language}: kind ${kind}`);
    for (const status of k.BOOKING_STATUSES) assert.ok(typeof lookup(`consultations.bookingStatus.${status}`) === 'string', `${language}: booking status ${status}`);
    for (const status of ['checked', 'self_declared', 'expired', 'suspended', 'revoked']) assert.ok(typeof lookup(`consultations.credential.${status}`) === 'string', `${language}: credential ${status}`);
  }
});
