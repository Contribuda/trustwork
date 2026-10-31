import { computeDigest, type Party } from '../../deps/contracts.js';

/**
 * Reputation method `engine-evidence-0.1` (EXE-001 prototype; policy text in docs/product/reputation-policy).
 *
 * A snapshot is an explainable evidence summary, not a score: per dimension it counts observations and states how many
 * were excluded and why. Facts (timing, quality, payment discipline, defects) and opinions (reviews) are separate
 * sections and never mixed. Below the minimum sample a dimension says "not enough data" publicly. Weights are an open
 * owner decision (ADR 012 O07), so `weights` is null and no public numeric score exists; the switch below stays off
 * until the owner decides and a method with weights is released through review. The method reads no payment,
 * entitlement, subscription, sponsorship or plan input of any kind: the same evidence always gives the same snapshot.
 */
export const REPUTATION_METHOD = Object.freeze({
  version: 'engine-evidence-0.1',
  status: 'prototype' as const,
  facts: ['timing', 'quality', 'payment', 'defects'] as const,
  opinions: ['reviews'] as const,
  /** Observations older than this are excluded (`outside_window`). */
  windowDays: 730,
  minimumSamples: Object.freeze({ timing: 3, quality: 3, payment: 3, defects: 3, reviews: 3 }),
  /** O07: open. A non-null value only ever comes from a reviewed method release. */
  weights: null as Readonly<Record<'timing' | 'quality' | 'payment' | 'reviews', number>> | null,
});
export type ReputationMethod = typeof REPUTATION_METHOD;
export const METHOD_DIGEST = computeDigest({
  version: REPUTATION_METHOD.version, facts: REPUTATION_METHOD.facts, opinions: REPUTATION_METHOD.opinions, windowDays: REPUTATION_METHOD.windowDays,
  minimumSamples: REPUTATION_METHOD.minimumSamples, weights: REPUTATION_METHOD.weights,
}).value;

/**
 * Public numeric scoring: disabled. The DATA-002 feature-flag vocabulary forbids score or ranking flags on purpose, so
 * this is a reviewed code constant; turning it on also needs a released method with weights (O07).
 */
export interface ReputationPolicy { readonly publicNumericScore: boolean }
export const REPUTATION_POLICY: ReputationPolicy = Object.freeze({ publicNumericScore: false });

