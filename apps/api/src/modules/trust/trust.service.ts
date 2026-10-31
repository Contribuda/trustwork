import type { z } from 'zod';
import type { Party, Principal } from '../../deps/contracts.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { iso, UUID } from '../procurement/common.js';
import { disputeOutcome } from '../execution/contracts.js';
import {
  executionAgreements, executionClaims, executionDefects, executionDisputes, performanceObservations, reputationSnapshots, reviewResponses, reviews, trustAppeals,
  type ExecutionDisputeRow, type ReputationSnapshotRow, type ReviewRow,
} from '../execution/deps.js';
import { columnsOf, mapExecutionError, partyOf } from '../execution/execution.service.js';
import {
  AgreementReviewsViewSchema, AppealViewSchema, OwnSnapshotViewSchema, PublicSnapshotViewSchema, TRUST_EVENT_PAYLOAD_KEYS,
  type AgreementReviewsView, type ComputeSnapshotCommandSchema, type FileAppealCommandSchema, type OwnSnapshotView, type PublicSnapshotView, type RespondToReviewCommandSchema,
  type SubmitReviewCommandSchema,
} from './contracts.js';
import { computeReputation, type AppealState, type DisputeState, type ReputationInputs, type ReviewRatings } from './method.js';

type In<T extends z.ZodType> = z.infer<T>;
type EventPayload = Partial<Record<(typeof TRUST_EVENT_PAYLOAD_KEYS)[number], string | number | null>>;

const TRUST_HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'trust.not_found': { code: 'access.not_found', reason: 'not_found' },
  'trust.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'trust.self_review': { code: 'access.forbidden', reason: 'self_review' },
  'trust.review_not_allowed': { code: 'validation.schema', reason: 'review_not_allowed' },
  'trust.review_exists': { code: 'validation.revision_conflict', reason: 'review_exists' },
  'trust.appeal_kind': { code: 'validation.schema', reason: 'appeal_kind' },
};
function mapTrustError(error: unknown): never {
  const pg = error as { code?: string; hint?: string };
  const mapped = pg && typeof pg.code === 'string' && pg.hint ? TRUST_HINTS[pg.hint] : undefined;
  if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
  return mapExecutionError(error);
}
const appealState = (status: string | undefined): AppealState => {
  if (status === undefined || status === 'withdrawn') return null;
  if (status === 'submitted' || status === 'in_review') return 'pending';
  return status as AppealState;
};
const disputeState = (d: ExecutionDisputeRow | undefined): DisputeState => {
  if (!d) return null;
  if (d.status === 'open' || d.status === 'appealed') return 'pending';
  return disputeOutcome({ status: d.status, decision: d.decision, appealDecision: d.appeal_decision });
};

export interface TrustServiceOptions {
  /** The hub this API serves (TRUSTWORK_HUB_ID): appeals are filed in that hub's queue. */
  hubId: string | null | (() => string | null);
}

/**
 * Reviews of completed agreements, appeals of reviews and observations, and explainable reputation snapshots
 * (EXE-001). Reviews and responses are the person's own acts (no agent path). A snapshot is computed for the subject
 * the principal acts for, from the evidence that subject can read as a party, under the published method; the public
 * reads only the masked summary. Nothing here reads a billing table, so paying the platform cannot change a snapshot.
 */
