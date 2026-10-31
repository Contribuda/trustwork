import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type DataPool, type Transaction } from '@trustwork/data';
import { computeAgreementDigest, computeDigest, computeQuoteVersionDigest, computeRfqVersionDigest, type QuoteVersionPayload } from '@trustwork/contracts';
import { deriveObligations } from '../../packages/contracts/src/deals.js';
import type { PlanContent, PlanItem } from '../../packages/contracts/src/plans.js';
import { planVersionDigestInput } from '../../packages/contracts/src/plans.js';
import { rfqInvitations, rfqPrivate, rfqs, rfqVersions } from '../../packages/data/src/repositories/commerce.js';
import { budgets, reservations } from '../../packages/data/src/repositories/billing.js';
import { acceptanceEvents, agreements, obligations, orders, quoteLines, quotes, quoteVersions, taxDeterminations } from '../../packages/data/src/repositories/transactions.js';
import { planChanges, planParts, plans, planVersions } from '../../packages/data/src/repositories/plans.js';
import { adminSetup, staffAssignments, staffRoleDefinitions, type CommandContext } from '../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../packages/data/src/repositories/identity.js';
import type { AgreementRow, ObligationRow } from '../../packages/data/src/schema/transactions.js';
import { principalFor } from '../data/helpers/seed.js';

/**
 * Synthetic fixtures for the EXE-001 suites: a goods-and-works agreement between a homeowner (Petr) and the synthetic
 * supplier company (Boris holds company.deals.manage) accepted by both through the real COM-002 path, evidence
 * artifacts on that agreement, plan changes with cause and accountable party, and two synthetic trust reviewers. Every
 * name is labelled synthetic; nothing claims a real company, rating or review.
 */
export interface Fixture { admin: DataPool; app: DataPool; people: { petr: string; boris: string; carl: string; xenia: string; anna: string }; supplier: string; project: string }

