import assert from 'node:assert/strict';
import type { Response } from '../../helpers/app.js';
import { screenClear } from '../../../consultations/helpers.js';
import type { CrashCase } from '../cases.js';

/**
 * CONS-001: every consultation route completes its idempotency record in its own transaction, crashed before and after
 * the commit. Petr asks, Carl (a person expert) offers, proposes, confirms and delivers; both are screened clear
 * against the synthetic baseline lists first because the consultation gate fails closed for anyone unscreened. Every
 * name, offering and price is synthetic.
 */
export default {
  name: 'CONS-001: consultation offerings, requests, bookings, deliverables and mentoring',
  async run({ h, seed, as, exactlyOnce }) {
    const n = async (query: string, params: unknown[] = []) => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]!.n;
    const body = <T>(r: Response): T => {
      assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body));
      return r.body as T;
    };
    const P = seed.people;
    const PERSON = { via: 'person' as const };
    const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    const [petr, carl] = [await as('petr'), await as('carl')];
    await screenClear(h, [{ kind: 'person', id: P.petr }, { kind: 'person', id: P.carl }]);

    // Carl's catalogue offering of kind services, published (catalogue routes are covered by their own case).
    const catalogue = body<{ offering: { id: string; revision: number }; versions: { id: string }[] }>(await carl.post('/v1/catalogue', {
      owner: { kind: 'person', id: P.carl }, kind: 'services', actor: PERSON,
      draft: {
        payload: { title: 'Exactly once advice', description: null, specification: {}, unit: 'h', listPrice: { minorUnits: '12000', currency: 'USD' }, options: [], availability: { state: 'available', capacity: null, observedAt: new Date().toISOString() }, components: [] },
        publicFields: ['title', 'listPrice'], privateKnowledge: { costBasis: null, marginTarget: null, notes: null },
      },
    }));
    body(await carl.post(`/v1/catalogue/${catalogue.offering.id}/versions/${catalogue.versions[0]!.id}/publish`, { expectedRevision: catalogue.offering.revision, actor: PERSON }));
    const offeringId = catalogue.offering.id;
    const terms = {
      kind: 'session', modes: ['video'], topics: [], regions: ['US-CA'], languages: ['en'], durationMinutes: 60, deliverableKind: 'written_advice', pricing: 'hourly',
      cancellation: { freeUntilHours: 24, lateShareBps: 5000, noShowShareBps: 10000 }, licence: { required: false, credentialId: null }, recordingOffered: false,
    };
    const offering = body<{ revision: number }>(await exactlyOnce({
      action: 'consultation.offering_register', client: carl, url: '/v1/consultation-offerings', body: { offeringId, terms, actor: PERSON },
      effects: () => n('SELECT 1 FROM trustwork.consultation_offering WHERE offering_id = $1', [offeringId]),
    }));
    await exactlyOnce({
      action: 'consultation.offering_update', client: carl, url: `/v1/consultation-offerings/${offeringId}`, body: { expectedRevision: offering.revision, terms: { ...terms, languages: ['en', 'es'] }, status: 'active', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.audit_event WHERE action = 'consultation.offering_updated' AND object_id = $1", [offeringId]),
    });

    const window = body<{ id: string }>(await exactlyOnce({
      action: 'consultation.window_open', client: carl, url: '/v1/consultation-availability', body: { startsAt: at(1), endsAt: at(5 * 60), timeZone: 'America/Los_Angeles', capacity: 10, actor: PERSON },
      effects: () => n('SELECT 1 FROM trustwork.availability_window WHERE expert_person_id = $1', [P.carl]),
    }));
    const spare = body<{ id: string; revision: number }>(await carl.post('/v1/consultation-availability', { startsAt: at(48 * 60), endsAt: at(49 * 60), timeZone: 'America/Los_Angeles', capacity: 1, actor: PERSON }));
    await exactlyOnce({
      action: 'consultation.window_close', client: carl, url: `/v1/consultation-availability/${spare.id}/close`, body: { expectedRevision: spare.revision, actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.availability_window WHERE id = $1 AND status = 'closed'", [spare.id]),
    });

    const requestBody = { source: { kind: 'direct' }, offeringId, terms: { kind: 'session', question: 'Exactly once question', fields: [], preferredModes: ['video'], preferredTimes: [], sharedMaterials: [], licenceRequired: false, languages: ['en'] }, mentoringRelationshipId: null, privateConstraint: null, actor: PERSON };
    type RequestView = { request: { id: string; revision: number; digest: unknown }; privateConstraint: { revision: number }; bookings: { id: string; revision: number; digest: unknown; status: string }[]; agreements: { id: string; revision: number; acceptedTermsDigest: unknown }[] };
    const created = body<RequestView>(await exactlyOnce({
      action: 'consultation.request_create', client: petr, url: '/v1/consultation-requests', body: requestBody,
      effects: () => n('SELECT 1 FROM trustwork.consultation_request WHERE requester_person_id = $1', [P.petr]),
    }));
    const reqA = created.request.id;
    await exactlyOnce({
      action: 'consultation.private_save', client: petr, url: `/v1/consultation-requests/${reqA}/private`, body: { budgetCeiling: { minorUnits: '50000', currency: 'USD' }, requesterNotes: null, expectedRevision: created.privateConstraint.revision },
      effects: () => n("SELECT 1 FROM trustwork.audit_event WHERE action = 'consultation.private_saved' AND object_id = $1", [reqA]),
    });
    const propose = (revision: number, startMinutes: number) => ({ expectedRevision: revision, mode: 'video', slot: { windowId: window.id, start: at(startMinutes) }, deliverableDue: null, validUntil: at(24 * 60), note: null, actor: PERSON });
    const fresh = async (requestId: string) => body<RequestView>(await petr.get(`/v1/consultation-requests/${requestId}`));
    await exactlyOnce({
      action: 'consultation.propose', client: carl, url: `/v1/consultation-requests/${reqA}/proposals`, body: propose((await fresh(reqA)).request.revision, 3),
      effects: () => n('SELECT 1 FROM trustwork.consultation_booking WHERE request_id = $1', [reqA]),
    });
    const accept = async (requestId: string) => {
      const view = await fresh(requestId);
      const b = view.bookings.find((x) => x.status === 'proposed')!;
      return { booking: { id: b.id, version: 1, digest: b.digest }, request: { id: requestId, version: 1, digest: view.request.digest }, expectedRevision: view.request.revision, recordingConsent: false, electronicRecords: CONSENT, actor: PERSON };
    };
    const acceptA = await accept(reqA);
    const accepted = body<RequestView>(await exactlyOnce({
      action: 'consultation.accept', client: petr, url: `/v1/consultation-requests/${reqA}/acceptances`, body: acceptA,
      effects: () => n("SELECT 1 FROM trustwork.agreement WHERE terms_kind = 'consultation' AND offer_ref_id = $1", [acceptA.booking.id]),
    }));
    const agreementA = accepted.agreements[0]!;
    await exactlyOnce({
      action: 'consultation.confirm', client: carl, url: `/v1/consultation-agreements/${agreementA.id}/confirm`,
      body: { expectedRevision: agreementA.revision, acceptedTermsDigest: agreementA.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.consultation_booking WHERE id = $1 AND status = 'booked'", [acceptA.booking.id]),
    });
    const bookingOf = async (id: string) => body<{ booking: { revision: number }; deliverables: { id: string }[] }>(await carl.get(`/v1/consultation-bookings/${id}`));
    await exactlyOnce({
      action: 'consultation.session_record', client: carl, url: `/v1/consultation-bookings/${acceptA.booking.id}/session`,
      body: { expectedRevision: (await bookingOf(acceptA.booking.id)).booking.revision, startedAt: at(-50), endedAt: at(-1), actor: PERSON },
      effects: () => n('SELECT 1 FROM trustwork.consultation_session WHERE booking_id = $1 AND started_at IS NOT NULL', [acceptA.booking.id]),
    });
    const delivered = body<{ deliverables: { id: string }[] }>(await exactlyOnce({
      action: 'consultation.deliver', client: carl, url: `/v1/consultation-bookings/${acceptA.booking.id}/deliverables`,
      body: { expectedRevision: (await bookingOf(acceptA.booking.id)).booking.revision, kind: 'written_advice', title: 'Exactly once advice', body: 'Use the larger beam.', attachments: [] },
      effects: () => n('SELECT 1 FROM trustwork.consultation_deliverable WHERE booking_id = $1', [acceptA.booking.id]),
    }));
    const deliverableId = delivered.deliverables[0]!.id;
    await exactlyOnce({
      action: 'consultation.deliverable_decide', client: petr, url: `/v1/consultation-deliverables/${deliverableId}/decision`, body: { decision: 'accepted', note: null },
      effects: () => n('SELECT 1 FROM trustwork.consultation_deliverable WHERE id = $1 AND decision IS NOT NULL', [deliverableId]),
    });
    await exactlyOnce({
      action: 'consultation.deliverable_publish', client: carl, url: `/v1/consultation-deliverables/${deliverableId}/publish`, body: { confirmNoClientData: true },
      effects: () => n('SELECT 1 FROM trustwork.consultation_deliverable WHERE id = $1 AND published_at IS NOT NULL', [deliverableId]),
    });

    // A proposal withdrawn by the expert, a second one declined by the client, then the request withdrawn.
    const reqB = body<RequestView>(await petr.post('/v1/consultation-requests', requestBody)).request.id;
    const proposedB = body<{ bookings: { id: string; revision: number }[] }>(await carl.post(`/v1/consultation-requests/${reqB}/proposals`, propose((await fresh(reqB)).request.revision, 90)));
    await exactlyOnce({
      action: 'consultation.proposal_withdraw', client: carl, url: `/v1/consultation-bookings/${proposedB.bookings[0]!.id}/withdraw`, body: { expectedRevision: proposedB.bookings[0]!.revision, reason: 'Exactly once withdrawal', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.consultation_booking WHERE request_id = $1 AND status = 'withdrawn'", [reqB]),
    });
    const proposedB2 = body<{ bookings: { id: string; revision: number; status: string }[] }>(await carl.post(`/v1/consultation-requests/${reqB}/proposals`, propose((await fresh(reqB)).request.revision, 100)));
    const openB = proposedB2.bookings.find((b) => b.status === 'proposed')!;
    await exactlyOnce({
      action: 'consultation.proposal_decline', client: petr, url: `/v1/consultation-bookings/${openB.id}/decline`, body: { expectedRevision: openB.revision, reason: 'Exactly once decline', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.consultation_booking WHERE request_id = $1 AND status = 'declined'", [reqB]),
    });
    await exactlyOnce({
      action: 'consultation.request_withdraw', client: petr, url: `/v1/consultation-requests/${reqB}/withdraw`, body: { expectedRevision: (await fresh(reqB)).request.revision, reason: 'Exactly once withdrawal', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.consultation_request WHERE id = $1 AND status = 'withdrawn'", [reqB]),
    });

    // A request the expert declines.
    const reqC = body<RequestView>(await petr.post('/v1/consultation-requests', requestBody)).request.id;
    await exactlyOnce({
      action: 'consultation.request_decline', client: carl, url: `/v1/consultation-requests/${reqC}/decline`, body: { expectedRevision: (await fresh(reqC)).request.revision, reason: 'Exactly once decline', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.consultation_request WHERE id = $1 AND status = 'declined'", [reqC]),
    });

    // An acceptance the client withdraws, and one the expert declines.
    const acceptedFor = async (startMinutes: number) => {
      const requestId = body<RequestView>(await petr.post('/v1/consultation-requests', requestBody)).request.id;
      body(await carl.post(`/v1/consultation-requests/${requestId}/proposals`, propose((await fresh(requestId)).request.revision, startMinutes)));
      const view = body<RequestView>(await petr.post(`/v1/consultation-requests/${requestId}/acceptances`, await accept(requestId)));
      return view.agreements[0]!;
    };
    const agreementD = await acceptedFor(110);
    await exactlyOnce({
      action: 'consultation.acceptance_withdraw', client: petr, url: `/v1/consultation-agreements/${agreementD.id}/withdraw`, body: { expectedRevision: agreementD.revision, reason: 'Exactly once withdrawal', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.agreement WHERE id = $1 AND status = 'withdrawn'", [agreementD.id]),
    });
    const agreementE = await acceptedFor(115);
    await exactlyOnce({
      action: 'consultation.agreement_decline', client: carl, url: `/v1/consultation-agreements/${agreementE.id}/decline`, body: { expectedRevision: agreementE.revision, reason: 'Exactly once decline', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.agreement WHERE id = $1 AND status = 'declined'", [agreementE.id]),
    });

    // A booking the client cancels.
    const agreementF = await acceptedFor(180);
    const bookedF = body<{ booking: { id: string; revision: number } }>(await carl.post(`/v1/consultation-agreements/${agreementF.id}/confirm`, { expectedRevision: agreementF.revision, acceptedTermsDigest: agreementF.acceptedTermsDigest, electronicRecords: CONSENT, actor: PERSON }));
    await exactlyOnce({
      action: 'consultation.cancel', client: petr, url: `/v1/consultation-bookings/${bookedF.booking.id}/cancel`, body: { expectedRevision: bookedF.booking.revision, kind: 'client', absentSide: null, reason: 'Exactly once cancellation', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.consultation_booking WHERE id = $1 AND status = 'cancelled'", [bookedF.booking.id]),
    });

    // Mentoring: proposed by the mentee, accepted by the mentor, paused.
    const relationship = body<{ id: string; revision: number }>(await exactlyOnce({
      action: 'consultation.mentoring_propose', client: petr, url: '/v1/mentoring', body: { counterpart: P.carl, myRole: 'mentee', topics: ['Exactly once mentoring'], terms: 'free', offeringId: null, actor: PERSON },
      effects: () => n('SELECT 1 FROM trustwork.mentoring_relationship WHERE mentee_person_id = $1', [P.petr]),
    }));
    const active = body<{ revision: number }>(await exactlyOnce({
      action: 'consultation.mentoring_respond', client: carl, url: `/v1/mentoring/${relationship.id}/respond`, body: { expectedRevision: relationship.revision, decision: 'accept', actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.mentoring_relationship WHERE id = $1 AND status = 'active'", [relationship.id]),
    }));
    await exactlyOnce({
      action: 'consultation.mentoring_change', client: carl, url: `/v1/mentoring/${relationship.id}/change`, body: { expectedRevision: active.revision, to: 'paused', reason: null, actor: PERSON },
      effects: () => n("SELECT 1 FROM trustwork.mentoring_relationship WHERE id = $1 AND status = 'paused'", [relationship.id]),
    });
  },
} satisfies CrashCase;