export class TrustService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly options: TrustServiceOptions) {}

  private now(): Date {
    return this.ctx.clock.now();
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapTrustError);
  }
  private actsFor(principal: Principal, party: Party): boolean {
    if (party.kind === 'person') return party.id === principal.personId;
    return principal.membership?.companyId === party.id && principal.membership.permissions.includes('company.deals.manage');
  }
  private async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }
  private async event(trx: Transaction, aggregateKind: string, aggregateId: string, type: string, payload: EventPayload): Promise<void> {
    for (const key of Object.keys(payload)) if (!(TRUST_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`event payload key ${key} is not an identifier`);
    await outbox.append(trx, { aggregate_kind: aggregateKind, aggregate_id: aggregateId, revision: 1, type, payload });
  }
  private async partyAgreement(trx: Transaction, agreementId: string) {
    if (!UUID.test(agreementId)) throw new ApiError('access.not_found');
    const side = await executionAgreements.side(trx, agreementId);
    const row = side ? await executionAgreements.get(trx, agreementId) : undefined;
    if (!side || !row) throw new ApiError('access.not_found');
    return { side, row };
  }

  /* ---------- Reviews ---------- */

  private async reviewsView(trx: Transaction, agreementId: string, side: 'buyer' | 'seller'): Promise<AgreementReviewsView> {
    const [rows, responses, completed] = await Promise.all([reviews.listFor(trx, agreementId), reviewResponses.listFor(trx, agreementId), executionAgreements.completed(trx, agreementId)]);
    const appeals = await trustAppeals.states(trx, 'review', rows.map((r) => r.id));
    const correctedBy = new Map(rows.filter((r) => r.corrects_review_id).map((r) => [r.corrects_review_id as string, r.id]));
    return AgreementReviewsViewSchema.parse({
      projection: 'shared_party', agreementId, side, completed,
      reviews: rows.map((r) => {
        const response = responses.find((x) => x.review_id === r.id);
        return {
          id: r.id, agreementId: r.agreement_id, authorSide: r.author_side, author: partyOf(r.author_person_id, r.author_company_id), subject: partyOf(r.subject_person_id, r.subject_company_id),
          ratings: r.ratings, text: r.text, language: r.language, correctsReviewId: r.corrects_review_id, correctedBy: correctedBy.get(r.id) ?? null, appeal: appeals.get(r.id) ?? null,
          response: response ? { id: response.id, responder: partyOf(response.responder_person_id, response.responder_company_id), text: response.text, createdAt: iso(response.created_at) } : null,
          createdAt: iso(r.created_at),
        };
      }),
    });
  }

  async listReviews(agreementId: string, state: RequestState): Promise<AgreementReviewsView> {
    return this.run(state, async (trx) => {
      const { side } = await this.partyAgreement(trx, agreementId);
      return this.reviewsView(trx, agreementId, side);
    });
  }

  async submitReview(agreementId: string, input: In<typeof SubmitReviewCommandSchema>, state: RequestState): Promise<AgreementReviewsView> {
    return this.run(state, async (trx, p) => {
      const { side, row } = await this.partyAgreement(trx, agreementId);
      if (!this.actsFor(p, input.author)) throw new ApiError('access.forbidden', 'reviews are written for a party you act for', { reason: 'not_authorised' });
      const author = columnsOf(input.author);
      const subject = side === 'buyer' ? { person: row.seller_person_id, company: row.seller_company_id } : { person: row.buyer_person_id, company: row.buyer_company_id };
      const review = await reviews.insert(trx, {
        agreement_id: agreementId, author_side: side, author_person_id: author.person, author_company_id: author.company, subject_person_id: subject.person, subject_company_id: subject.company,
        written_by_person_id: p.personId, ratings: input.ratings as Record<string, number>, text: input.text, language: input.language, corrects_review_id: input.correctsReviewId,
      });
      await this.audit(trx, p, state, input.correctsReviewId ? 'trust.review_corrected' : 'trust.review_published', 'review', review.id, { agreementId, side, corrects: input.correctsReviewId });
      await this.event(trx, 'review', review.id, 'trust.review_published', { agreementId, reviewId: review.id });
      return this.reviewsView(trx, agreementId, side);
    });
  }

  async respond(reviewId: string, input: In<typeof RespondToReviewCommandSchema>, state: RequestState): Promise<AgreementReviewsView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(reviewId)) throw new ApiError('access.not_found');
      const review = await reviews.get(trx, reviewId);
      if (!review) throw new ApiError('access.not_found');
      const { side } = await this.partyAgreement(trx, review.agreement_id);
      if (!this.actsFor(p, input.responder)) throw new ApiError('access.forbidden', 'responses are written for a party you act for', { reason: 'not_authorised' });
      const responder = columnsOf(input.responder);
      const response = await reviewResponses.insert(trx, { review_id: reviewId, agreement_id: review.agreement_id, responder_person_id: responder.person, responder_company_id: responder.company, written_by_person_id: p.personId, text: input.text });
      await this.audit(trx, p, state, 'trust.review_answered', 'review_response', response.id, { reviewId, agreementId: review.agreement_id });
      await this.event(trx, 'review', reviewId, 'trust.review_answered', { agreementId: review.agreement_id, reviewId, responseId: response.id });
      return this.reviewsView(trx, review.agreement_id, side);
    });
  }

  /* ---------- Appeals ---------- */

  async fileAppeal(input: In<typeof FileAppealCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const hubId = typeof this.options.hubId === 'function' ? this.options.hubId() : this.options.hubId;
      if (!hubId) throw new ApiError('validation.schema', 'appeals need the hub this API serves (TRUSTWORK_HUB_ID)', { reason: 'hub_not_configured' });
      if (!UUID.test(input.subject.id)) throw new ApiError('access.not_found');
      const appeal = await trustAppeals.file(trx, { hubId, subjectKind: input.subject.kind, subjectId: input.subject.id, reason: input.reason });
      await this.audit(trx, p, state, 'trust.appeal_filed', 'appeal', appeal.id, { subject: input.subject });
      await this.event(trx, 'appeal', appeal.id, 'trust.appeal_filed', { appealId: appeal.id, subjectKind: input.subject.kind, subjectId: input.subject.id });
      return AppealViewSchema.parse({ id: appeal.id, subject: input.subject, status: appeal.status, filedAt: iso(appeal.filed_at) });
    });
  }

  /* ---------- Snapshots ---------- */

  /** Gathers the evidence about a subject the principal acts for (as a party it can read all of it) and computes. */
  async gather(trx: Transaction, subject: Party): Promise<ReputationInputs> {
    const cols = columnsOf(subject);
    const agreementIds = await trx.selectFrom('agreement').select(['id']).where('status', 'in', ['accepted_by_both', 'superseded'])
      .where((eb) => (cols.person
        ? eb.or([eb('buyer_person_id', '=', cols.person), eb('seller_person_id', '=', cols.person)])
        : eb.or([eb('buyer_company_id', '=', cols.company), eb('seller_company_id', '=', cols.company)])))
      .orderBy('id').execute();
    // Task milestone decisions are materialized lazily; the result does not depend on when this runs.
    for (const a of agreementIds) await executionAgreements.observe(trx, a.id);
    const [observationRows, defectRows, reviewRows, taskReviewRows, owed] = await Promise.all([
      performanceObservations.listAbout(trx, cols), executionDefects.listAbout(trx, cols), reviews.listAbout(trx, cols), reviews.taskReviewsAbout(trx, cols), executionAgreements.owedBy(trx, cols),
    ]);
    const confirmationIds = observationRows.filter((o) => o.source_kind === 'execution_confirmation').map((o) => o.source_id);
    const [observationDisputes, defectDisputes, observationAppeals, reviewAppeals, remedies] = await Promise.all([
      executionDisputes.listForTargets(trx, 'confirmation', [...new Set(confirmationIds)]), executionDisputes.listForTargets(trx, 'defect', defectRows.map((d) => d.id)),
      trustAppeals.states(trx, 'performance_observation', observationRows.map((o) => o.id)), trustAppeals.states(trx, 'review', reviewRows.map((r) => r.id)),
      executionDefects.remediations(trx, defectRows.map((d) => d.id)),
    ]);
    const claimedObligations = new Set<string>();
    for (const a of agreementIds) for (const c of await executionClaims.listFor(trx, a.id)) if (c.obligation_id) claimedObligations.add(c.obligation_id);
    for (const o of observationRows) if (o.obligation_id) claimedObligations.add(o.obligation_id);
    const disputeFor = (rows: ExecutionDisputeRow[], id: string) => rows.find((d) => d.target_id === id);
    const correctedBy = new Map(reviewRows.filter((r) => r.corrects_review_id).map((r) => [r.corrects_review_id as string, r.id]));
    const liveAgreements = new Set(agreementIds.map((a) => a.id));
    return {
      subject,
      observations: observationRows.map((o) => ({
        id: o.id, dimension: o.dimension, outcome: o.outcome, excludedReason: o.excluded_reason, lateDays: o.late_days, createdAt: iso(o.created_at),
        dispute: o.source_kind === 'execution_confirmation' ? disputeState(disputeFor(observationDisputes, o.source_id)) : null, appeal: appealState(observationAppeals.get(o.id)),
      })),
      defects: defectRows.map((d) => ({
        id: d.id, severity: d.severity, createdAt: iso(d.created_at), dispute: disputeState(disputeFor(defectDisputes, d.id)),
        resolved: remedies.some((r) => r.defect_id === d.id && r.decision === 'accepted' && !r.superseded),
      })),
      reviews: [
        ...reviewRows.map((r: ReviewRow) => ({
          id: r.id, source: 'trust' as const, agreementId: r.agreement_id, authorSide: r.author_side, ratings: r.ratings as ReviewRatings, hasText: r.text !== null,
          correctedBy: correctedBy.get(r.id) ?? null, createdAt: iso(r.created_at), appeal: appealState(reviewAppeals.get(r.id)),
        })),
        ...taskReviewRows.map((r) => ({
          id: r.id, source: 'task' as const, agreementId: r.agreement_id, authorSide: r.author_side === 'owner' ? 'buyer' as const : 'seller' as const, ratings: { overall: r.rating },
          hasText: false, correctedBy: null, createdAt: iso(r.created_at), appeal: null,
        })),
      ],
      owed: owed.filter((o) => o.kind !== 'accept' && liveAgreements.has(o.agreement_id)).map((o) => ({ id: o.id, due: o.due ? iso(o.due) : null, hasRecord: claimedObligations.has(o.id) })),
    };
  }

  private ownView(row: ReputationSnapshotRow): OwnSnapshotView {
    return OwnSnapshotViewSchema.parse({
      projection: 'owner_private', id: row.id, subject: partyOf(row.subject_person_id, row.subject_company_id), method: { version: row.method_version, digest: row.method_digest },
      summary: row.summary, explanation: row.explanation, inputsDigest: row.inputs_digest, computedAt: iso(row.computed_at),
    });
  }

  async computeSnapshot(input: In<typeof ComputeSnapshotCommandSchema>, state: RequestState): Promise<OwnSnapshotView> {
    return this.run(state, async (trx, p) => {
      if (!this.actsFor(p, input.subject)) throw new ApiError('access.forbidden', 'snapshots are computed for yourself or the company you act for', { reason: 'not_authorised' });
      const inputs = await this.gather(trx, input.subject);
      const result = computeReputation(inputs, this.now());
      const cols = columnsOf(input.subject);
      const row = await reputationSnapshots.insert(trx, {
        subject_person_id: cols.person, subject_company_id: cols.company, method_version: result.summary.method.version, method_digest: result.summary.method.digest,
        summary: result.summary, public_summary: result.publicSummary, explanation: result.explanation, inputs_digest: result.inputsDigest, computed_by_person_id: p.personId,
      });
      await this.audit(trx, p, state, 'trust.snapshot_computed', 'reputation_snapshot', row.id, { subject: input.subject, method: result.summary.method.version, inputsDigest: result.inputsDigest });
      await this.event(trx, 'reputation_snapshot', row.id, 'trust.snapshot_computed', { snapshotId: row.id, subjectKind: input.subject.kind, subjectId: input.subject.id });
      return this.ownView(row);
    });
  }

  async ownSnapshot(subject: Party, state: RequestState): Promise<OwnSnapshotView> {
    return this.run(state, async (trx, p) => {
      if (!this.actsFor(p, subject)) throw new ApiError('access.not_found');
      const row = await reputationSnapshots.latestOwn(trx, columnsOf(subject));
      if (!row) throw new ApiError('access.not_found');
      return this.ownView(row);
    });
  }

  /** Anyone, signed in or not: the masked public summary of the latest snapshot, or null when none exists. */
  async publicSnapshot(subject: Party, state: RequestState): Promise<PublicSnapshotView> {
    if (!UUID.test(subject.id)) throw new ApiError('access.not_found');
    const read = async (trx: Transaction): Promise<PublicSnapshotView> => {
      const row = await reputationSnapshots.latestPublic(trx, columnsOf(subject));
      return PublicSnapshotViewSchema.parse({
        projection: 'public', subject,
        snapshot: row ? { method: { version: row.method_version, digest: row.method_digest }, summary: row.public_summary, computedAt: iso(row.computed_at), newerEvidence: row.newer_evidence } : null,
      });
    };
    return (state.principal ? this.principals.runAs(state, (trx) => read(trx)) : withoutPrincipal(this.ctx.pool, read)).catch(mapTrustError);
  }
}