export const EXCLUSION_REASONS = [
  'client_caused_change', 'external_change', 'unattributed_change', 'no_due_date', 'dispute_pending', 'dispute_overturned', 'dispute_partially_upheld', 'appeal_pending',
  'appeal_overturned', 'duplicate', 'corrected', 'outside_window',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export type DisputeState = null | 'pending' | 'upheld' | 'overturned' | 'partially';
export type AppealState = null | 'pending' | 'upheld' | 'overturned' | 'partially_overturned';
export interface ObservationInput {
  id: string; dimension: 'timing' | 'quality' | 'payment'; outcome: 'on_time' | 'late' | 'excused_delay' | 'unknown' | 'accepted' | 'partially_accepted' | 'rejected';
  excludedReason: 'client_caused_change' | 'external_change' | 'unattributed_change' | 'no_due_date' | null; lateDays: number | null; createdAt: string; dispute: DisputeState; appeal: AppealState;
}
export interface DefectInput { id: string; severity: 'minor' | 'major' | 'critical'; resolved: boolean; createdAt: string; dispute: DisputeState }
export interface ReviewRatings { overall: number; timing?: number; quality?: number; payment?: number; cooperation?: number }
export interface ReviewInput {
  id: string; source: 'trust' | 'task'; agreementId: string; authorSide: 'buyer' | 'seller'; ratings: ReviewRatings; hasText: boolean; correctedBy: string | null; createdAt: string; appeal: AppealState;
}
export interface ObligationInput { id: string; due: string | null; hasRecord: boolean }
export interface ReputationInputs { subject: Party; observations: readonly ObservationInput[]; defects: readonly DefectInput[]; reviews: readonly ReviewInput[]; owed: readonly ObligationInput[] }

type Status = 'ok' | 'not_enough_data';
type Distribution = Record<'1' | '2' | '3' | '4' | '5', number>;
export interface ReputationSummary {
  method: { version: string; digest: string };
  facts: {
    timing: { samples: number; onTime: number; late: number; lateDays: number; status: Status };
    payment: { samples: number; onTime: number; late: number; lateDays: number; status: Status };
    quality: { samples: number; accepted: number; partiallyAccepted: number; rejected: number; status: Status };
    defects: { samples: number; open: number; resolved: number; minor: number; major: number; critical: number; status: Status };
  };
  opinions: { reviews: { samples: number; overall: Distribution; timing: Distribution; quality: Distribution; payment: Distribution; cooperation: Distribution; withText: number; status: Status } };
  exclusions: Record<ExclusionReason, number>;
  /** Missing data is unknown, never zero: obligations past due without any recorded claim or decision. */
  unknown: { obligationsWithoutRecord: number };
  publicScore: number | null;
}
export type PublicDimension<T> = T | { status: 'not_enough_data' };
export interface PublicReputationSummary {
  method: { version: string; digest: string };
  facts: { [K in keyof ReputationSummary['facts']]: PublicDimension<ReputationSummary['facts'][K]> };
  opinions: { reviews: PublicDimension<Omit<ReputationSummary['opinions']['reviews'], 'withText'>> };
  exclusions: Record<ExclusionReason, number>;
  unknown: { obligationsWithoutRecord: number };
  publicScore: number | null;
}
export interface ExplanationItem { id: string; counted: boolean; reason: ExclusionReason | null; dimension: string; outcome: string }
export interface ReputationExplanation { observations: ExplanationItem[]; defects: ExplanationItem[]; reviews: ExplanationItem[]; obligationsWithoutRecord: string[] }

const emptyDistribution = (): Distribution => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
const bump = (d: Distribution, value: number | undefined) => {
  if (value !== undefined && Number.isInteger(value) && value >= 1 && value <= 5) d[String(value) as keyof Distribution] += 1;
};
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function disputeExclusion(state: DisputeState): ExclusionReason | null {
  if (state === 'pending') return 'dispute_pending';
  if (state === 'overturned') return 'dispute_overturned';
  if (state === 'partially') return 'dispute_partially_upheld';
  return null;
}
function appealExclusion(state: AppealState): ExclusionReason | null {
  if (state === 'pending') return 'appeal_pending';
  if (state === 'overturned' || state === 'partially_overturned') return 'appeal_overturned';
  return null;
}

/**
 * Computes a snapshot from evidence about one subject. Pure and deterministic for a given `now`: the same inputs give
 * the same summary and the same inputs digest, whoever pays what.
 */
export function computeReputation(inputs: ReputationInputs, now: Date, method: ReputationMethod = REPUTATION_METHOD, policy: ReputationPolicy = REPUTATION_POLICY, methodDigest: string = METHOD_DIGEST): {
  summary: ReputationSummary; publicSummary: PublicReputationSummary; explanation: ReputationExplanation; inputsDigest: string;
} {
  const windowStart = now.getTime() - method.windowDays * 86_400_000;
  const exclusions = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as Record<ExclusionReason, number>;
  const exclude = (reason: ExclusionReason | null) => {
    if (reason) exclusions[reason] += 1;
    return reason;
  };
  const outside = (createdAt: string) => Date.parse(createdAt) < windowStart;

  const timing = { samples: 0, onTime: 0, late: 0, lateDays: 0 };
  const payment = { samples: 0, onTime: 0, late: 0, lateDays: 0 };
  const quality = { samples: 0, accepted: 0, partiallyAccepted: 0, rejected: 0 };
  const observations: ExplanationItem[] = [];
  for (const o of [...inputs.observations].sort(byId)) {
    const reason = exclude(outside(o.createdAt) ? 'outside_window' : disputeExclusion(o.dispute) ?? appealExclusion(o.appeal) ?? o.excludedReason);
    observations.push({ id: o.id, counted: reason === null, reason, dimension: o.dimension, outcome: o.outcome });
    if (reason) continue;
    if (o.dimension === 'quality') {
      quality.samples += 1;
      if (o.outcome === 'accepted') quality.accepted += 1;
      else if (o.outcome === 'partially_accepted') quality.partiallyAccepted += 1;
      else quality.rejected += 1;
    } else {
      const target = o.dimension === 'timing' ? timing : payment;
      target.samples += 1;
      if (o.outcome === 'on_time') target.onTime += 1;
      else if (o.outcome === 'late') {
        target.late += 1;
        target.lateDays += o.lateDays ?? 0;
      }
    }
  }

  const defectsSummary = { samples: 0, open: 0, resolved: 0, minor: 0, major: 0, critical: 0 };
  const defects: ExplanationItem[] = [];
  for (const d of [...inputs.defects].sort(byId)) {
    const reason = exclude(outside(d.createdAt) ? 'outside_window' : disputeExclusion(d.dispute));
    defects.push({ id: d.id, counted: reason === null, reason, dimension: 'defects', outcome: d.resolved ? 'resolved' : 'open' });
    if (reason) continue;
    defectsSummary.samples += 1;
    defectsSummary[d.resolved ? 'resolved' : 'open'] += 1;
    defectsSummary[d.severity] += 1;
  }

  const reviewSummary = { samples: 0, overall: emptyDistribution(), timing: emptyDistribution(), quality: emptyDistribution(), payment: emptyDistribution(), cooperation: emptyDistribution(), withText: 0 };
  const reviews: ExplanationItem[] = [];
  const trustSides = new Set(inputs.reviews.filter((r) => r.source === 'trust').map((r) => `${r.agreementId}:${r.authorSide}`));
  for (const r of [...inputs.reviews].sort(byId)) {
    const duplicate = r.source === 'task' && trustSides.has(`${r.agreementId}:${r.authorSide}`);
    const reason = exclude(outside(r.createdAt) ? 'outside_window' : r.correctedBy ? 'corrected' : duplicate ? 'duplicate' : appealExclusion(r.appeal));
    reviews.push({ id: r.id, counted: reason === null, reason, dimension: 'reviews', outcome: String(r.ratings.overall) });
    if (reason) continue;
    reviewSummary.samples += 1;
    bump(reviewSummary.overall, r.ratings.overall);
    bump(reviewSummary.timing, r.ratings.timing);
    bump(reviewSummary.quality, r.ratings.quality);
    bump(reviewSummary.payment, r.ratings.payment);
    bump(reviewSummary.cooperation, r.ratings.cooperation);
    if (r.hasText) reviewSummary.withText += 1;
  }

  const missing = inputs.owed.filter((o) => !o.hasRecord && o.due !== null && Date.parse(o.due) + 86_400_000 < now.getTime()).map((o) => o.id).sort();
  const status = (samples: number, minimum: number): Status => (samples >= minimum ? 'ok' : 'not_enough_data');
  const min = method.minimumSamples;
  const summary: ReputationSummary = {
    method: { version: method.version, digest: methodDigest },
    facts: {
      timing: { ...timing, status: status(timing.samples, min.timing) },
      payment: { ...payment, status: status(payment.samples, min.payment) },
      quality: { ...quality, status: status(quality.samples, min.quality) },
      defects: { ...defectsSummary, status: status(defectsSummary.samples, min.defects) },
    },
    opinions: { reviews: { ...reviewSummary, status: status(reviewSummary.samples, min.reviews) } },
    exclusions,
    unknown: { obligationsWithoutRecord: missing.length },
    publicScore: null,
  };
  summary.publicScore = publicScore(summary, method, policy);
  const mask = <T extends { status: Status }>(dimension: T): PublicDimension<T> => (dimension.status === 'ok' ? dimension : { status: 'not_enough_data' });
  const { samples, overall, timing: timingStars, quality: qualityStars, payment: paymentStars, cooperation, status: reviewStatus } = summary.opinions.reviews;
  const publicReviews = { samples, overall, timing: timingStars, quality: qualityStars, payment: paymentStars, cooperation, status: reviewStatus };
  const publicSummary: PublicReputationSummary = {
    method: summary.method,
    facts: { timing: mask(summary.facts.timing), payment: mask(summary.facts.payment), quality: mask(summary.facts.quality), defects: mask(summary.facts.defects) },
    opinions: { reviews: mask(publicReviews) },
    exclusions: summary.exclusions,
    unknown: summary.unknown,
    publicScore: summary.publicScore,
  };
  const explanation: ReputationExplanation = { observations, defects, reviews, obligationsWithoutRecord: missing };
  const inputsDigest = computeDigest({ method: method.version, subject: inputs.subject, explanation }).value;
  return { summary, publicSummary, explanation, inputsDigest };
}

/**
 * The public numeric score: null unless the policy switch is on AND the method carries released weights. Payment never
 * enters it (the summary has no payment input). Kept so the switch is real and tested, not a promise.
 */
export function publicScore(summary: ReputationSummary, method: ReputationMethod = REPUTATION_METHOD, policy: ReputationPolicy = REPUTATION_POLICY): number | null {
  if (!policy.publicNumericScore || method.weights === null) return null;
  const shares: { key: 'timing' | 'quality' | 'payment' | 'reviews'; share: number }[] = [];
  const f = summary.facts;
  if (f.timing.status === 'ok' && f.timing.onTime + f.timing.late > 0) shares.push({ key: 'timing', share: f.timing.onTime / (f.timing.onTime + f.timing.late) });
  if (f.payment.status === 'ok' && f.payment.onTime + f.payment.late > 0) shares.push({ key: 'payment', share: f.payment.onTime / (f.payment.onTime + f.payment.late) });
  if (f.quality.status === 'ok' && f.quality.samples > 0) shares.push({ key: 'quality', share: (f.quality.accepted + f.quality.partiallyAccepted / 2) / f.quality.samples });
  const r = summary.opinions.reviews;
  if (r.status === 'ok' && r.samples > 0) {
    const total = (Object.entries(r.overall) as [string, number][]).reduce((sum, [stars, n]) => sum + Number(stars) * n, 0);
    shares.push({ key: 'reviews', share: (total / r.samples - 1) / 4 });
  }
  const weighted = shares.map((s) => ({ ...s, weight: method.weights![s.key] ?? 0 })).filter((s) => s.weight > 0);
  const weightSum = weighted.reduce((sum, s) => sum + s.weight, 0);
  if (weightSum === 0) return null;
  return Math.round((weighted.reduce((sum, s) => sum + s.weight * s.share, 0) / weightSum) * 100);
}