const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const digest = (value: string) => ({ algorithm: 'trustwork-digest-1' as const, value });
export const as = async <T>(f: Fixture, personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(f.app, await principalFor(f.admin, personId), fn);
/** The calendar date `days` from today in Los Angeles (business dates carry their zone). */
export function businessDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

const rfqPayload = (title: string) => ({
  title, currency: 'USD', responseDeadline: new Date(Date.now() + 30 * 86_400_000).toISOString(), attachments: [], paymentTermsRequested: null, acceptanceCriteria: 'Level within 3 mm per metre',
  deliveryTerms: { location: { region: 'US-CA' }, window: { from: { date: businessDate(-60), timeZone: 'America/Los_Angeles' }, to: { date: businessDate(60), timeZone: 'America/Los_Angeles' } } },
  lines: [
    { lineId: 'l1', kind: 'goods', description: 'Synthetic concrete pavers', specification: { colour: 'grey' }, quantity: { value: '40', unit: 'm2' }, alternativesAllowed: false },
    { lineId: 'l2', kind: 'works', description: 'Synthetic paver laying', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false },
  ],
});
function quotePayload(due: string): QuoteVersionPayload {
  return {
    currency: 'USD', paymentTerms: 'Net 30', validity: { until: new Date(Date.now() + 60 * 86_400_000).toISOString() }, exclusions: [], attachments: [],
    deliveryTerms: { milestones: [{ description: 'Delivery and laying', due: { date: due, timeZone: 'America/Los_Angeles' } }], location: 'Synthetic site, San Diego County' },
    totals: { net: usd('170000'), tax: usd('0'), gross: usd('170000') },
    lines: [
      { lineId: 'q1', rfqLineId: 'l1', kind: 'goods', specSnapshot: { colour: 'grey' }, offeringVersionRef: null, quantity: { value: '40', unit: 'm2' }, unitPrice: usd('3000'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd('120000'), substitution: null, options: [] },
      { lineId: 'q2', rfqLineId: 'l2', kind: 'works', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'ls' }, unitPrice: usd('50000'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd('50000'), substitution: null, options: [] },
    ],
  };
}

/**
 * An RFQ by Petr, a quote by the supplier with one milestone due on `due`, the agreement accepted by both (buyer
 * acceptance, a budget-reserved order, seller acceptance) and the obligations derived from the accepted terms:
 * deliver (supplier), perform (supplier), pay (Petr), accept (Petr).
 */
export async function buildAgreement(f: Fixture, due: string, title = 'Synthetic patio'): Promise<{ agreement: AgreementRow; obligations: ObligationRow[]; byKind: Record<'deliver' | 'perform' | 'pay' | 'accept', ObligationRow> }> {
  const { petr, boris } = f.people;
  const payload = quotePayload(due);
  const { rfqId, version } = await as(f, petr, async (trx) => {
    const rfq = await rfqs.insert(trx, { owner_person_id: petr, owner_company_id: null, project_id: null, creator_person_id: petr, need_id: null, plan_project_id: null, plan_item_key: null, public_projection_enabled: false, public_projection_fields: [], category: null });
    await rfqPrivate.insert(trx, { rfq_id: rfq.id, owner_person_id: petr, owner_company_id: null, budget_ceiling_minor: '9000000', budget_ceiling_currency: 'USD', evaluation_weights: {}, internal_notes: 'PRIVATE-ceiling', shortlist: [], updated_by_person_id: petr });
    const v1 = await rfqVersions.insertDraft(trx, { rfq_id: rfq.id, version: 1, payload: rfqPayload(title), drafted_by_person_id: petr, amendment_reason: null });
    await rfqs.lock(trx, rfq.id);
    const published = await rfqVersions.publish(trx, v1.id, { digest: computeRfqVersionDigest(rfqPayload(title) as never).value, personId: petr, via: 'person', mandateId: null, amendmentReason: null, at: new Date() });
    await rfqs.setCurrent(trx, rfq.id, { current_version: 1, current_version_id: v1.id });
    return { rfqId: rfq.id, version: published! };
  });
  const rv = { id: version.id, version: 1, digest: version.digest as string };
  const invitation = await as(f, petr, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv.id, party_person_id: null, party_company_id: f.supplier, channel: 'platform', sent_by_person_id: petr, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null }));
  const { quote, sent } = await as(f, boris, async (trx) => {
    const quote = await quotes.insert(trx, { rfq_id: rfqId, seller_person_id: null, seller_company_id: f.supplier, invitation_id: invitation.id, creator_person_id: boris });
    const draft = await quoteVersions.insertDraft(trx, { quote_id: quote.id, version: 1, rfq_id: rfqId, rfq_version_id: rv.id, rfq_version: 1, rfq_version_digest: rv.digest, payload, drafted_by_person_id: boris, revalidated_from: null, answers_amendment_request_id: null });
    await quotes.lock(trx, quote.id);
    const taxes = await taxDeterminations.insertMany(trx, quote.id, draft.id, boris, payload.lines.map((l) => ({ line_id: l.lineId, jurisdiction: 'US-CA', rule_ref: 'seller-stated:none', rate: null, included: false, taxability: 'not_applicable' as const, exemption_ref: null, provider: 'seller_stated' as const })));
    await quoteLines.insertMany(trx, quote.id, draft.id, payload.lines.map((l, position) => ({
      position, line_id: l.lineId, rfq_line_id: l.rfqLineId, kind: l.kind, spec_snapshot: l.specSnapshot, offering_ref: null, offering_version: null, quantity_value: l.quantity.value, quantity_unit: l.quantity.unit,
      currency: 'USD', unit_price_minor: l.unitPrice.minorUnits, tax_determination_id: taxes.find((x) => x.line_id === l.lineId)!.id, tax_amount_minor: l.taxAmount.minorUnits, line_total_minor: l.lineTotal.minorUnits,
    })));
    const sent = await quoteVersions.send(trx, draft.id, { digest: computeQuoteVersionDigest({ id: rv.id, version: 1, digest: digest(rv.digest) }, payload).value, personId: boris, via: 'person', mandateId: null, validUntil: payload.validity.until, at: new Date() });
    await quotes.setCurrent(trx, quote.id, { status: 'sent', current_version: sent!.version, current_version_id: sent!.id, invitation_id: invitation.id, clearStale: true });
    return { quote, sent: sent! };
  });
  const termsDigest = computeAgreementDigest({ id: sent.id, version: 1, digest: digest(sent.digest as string) }, { id: rv.id, version: 1, digest: digest(rv.digest) }).value;
  const eventRow = (a: AgreementRow, kind: 'buyer_accepts_terms' | 'seller_accepts_order', actor: string, party: { person: string | null; company: string | null }) => ({
    agreement_id: a.id, kind, terms_kind: a.terms_kind, quote_version_id: a.quote_version_id, rfq_version_id: a.rfq_version_id, offer_version: a.offer_version, offer_digest: a.offer_digest,
    request_version: a.request_version, request_digest: a.request_digest, accepted_terms_digest: a.accepted_terms_digest, actor_person_id: actor, on_behalf_person_id: party.person,
    on_behalf_company_id: party.company, via: 'person' as const, mandate_id: null, transaction_budget_id: null, reservation_id: null, platform_budget_id: null, e_records_required: true,
    e_records_disclosure_key: 'us.electronic-records.v1', e_records_basis: ['US:eSignature/esign-act'], e_records_consented_at: new Date(), reason: null, idempotency_key: `exe-${randomUUID()}`,
  });
  const proposed = await as(f, petr, async (trx) => {
    const row = await agreements.insert(trx, {
      buyer_person_id: petr, buyer_company_id: null, seller_person_id: null, seller_company_id: f.supplier, rfq_id: rfqId, quote_id: quote.id, quote_version_id: sent.id, rfq_version_id: rv.id,
      offer_version: 1, offer_digest: sent.digest as string, request_version: 1, request_digest: rv.digest, accepted_terms_digest: termsDigest, status: 'accepted_by_buyer', supersedes_id: null, created_by_person_id: petr,
    });
    await acceptanceEvents.insert(trx, eventRow(row, 'buyer_accepts_terms', petr, { person: petr, company: null }));
    return row;
  });
  const gross = payload.totals.gross.minorUnits;
  const budgetId = await as(f, petr, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, periodFrom: '2026-01-01T00:00:00Z', periodTo: '2030-01-01T00:00:00Z', limitMinor: '100000000', currency: 'USD' }));
  const order = await as(f, petr, async (trx) => {
    const r = await reservations.reserve(trx, { budgetId, kind: 'transaction', amountMinor: gross, currency: 'USD', actionIntentId: proposed.id, correlationKey: `order-${proposed.id}`, projectId: null, ttlSeconds: 3600 });
    return orders.insert(trx, { agreement_id: proposed.id, accepted_terms_digest: termsDigest, context_kind: 'rfq', context_id: rfqId, external_reference: null, amount_minor: gross, currency: 'USD', transaction_budget_id: budgetId, reservation_id: r.id, placed_by_person_id: petr, placed_via: 'person', placed_mandate_id: null });
  });
  const agreement = await as(f, boris, async (trx) => {
    await acceptanceEvents.insert(trx, eventRow(proposed, 'seller_accepts_order', boris, { person: null, company: f.supplier }));
    const accepted = await agreements.setStatus(trx, proposed.id, proposed.revision, { status: 'accepted_by_both' });
    await orders.setStatus(trx, order.id, order.revision, { status: 'accepted' });
    await quoteVersions.setStatus(trx, sent.id, 'sent', 'accepted');
    await quotes.setStatus(trx, quote.id, null, { status: 'accepted', withdrawn_reason: null });
    const derived = deriveObligations({ buyer: { kind: 'person', id: petr }, seller: { kind: 'company', id: f.supplier } }, payload);
    await obligations.insertMany(trx, proposed.id, derived.map((o, position) => ({
      position, obligor_person_id: o.party.kind === 'person' ? o.party.id : null, obligor_company_id: o.party.kind === 'company' ? o.party.id : null, kind: o.kind, due: o.due,
      amount_minor: o.amount?.minorUnits ?? null, currency: o.amount?.currency ?? null, scope_value: null, scope_unit: null,
    })));
    return accepted!;
  });
  assert.equal(agreement.status, 'accepted_by_both');
  const rows = await as(f, petr, (trx) => obligations.listFor(trx, agreement.id));
  const byKind = Object.fromEntries(rows.map((o) => [o.kind, o])) as Record<'deliver' | 'perform' | 'pay' | 'accept', ObligationRow>;
  return { agreement, obligations: rows, byKind };
}

/** A FILE-001 evidence artifact on the agreement (inserted by the owner role, scan clean), with its sha256. */
export async function artifactOn(f: Fixture, agreementId: string, owner: { person?: string; company?: string }, uploader: string, classification: 'shared' | 'party_private' = 'shared'): Promise<{ id: string; sha256: string }> {
  const sha256 = createHash('sha256').update(randomBytes(16)).digest('hex');
  return withMaintenance(f.admin, async (trx) => {
    const row = await trx.insertInto('evidence_artifact').values({
      owner_person_id: owner.person ?? null, owner_company_id: owner.company ?? null, parent_kind: 'agreement', parent_id: agreementId, classification, storage_key: `synthetic/${randomUUID()}.jpg`,
      sha256, bytes: 1024, media_type: 'image/jpeg', uploaded_by: uploader, scan_state: 'clean',
    }).returning('id').executeTakeFirstOrThrow();
    return { id: row.id, sha256 };
  });
}

/* ---------- Plans: a baseline and approved changes with cause and accountable party ---------- */

const item = (over: Partial<PlanItem> & Pick<PlanItem, 'key' | 'kind'>): PlanItem => ({
  parentKey: null, title: `Step ${over.key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null,
  decisionQuestion: null, sources: [], attachments: [], privateNotes: null, ...over,
});
const PLAN: PlanContent = {
  summary: 'Synthetic patio plan', assumptions: [], budget: null, timeline: null, dependencies: [],
  items: [item({ key: 'patio', kind: 'task', title: 'Lay the patio', stepTerms: ['work.envelope.roofing'] })],
};
export async function baselinePlan(f: Fixture): Promise<{ planId: string; currentVersionId: string }> {
  const { petr } = f.people;
  return as(f, petr, async (trx) => {
    const plan = await plans.insert(trx, { project_id: f.project, time_zone: 'America/Los_Angeles', created_by_person_id: petr, drafted_via: 'person', drafted_mandate_id: null });
    const draft = await planVersions.insertDraft(trx, { plan_id: plan.id, project_id: f.project, version: 1, content: PLAN, based_on_version_id: null, drafted_by_person_id: petr, drafted_via: 'person', drafted_mandate_id: null });
    await planVersions.lock(trx, draft.id);
    await planParts.materialise(trx, draft.id, PLAN);
    await planVersions.propose(trx, draft.id, { digest: computeDigest(planVersionDigestInput({ planId: plan.id, version: 1, content: PLAN })).value, personId: petr, via: 'person', mandateId: null, at: new Date() });
    await planVersions.approve(trx, draft.id, { personId: petr, at: new Date(), changeId: null });
    await plans.setBaseline(trx, plan.id, draft.id);
    return { planId: plan.id, currentVersionId: draft.id };
  });
}
/** The next plan version with an approved change naming the agreement (cause, accountable party, schedule impact). */
export async function approvedChange(f: Fixture, plan: { planId: string; currentVersionId: string }, input: {
  agreementId: string | null; cause: 'owner_request' | 'counterparty' | 'site_condition' | 'regulatory' | 'external' | 'unknown'; accountable: { person?: string; company?: string }; impactDays: number;
}): Promise<{ changeId: string }> {
  const { petr } = f.people;
  const versions = await as(f, petr, (trx) => planVersions.listForPlan(trx, plan.planId));
  const next = Math.max(...versions.map((v) => v.version)) + 1;
  return as(f, petr, async (trx) => {
    const draft = await planVersions.insertDraft(trx, { plan_id: plan.planId, project_id: f.project, version: next, content: PLAN, based_on_version_id: plan.currentVersionId, drafted_by_person_id: petr, drafted_via: 'person', drafted_mandate_id: null });
    await planVersions.lock(trx, draft.id);
    await planParts.materialise(trx, draft.id, PLAN);
    await planVersions.propose(trx, draft.id, { digest: computeDigest(planVersionDigestInput({ planId: plan.planId, version: next, content: PLAN })).value, personId: petr, via: 'person', mandateId: null, at: new Date() });
    const change = await planChanges.insert(trx, {
      plan_id: plan.planId, project_id: f.project, from_version_id: plan.currentVersionId, to_version_id: draft.id, reason: `PRIVATE-change-reason ${input.cause}`, cause: input.cause,
      requested_by_person_id: petr, requested_by_company_id: null, accountable_person_id: input.accountable.person ?? null, accountable_company_id: input.accountable.company ?? null,
      agreement_id: input.agreementId, schedule_impact_days: input.impactDays, created_by_person_id: petr,
    });
    await planVersions.supersede(trx, plan.currentVersionId, { byVersionId: draft.id, reason: 'replaced', at: new Date() });
    await planVersions.approve(trx, draft.id, { personId: petr, at: new Date(), changeId: change.id });
    await plans.setBaseline(trx, plan.planId, draft.id);
    await planChanges.decide(trx, change.id, 1, { status: 'approved', personId: petr, at: new Date() });
    plan.currentVersionId = draft.id;
    return { changeId: change.id };
  });
}

/* ---------- Staff: two synthetic trust reviewers of a synthetic hub ---------- */

export interface StaffWorld { hubId: string; reviewerA: string; reviewerB: string; outsiderStaff: string; elevate(personId: string): Promise<CommandContext> }
export async function staffWorld(f: Fixture, hubId: string | null = null): Promise<StaffWorld> {
  const ids = await withMaintenance(f.admin, async (trx) => {
    for (const def of [
      { role: 'platform-owner' as const, scopes: ['platform' as const], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read'] as never[] },
      { role: 'trust-reviewer' as const, scopes: ['hub' as const], permissions: ['admin.trust.evidence.decide', 'admin.trust.appeals.decide'] as never[] },
      { role: 'moderator' as const, scopes: ['hub' as const], permissions: ['admin.moderation.read'] as never[] },
    ]) {
      await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: def.scopes, permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    await adminSetup.createNode(trx, 'Synthetic test node');
    const hub = hubId
      ? (await trx.insertInto('hub').values({ id: hubId, slug: `synthetic-${randomBytes(3).toString('hex')}`, lifecycle: 'public' }).returning('id').executeTakeFirstOrThrow()).id
      : (await trx.insertInto('hub').values({ slug: `synthetic-${randomBytes(3).toString('hex')}`, lifecycle: 'public' }).returning('id').executeTakeFirstOrThrow()).id;
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    const owner = await person('Synthetic Platform Owner');
    const reviewerA = await person('Synthetic Trust Reviewer A');
    const reviewerB = await person('Synthetic Trust Reviewer B');
    const outsiderStaff = await person('Synthetic Moderator');
    const sessions: Record<string, string> = {};
    for (const id of [owner, reviewerA, reviewerB, outsiderStaff]) {
      sessions[id] = (await trx.insertInto('session').values({ person_id: id, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow()).id;
    }
    await adminSetup.bootstrapFirstAdmin(trx, { personId: owner, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    return { hub, owner, reviewerA, reviewerB, outsiderStaff, sessions };
  });
  const elevate = async (personId: string): Promise<CommandContext> => {
    const elevation = await as(f, personId, (trx) => sessionElevations.insert(trx, { sessionId: ids.sessions[personId] as string, personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) }));
    return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic test decision' };
  };
  const ownerCtx = await elevate(ids.owner);
  for (const [personId, role] of [[ids.reviewerA, 'trust-reviewer'], [ids.reviewerB, 'trust-reviewer'], [ids.outsiderStaff, 'moderator']] as const) {
    await as(f, ids.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { personId, role, scope: { kind: 'hub', hubId: ids.hub }, definitionVersion: 1 }));
  }
  return { hubId: ids.hub, reviewerA: ids.reviewerA, reviewerB: ids.reviewerB, outsiderStaff: ids.outsiderStaff, elevate };
}

interface PgError { code?: string; hint?: string; message?: string }
/** Fails unless the promise rejects with the SQLSTATE or guard hint. */
export async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}
