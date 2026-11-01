import { FeeConfirmationSchema } from './billing-fees.js';
import { z } from 'zod';
import { PartySchema, type Party } from './access.js';
import { AgentModuleManifestSchema, type AgentCapability, type AgentModuleManifest, type ContractRef } from './agent-catalog.js';
import { AttachmentRefSchema, IanaTimeZoneSchema, IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { DigestSchema } from './common/digest-schema.js';
import { CurrencySchema, NonNegativeMoneySchema, sumMoney, type Money } from './common/money.js';
import { QuantitySchema } from './common/quantity.js';
import { VersionRefSchema, type VersionRef } from './common/version.js';
import { DealActorInputSchema, ElectronicRecordsConsentSchema, ElectronicRecordsPolicySchema, zonedStartOfDay } from './deals.js';
import {
  BudgetRangeSchema, DurationRangeSchema, PlaceCodeSchema, PlanDateSchema, PlanItemKeySchema, PostalAddressSchema, ProjectPlanItemKindSchema, ScheduleWindowSchema, SiteContactSchema,
  StepTermSchema, TaxonomyCodeSchema, type PlanItem, type ProjectLocation, type ProjectPlanItemKind,
} from './plans.js';
import { AcceptanceEventKindSchema, AgreementStatusSchema, ObligationSchema } from './transactions.js';

/**
 * Scoped tasks from plan items (TASK-001; ADR 010 decision 17, ADR 012 decisions 19 and 37, data model section 8).
 *
 * A consumer's or small owner's plan item of kind `task` (or a whole `phase`) becomes a **task request** to contractors
 * and trades. The commercial kernel is reused rather than rebuilt, and maps one to one:
 *
 * | Task object | Kernel counterpart | Shared rule |
 * |---|---|---|
 * | `task_request` | `rfq` | owner-side envelope; `draft -> published -> closed / cancelled` |
 * | `task_request_version` | `rfq_version` | immutable once published, `trustwork-digest-1`; an amendment flags earlier offers stale |
 * | `task_offer` (versioned rows) | `quote_version` | pinned to the current published request version by id and digest; frozen once sent |
 * | `task_offer_private` | `quote_private_constraint` | the offeror's floor and notes; never in an owner view |
 * | agreement `terms_kind = task` | `agreement` | digest over `{ termsKind: 'task', quoteVersion: offer, rfqVersion: request version }`; two acceptance events with the same digest |
 * | `task_assignment` | order and obligations | created only by the offeror's confirmation of the agreement; names the plan item and the agreement version |
 * | `task_execution_record` | execution evidence | a delivery claim is asserted until the owner accepts or rejects it (never automatically a fact) |
 *
 * Privacy: the request payload is built field by field from the approved plan item through `buildTaskRequestPayload`
 * (the same allowlist discipline as plan sharing); private notes, sources, single estimates, risks, decisions, the
 * street address, site contact and access notes never enter it. Competing offerors never see each other's offers or
 * the invitee list. The site address, contact and access notes reach the assignee only after assignment.
 */
export const TASKS_CONTRACT_VERSION = 1;

/* ---------- Vocabulary ---------- */

/** Plan item kinds that become a task request (ADR 012 decision 37: works become tasks; goods become RFQs). */
export const TASK_PLAN_ITEM_KINDS = ['task', 'phase'] as const satisfies readonly ProjectPlanItemKind[];
/** Kinds an offer milestone may be anchored to: the task item itself or a step below it. */
export const MILESTONE_ITEM_KINDS = ['task', 'phase', 'milestone', 'inspection'] as const satisfies readonly ProjectPlanItemKind[];
/**
 * Fields the owner may put into a task brief; a subset of the plan sharing fields. The address and the contact are
 * never part of a brief: they reach the assignee through the assignment, after acceptance.
 */
export const TASK_SHARE_FIELDS = ['scope', 'trade', 'locality', 'drawings', 'quantities', 'schedule', 'budget_range'] as const;
export const TaskShareFieldSchema = z.enum(TASK_SHARE_FIELDS);
export type TaskShareField = z.infer<typeof TaskShareFieldSchema>;
export const TaskAudienceSchema = z.enum(['invited', 'open']);
export type TaskAudience = z.infer<typeof TaskAudienceSchema>;
export const TaskRequestStatusSchema = z.enum(['draft', 'published', 'closed', 'cancelled', 'expired']);
export type TaskRequestStatus = z.infer<typeof TaskRequestStatusSchema>;
export const TaskRequestVersionStatusSchema = z.enum(['draft', 'published', 'superseded']);
export const TaskOfferStatusSchema = z.enum(['draft', 'sent', 'superseded', 'withdrawn', 'expired', 'accepted', 'declined']);
export type TaskOfferStatus = z.infer<typeof TaskOfferStatusSchema>;
/** A flag, never a status: the offer answers an earlier request version, or the request was closed or assigned. */
export const TaskStaleReasonSchema = z.enum(['request_amended', 'request_closed']);
export const TaskInvitationStatusSchema = z.enum(['sent', 'withdrawn', 'declined']);
export const TaskAssignmentStatusSchema = z.enum(['assigned', 'in_progress', 'delivered', 'accepted', 'disputed', 'cancelled']);
export type TaskAssignmentStatus = z.infer<typeof TaskAssignmentStatusSchema>;
export const TaskRecordKindSchema = z.enum(['delivery_claim', 'acceptance', 'rejection']);
export type TaskRecordKind = z.infer<typeof TaskRecordKindSchema>;
export const MilestoneKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'milestone key');

/** A person acts on their own authority; their agent only under a structured mandate. Chat text never authorizes. */
export const TaskActorInputSchema = DealActorInputSchema;
export type TaskActorInput = z.infer<typeof TaskActorInputSchema>;

const distinct = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;

/* ---------- The task brief ---------- */

/** What the owner chooses; everything else in the brief comes from the approved plan item. */
export const TaskRequestTermsSchema = z.strictObject({
  title: NameSchema,
  fields: z.array(TaskShareFieldSchema).min(1).max(TASK_SHARE_FIELDS.length),
  /** The owner's own words for offerors, in addition to the item's description (shared only with `scope`). */
  scopeNote: TextSchema.nullable(),
  /** Plan items an offer milestone may be anchored to: the item itself and steps below it in the approved plan. */
  milestoneItemKeys: z.array(PlanItemKeySchema).min(1).max(50),
  acceptanceCriteria: z.array(ShortTextSchema).max(20),
  responseDeadline: TimestampSchema,
  currency: CurrencySchema,
})
  .refine((t) => distinct(t.fields), { message: 'distinct fields', path: ['fields'] })
  .refine((t) => distinct(t.milestoneItemKeys), { message: 'distinct milestone items', path: ['milestoneItemKeys'] });
export type TaskRequestTerms = z.infer<typeof TaskRequestTermsSchema>;

export const MilestoneItemSchema = z.strictObject({ key: PlanItemKeySchema, kind: ProjectPlanItemKindSchema, title: NameSchema });
/**
 * The frozen brief offerors receive: the identity of the step, the owner's terms and exactly the listed fields of the
 * approved plan item. Optional keys are present only when their field was chosen.
 */
export const TaskRequestPayloadSchema = z.strictObject({
  title: NameSchema,
  itemKey: PlanItemKeySchema,
  kind: ProjectPlanItemKindSchema,
  fields: z.array(TaskShareFieldSchema).min(1),
  milestoneItems: z.array(MilestoneItemSchema).min(1).max(50),
  acceptanceCriteria: z.array(ShortTextSchema).max(20),
  responseDeadline: TimestampSchema,
  currency: CurrencySchema,
  /** The plan's time zone: dates in the brief and in offers are business dates there. */
  timeZone: IanaTimeZoneSchema,
  scopeNote: TextSchema.nullable().optional(),
  description: TextSchema.nullable().optional(),
  stepTerms: z.array(StepTermSchema).optional(),
  requiredSkills: z.array(TaxonomyCodeSchema).optional(),
  regionCode: PlaceCodeSchema.nullable().optional(),
  attachments: z.array(AttachmentRefSchema).optional(),
  quantity: QuantitySchema.nullable().optional(),
  window: ScheduleWindowSchema.nullable().optional(),
  duration: DurationRangeSchema.nullable().optional(),
  budgetRange: BudgetRangeSchema.nullable().optional(),
});
export type TaskRequestPayload = z.infer<typeof TaskRequestPayloadSchema>;

/** Keys that never appear in a task brief or any offeror-facing view before assignment, whatever was chosen. */
export const TASK_BRIEF_FORBIDDEN_KEYS = [
  'privateNotes', 'sources', 'estimate', 'riskLevel', 'decisionQuestion', 'address', 'siteContact', 'siteAccessNotes', 'cadastralRef', 'budgetCeiling', 'ownerNotes',
  'invitations', 'offers', 'summary', 'assumptions', 'budget',
] as const;

export class TaskBriefError extends Error {
  constructor(readonly reason: 'item_kind' | 'milestone_item_unknown' | 'milestone_item_kind' | 'currency_mismatch') {
    super(reason);
  }
}

/** Whether `key` is `root` or below it in the approved plan (by parent links). */
function isAtOrBelow(items: ReadonlyMap<string, PlanItem>, key: string, root: string): boolean {
  let current: string | null = key;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    if (current === root) return true;
    seen.add(current);
    current = items.get(current)?.parentKey ?? null;
  }
  return false;
}

/**
 * The only path from a private plan item to an offeror: the step's identity, the owner's terms and per-field picks.
 * `budget_range` shares the estimate range with its basis (never a single figure); `locality` the region code only.
 */
export function buildTaskRequestPayload(input: { item: PlanItem; baseline: readonly PlanItem[]; location: ProjectLocation | null; terms: TaskRequestTerms; timeZone: string }): TaskRequestPayload {
  const { item, terms } = input;
  if (!(TASK_PLAN_ITEM_KINDS as readonly string[]).includes(item.kind)) throw new TaskBriefError('item_kind');
  const byKey = new Map(input.baseline.map((i) => [i.key, i]));
  const milestoneItems = terms.milestoneItemKeys.map((key) => {
    const found = byKey.get(key);
    if (!found || !isAtOrBelow(byKey, key, item.key)) throw new TaskBriefError('milestone_item_unknown');
    if (!(MILESTONE_ITEM_KINDS as readonly string[]).includes(found.kind)) throw new TaskBriefError('milestone_item_kind');
    return { key: found.key, kind: found.kind, title: found.title };
  });
  const fields = new Set(terms.fields);
  if (fields.has('budget_range') && item.estimate && item.estimate.low.currency !== terms.currency) throw new TaskBriefError('currency_mismatch');
  const out: TaskRequestPayload = {
    title: terms.title, itemKey: item.key, kind: item.kind, fields: TASK_SHARE_FIELDS.filter((f) => fields.has(f)), milestoneItems,
    acceptanceCriteria: terms.acceptanceCriteria, responseDeadline: terms.responseDeadline, currency: terms.currency, timeZone: input.timeZone,
  };
  if (fields.has('scope')) {
    out.description = item.description;
    out.scopeNote = terms.scopeNote;
  }
  if (fields.has('trade')) {
    out.stepTerms = item.stepTerms;
    out.requiredSkills = item.requiredSkills;
  }
  if (fields.has('locality')) out.regionCode = input.location?.regionCode ?? null;
  if (fields.has('drawings')) out.attachments = item.attachments;
  if (fields.has('quantities')) out.quantity = item.quantity;
  if (fields.has('schedule')) {
    out.window = item.window;
    out.duration = item.duration;
  }
  if (fields.has('budget_range')) out.budgetRange = item.estimate;
  return TaskRequestPayloadSchema.parse(out);
}

/** Canonical digest input of a published request version: identity, version number and the frozen brief. */
export function taskRequestVersionDigestInput(input: { taskRequestId: string; version: number; payload: TaskRequestPayload }): unknown {
  return { contract: `tasks:v${TASKS_CONTRACT_VERSION}:request`, taskRequestId: input.taskRequestId, version: input.version, payload: TaskRequestPayloadSchema.parse(input.payload) };
}

/* ---------- Offers ---------- */

/** One milestone of an offer, anchored to a plan item the brief lists; its amount is paid when the owner accepts it. */
export const TaskOfferMilestoneSchema = z.strictObject({
  key: MilestoneKeySchema,
  title: NameSchema,
  planItemKey: PlanItemKeySchema,
  amount: NonNegativeMoneySchema,
  due: PlanDateSchema,
});
export type TaskOfferMilestone = z.infer<typeof TaskOfferMilestoneSchema>;

export const TaskOfferPayloadSchema = z.strictObject({
  price: NonNegativeMoneySchema,
  milestones: z.array(TaskOfferMilestoneSchema).min(1).max(50),
  start: PlanDateSchema,
  durationDays: z.int().min(1).max(3650),
  exclusions: z.array(ShortTextSchema).max(50),
  validUntil: TimestampSchema,
  note: TextSchema.nullable(),
})
  .refine((p) => distinct(p.milestones.map((m) => m.key)), { message: 'distinct milestone keys', path: ['milestones'] })
  .refine((p) => p.milestones.every((m) => m.amount.currency === p.price.currency), { message: 'one currency', path: ['milestones'] })
  .refine((p) => p.milestones.every((m) => m.amount.currency !== p.price.currency) || sumMoney(p.milestones.map((m) => m.amount), p.price.currency).minorUnits === p.price.minorUnits, {
    message: 'milestone amounts add up to the price', path: ['price'],
  })
  .refine((p) => p.milestones.every((m) => m.due >= p.start), { message: 'milestones fall due after the start', path: ['milestones'] });
export type TaskOfferPayload = z.infer<typeof TaskOfferPayloadSchema>;

/** Why an offer does not answer a request version; empty when it fits. */
export function offerMisfits(payload: TaskOfferPayload, brief: TaskRequestPayload): ('currency_mismatch' | 'milestone_item_unknown')[] {
  const out: ('currency_mismatch' | 'milestone_item_unknown')[] = [];
  if (payload.price.currency !== brief.currency) out.push('currency_mismatch');
  const items = new Set(brief.milestoneItems.map((i) => i.key));
  if (payload.milestones.some((m) => !items.has(m.planItemKey))) out.push('milestone_item_unknown');
  return out;
}

/** Canonical digest input of a sent offer: pinned request version, offeror, version number and the frozen payload. */
export function taskOfferDigestInput(input: { taskRequestId: string; requestVersion: VersionRef; offeror: Party; version: number; payload: TaskOfferPayload }): unknown {
  return {
    contract: `tasks:v${TASKS_CONTRACT_VERSION}:offer`, taskRequestId: input.taskRequestId, requestVersion: VersionRefSchema.parse(input.requestVersion), offeror: PartySchema.parse(input.offeror),
    version: input.version, payload: TaskOfferPayloadSchema.parse(input.payload),
  };
}

/** Whether a stored offer may be accepted against the current published request version. */
export type TaskAcceptanceCheck = 'ok' | 'commercial.stale_version' | 'commercial.quote_not_acceptable' | 'commercial.quote_expired' | 'commercial.digest_mismatch' | 'commercial.rfq_version_mismatch';
export function checkTaskAcceptance(input: {
  offer: { id: string; version: number; status: TaskOfferStatus; digest: string | null; staleReason: string | null; requestVersionId: string; requestVersionDigest: string; payload: TaskOfferPayload };
  offerRef: VersionRef; requestRef: VersionRef; current: { id: string; version: number; digest: string } | null; now: Date;
}): TaskAcceptanceCheck {
  const { offer, offerRef, requestRef, current, now } = input;
  if (current === null || requestRef.id !== current.id || requestRef.version !== current.version || requestRef.digest.value !== current.digest) return 'commercial.rfq_version_mismatch';
  if (offer.requestVersionId !== current.id || offer.staleReason !== null) return 'commercial.stale_version';
  if (offer.status !== 'sent' || offer.digest === null) return 'commercial.quote_not_acceptable';
  if (Date.parse(offer.payload.validUntil) <= now.getTime()) return 'commercial.quote_expired';
  if (offerRef.id !== offer.id || offerRef.version !== offer.version || offerRef.digest.value !== offer.digest || offer.requestVersionDigest !== current.digest) return 'commercial.digest_mismatch';
  return 'ok';
}

/* ---------- Private halves ---------- */

/** party_private (owner): the budget ceiling an agent never accepts above, and notes. Never in an offeror view. */
export const TaskRequestPrivateInputSchema = z.strictObject({ budgetCeiling: NonNegativeMoneySchema.nullable(), ownerNotes: ShortTextSchema.nullable() });
export type TaskRequestPrivateInput = z.infer<typeof TaskRequestPrivateInputSchema>;
export const EMPTY_TASK_REQUEST_PRIVATE: TaskRequestPrivateInput = { budgetCeiling: null, ownerNotes: null };
export const TaskRequestPrivateSchema = TaskRequestPrivateInputSchema.extend({ revision: RevisionSchema });
/** party_private (offeror): the floor an agent never sends below, and notes. Never in an owner view. */
export const TaskOfferPrivateInputSchema = z.strictObject({ floorPrice: NonNegativeMoneySchema.nullable(), offerorNotes: ShortTextSchema.nullable() });
export type TaskOfferPrivateInput = z.infer<typeof TaskOfferPrivateInputSchema>;
export const EMPTY_TASK_OFFER_PRIVATE: TaskOfferPrivateInput = { floorPrice: null, offerorNotes: null };
export const TaskOfferPrivateSchema = TaskOfferPrivateInputSchema.extend({ offerId: IdSchema, revision: RevisionSchema });

/** True when a price is under a floor or over a ceiling in the same currency (agents are bounded by both). */
export function outsideBound(price: Money, bound: Money | null, direction: 'floor' | 'ceiling'): boolean {
  if (bound === null || bound.currency !== price.currency) return false;
  return direction === 'floor' ? BigInt(price.minorUnits) < BigInt(bound.minorUnits) : BigInt(price.minorUnits) > BigInt(bound.minorUnits);
}

/* ---------- Records and views ---------- */

export const TaskPlanItemRefSchema = z.strictObject({ projectId: IdSchema, planId: IdSchema, planVersionId: IdSchema, itemKey: PlanItemKeySchema });
export type TaskPlanItemRef = z.infer<typeof TaskPlanItemRefSchema>;

export const TaskRequestSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  /** The plan item this request was cut from, in the approved plan version of the time. */
  planItem: TaskPlanItemRefSchema,
  audience: TaskAudienceSchema,
  status: TaskRequestStatusSchema,
  currentVersion: z.int().min(1).nullable(),
  currentVersionId: IdSchema.nullable(),
  closedReason: ShortTextSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TaskRequest = z.infer<typeof TaskRequestSchema>;

export const TaskRequestVersionSchema = z.strictObject({
  id: IdSchema,
  taskRequestId: IdSchema,
  version: z.int().min(1),
  status: TaskRequestVersionStatusSchema,
  payload: TaskRequestPayloadSchema,
  digest: DigestSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
  amendmentReason: ShortTextSchema.nullable(),
}).refine((v) => (v.status === 'draft') === (v.digest === null), { message: 'a version is digest-bound from the moment it is published', path: ['digest'] });
export type TaskRequestVersion = z.infer<typeof TaskRequestVersionSchema>;

export const TaskInvitationSchema = z.strictObject({ id: IdSchema, taskRequestId: IdSchema, party: PartySchema, status: TaskInvitationStatusSchema, sentAt: TimestampSchema });
export type TaskInvitation = z.infer<typeof TaskInvitationSchema>;

/** One offer version. No sender person or mandate: the owner sees the offering party only. */
export const TaskOfferSchema = z.strictObject({
  id: IdSchema,
  taskRequestId: IdSchema,
  offeror: PartySchema,
  version: z.int().min(1),
  requestVersion: VersionRefSchema,
  status: TaskOfferStatusSchema,
  payload: TaskOfferPayloadSchema,
  digest: DigestSchema.nullable(),
  staleReason: TaskStaleReasonSchema.nullable(),
  sentAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
}).refine((o) => (o.status === 'draft') === (o.digest === null), { message: 'an offer is digest-bound from the moment it is sent', path: ['digest'] });
export type TaskOffer = z.infer<typeof TaskOfferSchema>;

export const TaskAgreementEventSchema = z.strictObject({
  id: IdSchema,
  kind: AcceptanceEventKindSchema,
  acceptedTermsDigest: DigestSchema,
  onBehalfOf: PartySchema,
  electronicRecords: z.strictObject({ disclosureKey: ElectronicRecordsPolicySchema.shape.disclosureKey, basis: ElectronicRecordsPolicySchema.shape.basis }).nullable(),
  occurredAt: TimestampSchema,
});
/** The shared agreement of a task: both parties see the same record, events without mandates or budgets. */
export const TaskAgreementSchema = z.strictObject({
  id: IdSchema,
  termsKind: z.literal('task'),
  buyer: PartySchema,
  seller: PartySchema,
  offer: VersionRefSchema,
  requestVersion: VersionRefSchema,
  acceptedTermsDigest: DigestSchema,
  status: AgreementStatusSchema,
  closedReason: ShortTextSchema.nullable(),
  events: z.array(TaskAgreementEventSchema),
  obligations: z.array(ObligationSchema),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type TaskAgreement = z.infer<typeof TaskAgreementSchema>;

/** The assignment always names the plan item and the agreement version (id and accepted-terms digest). */
export const TaskAssignmentSchema = z.strictObject({
  id: IdSchema,
  taskRequestId: IdSchema,
  planItem: TaskPlanItemRefSchema,
  agreement: z.strictObject({ id: IdSchema, acceptedTermsDigest: DigestSchema }),
  offer: VersionRefSchema,
  requestVersion: VersionRefSchema,
  owner: PartySchema,
  assignee: PartySchema,
  milestones: z.array(TaskOfferMilestoneSchema).min(1),
  status: TaskAssignmentStatusSchema,
  completedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;

export const TaskExecutionRecordSchema = z.strictObject({
  id: IdSchema,
  assignmentId: IdSchema,
  milestoneKey: MilestoneKeySchema,
  kind: TaskRecordKindSchema,
  /** The delivery claim an acceptance or rejection answers. */
  claimId: IdSchema.nullable(),
  evidence: z.array(AttachmentRefSchema).max(20),
  note: ShortTextSchema.nullable(),
  by: PartySchema,
  createdAt: TimestampSchema,
});
export type TaskExecutionRecord = z.infer<typeof TaskExecutionRecordSchema>;

/** Execution-evidence state of each milestone (execution.ts): a claim is `asserted` until the owner decides. */
export const MilestoneStateSchema = z.strictObject({
  key: MilestoneKeySchema,
  planItemKey: PlanItemKeySchema,
  state: z.enum(['open', 'asserted', 'confirmed']),
  claimId: IdSchema.nullable(),
});
export type MilestoneState = z.infer<typeof MilestoneStateSchema>;
export function milestoneStates(milestones: readonly TaskOfferMilestone[], records: readonly Pick<TaskExecutionRecord, 'id' | 'milestoneKey' | 'kind' | 'claimId' | 'createdAt'>[]): MilestoneState[] {
  return milestones.map((m) => {
    let state: MilestoneState['state'] = 'open';
    let claimId: string | null = null;
    for (const r of records.filter((x) => x.milestoneKey === m.key)) {
      if (r.kind === 'delivery_claim' && state !== 'confirmed') {
        state = 'asserted';
        claimId = r.id;
      } else if (r.kind === 'acceptance' && r.claimId === claimId) state = 'confirmed';
      else if (r.kind === 'rejection' && r.claimId === claimId) {
        state = 'open';
        claimId = null;
      }
    }
    return { key: m.key, planItemKey: m.planItemKey, state, claimId };
  });
}
/** The assignment status the milestones imply (`disputed` and `cancelled` are set by their own processes, EXE-001). */
export function assignmentStatusFor(states: readonly MilestoneState[], anyRecord: boolean): Extract<TaskAssignmentStatus, 'assigned' | 'in_progress' | 'delivered' | 'accepted'> {
  if (states.length > 0 && states.every((s) => s.state === 'confirmed')) return 'accepted';
  if (states.length > 0 && states.every((s) => s.state !== 'open')) return 'delivered';
  return anyRecord ? 'in_progress' : 'assigned';
}

/** Reviews are allowed only for completed tasks (every milestone accepted by the owner). */
export function reviewAllowed(status: TaskAssignmentStatus): boolean {
  return status === 'accepted';
}
export const TaskReviewSchema = z.strictObject({
  id: IdSchema,
  assignmentId: IdSchema,
  authorSide: z.enum(['owner', 'assignee']),
  author: PartySchema,
  subject: PartySchema,
  rating: z.int().min(1).max(5),
  text: TextSchema.refine((t) => t.length <= 2000, { message: 'at most 2000 characters' }).nullable(),
  createdAt: TimestampSchema,
});
export type TaskReview = z.infer<typeof TaskReviewSchema>;

/** What the assignee receives after assignment: the site for that item (owner-private before). */
export const TaskSiteSchema = z.strictObject({
  regionCode: PlaceCodeSchema.nullable(),
  address: PostalAddressSchema.nullable(),
  siteContact: SiteContactSchema.nullable(),
  siteAccessNotes: TextSchema.nullable(),
});
export type TaskSite = z.infer<typeof TaskSiteSchema>;

/**
 * Obligations of accepted task terms: per milestone the assignee performs and the owner pays the milestone amount
 * (outside the platform or through a licensed provider; Trustwork never holds money), and the owner accepts the work
 * by the last milestone. Due times are the start of the local business day in the plan's time zone.
 */
export function deriveTaskObligations(parties: { owner: Party; assignee: Party }, payload: TaskOfferPayload, timeZone: string): z.infer<typeof ObligationSchema>[] {
  const out: z.infer<typeof ObligationSchema>[] = [];
  for (const m of payload.milestones) {
    const due = zonedStartOfDay(m.due, timeZone);
    out.push({ party: parties.assignee, kind: 'perform', due, amount: null, scope: null });
    out.push({ party: parties.owner, kind: 'pay', due, amount: m.amount, scope: null });
  }
  const last = [...payload.milestones].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0)).at(-1);
  out.push({ party: parties.owner, kind: 'accept', due: last ? zonedStartOfDay(last.due, timeZone) : null, amount: null, scope: null });
  return out.map((o) => ObligationSchema.parse(o));
}

export const TaskAssignmentSummarySchema = z.strictObject({ id: IdSchema, status: TaskAssignmentStatusSchema, assignee: PartySchema });

/** owner_private: the request, every version, the owner's private half, invitations, sent offers and agreements. */
export const OwnerTaskRequestViewSchema = z.strictObject({
  projection: z.literal('owner_private'),
  request: TaskRequestSchema,
  versions: z.array(TaskRequestVersionSchema),
  privateConstraint: TaskRequestPrivateSchema,
  invitations: z.array(TaskInvitationSchema),
  /** Sent offers and their history, newest send first; never drafts. */
  offers: z.array(TaskOfferSchema),
  agreements: z.array(TaskAgreementSchema),
  assignment: TaskAssignmentSummarySchema.nullable(),
});
export type OwnerTaskRequestView = z.infer<typeof OwnerTaskRequestViewSchema>;

/** shared_party for an invitee or an offeror: the published brief and its own invitation; nothing about competitors. */
export const OfferorTaskRequestViewSchema = z.strictObject({
  projection: z.literal('shared_party'),
  request: z.strictObject({ id: IdSchema, owner: PartySchema, audience: TaskAudienceSchema, status: TaskRequestStatusSchema, currentVersion: z.int().min(1).nullable(), currentVersionId: IdSchema.nullable() }),
  versions: z.array(TaskRequestVersionSchema),
  invitation: TaskInvitationSchema.nullable(),
});
export type OfferorTaskRequestView = z.infer<typeof OfferorTaskRequestViewSchema>;

/** The offeror's own desk for one request: every version (drafts too), its private half and its agreements. */
export const OfferorTaskOfferViewSchema = z.strictObject({
  projection: z.literal('party_private'),
  side: z.literal('offeror'),
  taskRequestId: IdSchema,
  offeror: PartySchema,
  versions: z.array(TaskOfferSchema),
  privateConstraint: TaskOfferPrivateSchema.nullable(),
  agreements: z.array(TaskAgreementSchema),
  assignment: TaskAssignmentSummarySchema.nullable(),
});
export type OfferorTaskOfferView = z.infer<typeof OfferorTaskOfferViewSchema>;

export const TaskAssignmentViewSchema = z.strictObject({
  projection: z.literal('party_private'),
  side: z.enum(['owner', 'assignee']),
  assignment: TaskAssignmentSchema,
  agreement: TaskAgreementSchema,
  milestoneStates: z.array(MilestoneStateSchema),
  records: z.array(TaskExecutionRecordSchema),
  reviews: z.array(TaskReviewSchema),
  /** Present once assigned (and never for a cancelled assignment). */
  site: TaskSiteSchema.nullable(),
});
export type TaskAssignmentView = z.infer<typeof TaskAssignmentViewSchema>;

export const TaskRequestListSchema = z.strictObject({
  requests: z.array(z.strictObject({ id: IdSchema, title: NameSchema, status: TaskRequestStatusSchema, audience: TaskAudienceSchema, planItemKey: PlanItemKeySchema, currentVersion: z.int().min(1).nullable(), sentOffers: z.int().min(0), revision: RevisionSchema, updatedAt: TimestampSchema })),
});
export const OpenTaskRequestSchema = z.strictObject({
  id: IdSchema, title: NameSchema, currentVersionId: IdSchema, publishedAt: TimestampSchema, responseDeadline: TimestampSchema,
  regionCode: PlaceCodeSchema.nullable().optional(), stepTerms: z.array(StepTermSchema).optional(), requiredSkills: z.array(TaxonomyCodeSchema).optional(),
});
export const OpenTaskRequestListSchema = z.strictObject({ requests: z.array(OpenTaskRequestSchema) });
export const TaskInvitationListSchema = z.strictObject({ invitations: z.array(z.strictObject({ invitation: TaskInvitationSchema, title: NameSchema, requestStatus: TaskRequestStatusSchema, responseDeadline: TimestampSchema })) });
export const TaskOfferListSchema = z.strictObject({ offers: z.array(z.strictObject({ offerId: IdSchema, taskRequestId: IdSchema, offeror: PartySchema, version: z.int().min(1), status: TaskOfferStatusSchema, staleReason: TaskStaleReasonSchema.nullable(), title: NameSchema })) });
export const TaskAssignmentListSchema = z.strictObject({ assignments: z.array(z.strictObject({ id: IdSchema, side: z.enum(['owner', 'assignee']), status: TaskAssignmentStatusSchema, title: NameSchema, counterparty: PartySchema, createdAt: TimestampSchema })) });

/**
 * Payment-blind order for every list a party sees (the open board, invitations, offers): newest first by the given
 * time, then by id. No payment, entitlement, sponsorship or reputation input exists; the function reads only `at`
 * and `id`, so two lists that differ only in such attributes come out in the same order.
 */
export function paymentBlindOrder<T extends { id: string; at: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? 1 : -1));
}

/* ---------- Commands ---------- */

export const TaskRequestQuerySchema = z.strictObject({ taskRequestId: IdSchema });
export const TaskListQuerySchema = z.strictObject({});
export const TaskOfferQuerySchema = z.strictObject({ offerId: IdSchema });
export const TaskAssignmentQuerySchema = z.strictObject({ assignmentId: IdSchema });

export const CreateTaskRequestCommandSchema = z.strictObject({
  source: z.strictObject({ projectId: IdSchema, itemKey: PlanItemKeySchema }),
  audience: TaskAudienceSchema,
  terms: TaskRequestTermsSchema,
  privateConstraint: TaskRequestPrivateInputSchema.nullable(),
  actor: TaskActorInputSchema,
});
/** Saves the open draft; on a published request without a draft it opens the amendment draft with these terms. */
export const SaveTaskRequestDraftCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, terms: TaskRequestTermsSchema, actor: TaskActorInputSchema });
export const PublishTaskRequestCommandSchema = z.strictObject({ version: z.int().min(1), expectedRevision: RevisionSchema, amendmentReason: ShortTextSchema.nullable(), actor: TaskActorInputSchema });
export const SaveTaskRequestPrivateCommandSchema = TaskRequestPrivateInputSchema.extend({ expectedRevision: RevisionSchema });
export const InviteTaskOfferorCommandSchema = z.strictObject({ party: PartySchema, actor: TaskActorInputSchema });
export const CancelTaskRequestCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: TaskActorInputSchema });

/** Drafts version 1, or the next version of the offeror's offer when an earlier one exists, pinned to the current request version. */
export const CreateTaskOfferCommandSchema = z.strictObject({
  taskRequestId: IdSchema,
  requestVersionId: IdSchema,
  offeror: PartySchema,
  payload: TaskOfferPayloadSchema,
  privateConstraint: TaskOfferPrivateInputSchema.nullable(),
  actor: TaskActorInputSchema,
});
/** `privateConstraint: null` keeps the stored private half. */
export const SaveTaskOfferDraftCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, payload: TaskOfferPayloadSchema, privateConstraint: TaskOfferPrivateInputSchema.nullable(), actor: TaskActorInputSchema });
export const SendTaskOfferCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, actor: TaskActorInputSchema });
export const WithdrawTaskOfferCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: TaskActorInputSchema });

/** The owner accepts the exact offer version against the current request version, by id and digest (consumer: a person's decision). */
export const AcceptTaskOfferCommandSchema = z.strictObject({
  feeConfirmation: FeeConfirmationSchema.optional(),
  offer: VersionRefSchema,
  requestVersion: VersionRefSchema,
  expectedRevision: RevisionSchema,
  electronicRecords: ElectronicRecordsConsentSchema.nullable(),
  actor: TaskActorInputSchema,
});
/** The offeror confirms the agreement, stating the digest it accepts; the assignment is created in the same transaction. */
export const ConfirmTaskAgreementCommandSchema = z.strictObject({ feeConfirmation: FeeConfirmationSchema.optional(), expectedRevision: RevisionSchema, acceptedTermsDigest: DigestSchema, electronicRecords: ElectronicRecordsConsentSchema.nullable(), actor: TaskActorInputSchema });
export const DeclineTaskAgreementCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: TaskActorInputSchema });
export const WithdrawTaskAgreementCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: TaskActorInputSchema });

/**
 * Execution evidence: the assignee claims delivery of a milestone with evidence (an agent may record it under a
 * `record_evidence` mandate); the owner accepts or rejects that claim. Accepting work is human-only
 * (`confirm_execution`): no actor field, the owner decides in person.
 */
export const RecordTaskExecutionCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('delivery_claim'), expectedRevision: RevisionSchema, milestoneKey: MilestoneKeySchema, evidence: z.array(AttachmentRefSchema).min(1).max(20), note: ShortTextSchema.nullable(), actor: TaskActorInputSchema }),
  z.strictObject({ kind: z.literal('acceptance'), expectedRevision: RevisionSchema, milestoneKey: MilestoneKeySchema, claimId: IdSchema, note: ShortTextSchema.nullable() }),
  z.strictObject({ kind: z.literal('rejection'), expectedRevision: RevisionSchema, milestoneKey: MilestoneKeySchema, claimId: IdSchema, note: ShortTextSchema }),
]);
/** A review in the person's own words, tied to a completed task; never written by an agent alone. */
export const SubmitTaskReviewCommandSchema = z.strictObject({ rating: z.int().min(1).max(5), text: TaskReviewSchema.shape.text });

/* ---------- Where task data may go ---------- */

/** Keys that must never reach the owner side (the offeror's private half). */
export const TASK_OWNER_FORBIDDEN_KEYS = ['floorPrice', 'offerorNotes'] as const;
/** Keys that must never reach an offeror before assignment (the owner's private half, plan internals and the site). */
export const TASK_OFFEROR_FORBIDDEN_KEYS = TASK_BRIEF_FORBIDDEN_KEYS;
/** Outbox payloads carry identifiers only; notifications (MAIL-001) read projections under the recipient's authority. */
export const TASK_EVENT_PAYLOAD_KEYS = [
  'taskRequestId', 'versionId', 'version', 'offerId', 'invitationId', 'agreementId', 'assignmentId', 'recordId', 'reviewId', 'status', 'eventKind', 'termsKind', 'inviteeKind', 'inviteeId', 'via',
] as const;
export const TASK_EGRESS = {
  taskRequestPrivate: { search: false, retrieval: false, federation: false, publicProjection: false, sharedProjection: false },
  taskOfferPrivate: { search: false, retrieval: false, federation: false, publicProjection: false, sharedProjection: false },
  taskOffer: { search: false, publicProjection: false },
  taskAssignment: { search: false, publicProjection: false },
  notificationPayload: 'identifiers_only',
} as const;

/* ---------- Capability registry: the task marketplace module (ADR 010 decision 23, AGT-002 shape) ---------- */

const ref = (schema: string, contract = 'tasks'): ContractRef => ({ contract, schema, version: 1 });
const MODULE = { key: 'task_marketplace', version: '1.0.0' } as const;
type CapabilityInput = Omit<AgentCapability, 'version' | 'status' | 'source' | 'surfaces' | 'acceptsUntrustedText' | 'meters' | 'budgetKind'> & Partial<Pick<AgentCapability, 'surfaces' | 'acceptsUntrustedText' | 'meters' | 'budgetKind'>>;
const capability = (c: CapabilityInput): AgentCapability => ({
  version: 1, status: 'live', source: { kind: 'module', moduleKey: MODULE.key, moduleVersion: MODULE.version }, budgetKind: null,
  surfaces: ['ui', 'agent', 'mcp'], acceptsUntrustedText: false, meters: c.kind === 'commit' ? ['agent_actions'] : c.kind === 'draft' ? ['model_tokens'] : [], ...c,
});
const OWNER: Pick<AgentCapability, 'reads' | 'privateDataClasses'> = { reads: ['owner_private'], privateDataClasses: ['private_projects', 'budgets'] };
const OFFEROR: Pick<AgentCapability, 'reads' | 'privateDataClasses'> = { reads: ['party_private'], privateDataClasses: ['negotiation_constraints'] };
const SHARED: Pick<AgentCapability, 'reads' | 'privateDataClasses'> = { reads: ['shared_party'], privateDataClasses: [] };
const READ: Pick<AgentCapability, 'kind' | 'mandateAction' | 'confirmation' | 'sideEffects'> = { kind: 'read', mandateAction: null, confirmation: 'none', sideEffects: ['none'] };

/**
 * Every task operation, defined once for the interface, the person's agent and connections. The owner's side cuts and
 * publishes briefs and accepts offers (a consumer's acceptance is always the person's decision: `person_each`); the
 * offeror's side drafts, sends and confirms within mandates; accepting delivered work is human-only; reviews are a
 * reputation signal the person confirms each time. Hubs cannot widen this module.
 */
export const TASK_MARKETPLACE_CAPABILITIES: readonly AgentCapability[] = [
  // Reads
  capability({ id: 'task_marketplace.list_requests', ...READ, input: ref('TaskListQuerySchema'), output: ref('TaskRequestListSchema'), contextKinds: ['task_request'], ...OWNER, labelKey: 'tasks.capability.listRequests' }),
  capability({ id: 'task_marketplace.get_request', ...READ, input: ref('TaskRequestQuerySchema'), output: ref('OwnerTaskRequestViewSchema'), contextKinds: ['task_request', 'plan_item'], ...OWNER, labelKey: 'tasks.capability.getRequest' }),
  capability({ id: 'task_marketplace.get_brief', ...READ, input: ref('TaskRequestQuerySchema'), output: ref('OfferorTaskRequestViewSchema'), contextKinds: ['task_request'], ...SHARED, labelKey: 'tasks.capability.getBrief' }),
  capability({ id: 'task_marketplace.list_open_requests', ...READ, input: ref('TaskListQuerySchema'), output: ref('OpenTaskRequestListSchema'), contextKinds: ['task_request'], ...SHARED, labelKey: 'tasks.capability.listOpenRequests' }),
  capability({ id: 'task_marketplace.list_invitations', ...READ, input: ref('TaskListQuerySchema'), output: ref('TaskInvitationListSchema'), contextKinds: ['task_request'], ...SHARED, labelKey: 'tasks.capability.listInvitations' }),
  capability({ id: 'task_marketplace.list_offers', ...READ, input: ref('TaskListQuerySchema'), output: ref('TaskOfferListSchema'), contextKinds: ['task_request'], reads: ['party_private'], privateDataClasses: ['drafts'], labelKey: 'tasks.capability.listOffers' }),
  capability({ id: 'task_marketplace.get_offer', ...READ, input: ref('TaskOfferQuerySchema'), output: ref('OfferorTaskOfferViewSchema'), contextKinds: ['task_request', 'agreement'], reads: ['party_private'], privateDataClasses: ['negotiation_constraints', 'drafts'], labelKey: 'tasks.capability.getOffer' }),
  capability({ id: 'task_marketplace.list_assignments', ...READ, input: ref('TaskListQuerySchema'), output: ref('TaskAssignmentListSchema'), contextKinds: ['agreement'], ...SHARED, labelKey: 'tasks.capability.listAssignments' }),
  capability({ id: 'task_marketplace.get_assignment', ...READ, input: ref('TaskAssignmentQuerySchema'), output: ref('TaskAssignmentViewSchema'), contextKinds: ['agreement', 'plan_item'], reads: ['party_private'], privateDataClasses: ['private_projects'], labelKey: 'tasks.capability.getAssignment' }),
  // Owner: briefs
  capability({ id: 'task_marketplace.draft_request', kind: 'draft', mandateAction: 'prepare', confirmation: 'none', input: ref('CreateTaskRequestCommandSchema'), output: ref('OwnerTaskRequestViewSchema'), contextKinds: ['plan_item', 'project'], ...OWNER, sideEffects: ['draft_state'], acceptsUntrustedText: true, labelKey: 'tasks.capability.draftRequest' }),
  capability({ id: 'task_marketplace.save_request_draft', kind: 'draft', mandateAction: 'prepare', confirmation: 'none', input: ref('SaveTaskRequestDraftCommandSchema'), output: ref('OwnerTaskRequestViewSchema'), contextKinds: ['task_request'], ...OWNER, sideEffects: ['draft_state'], acceptsUntrustedText: true, labelKey: 'tasks.capability.saveRequestDraft' }),
  capability({ id: 'task_marketplace.set_request_private', kind: 'draft', mandateAction: 'prepare', confirmation: 'none', input: ref('SaveTaskRequestPrivateCommandSchema'), output: ref('OwnerTaskRequestViewSchema'), contextKinds: ['task_request'], ...OWNER, sideEffects: ['draft_state'], labelKey: 'tasks.capability.setRequestPrivate' }),
  capability({ id: 'task_marketplace.publish_request', kind: 'commit', mandateAction: 'publish', confirmation: 'person_each', input: ref('PublishTaskRequestCommandSchema'), output: ref('OwnerTaskRequestViewSchema'), contextKinds: ['task_request', 'plan_item'], ...OWNER, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.publishRequest' }),
  capability({ id: 'task_marketplace.invite', kind: 'commit', mandateAction: 'communicate', confirmation: 'mandate', input: ref('InviteTaskOfferorCommandSchema'), output: ref('TaskInvitationSchema'), contextKinds: ['task_request'], ...OWNER, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.invite' }),
  capability({ id: 'task_marketplace.cancel_request', kind: 'commit', mandateAction: 'publish', confirmation: 'person_each', input: ref('CancelTaskRequestCommandSchema'), output: ref('OwnerTaskRequestViewSchema'), contextKinds: ['task_request'], ...OWNER, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.cancelRequest' }),
  // Offeror: offers
  capability({ id: 'task_marketplace.draft_offer', kind: 'draft', mandateAction: 'prepare', confirmation: 'none', input: ref('CreateTaskOfferCommandSchema'), output: ref('OfferorTaskOfferViewSchema'), contextKinds: ['task_request'], ...OFFEROR, sideEffects: ['draft_state'], acceptsUntrustedText: true, labelKey: 'tasks.capability.draftOffer' }),
  capability({ id: 'task_marketplace.save_offer_draft', kind: 'draft', mandateAction: 'prepare', confirmation: 'none', input: ref('SaveTaskOfferDraftCommandSchema'), output: ref('OfferorTaskOfferViewSchema'), contextKinds: ['task_request'], ...OFFEROR, sideEffects: ['draft_state'], acceptsUntrustedText: true, labelKey: 'tasks.capability.saveOfferDraft' }),
  capability({ id: 'task_marketplace.send_offer', kind: 'commit', mandateAction: 'send_quote', confirmation: 'mandate', input: ref('SendTaskOfferCommandSchema'), output: ref('OfferorTaskOfferViewSchema'), contextKinds: ['task_request'], ...OFFEROR, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.sendOffer' }),
  capability({ id: 'task_marketplace.withdraw_offer', kind: 'commit', mandateAction: 'send_quote', confirmation: 'mandate', input: ref('WithdrawTaskOfferCommandSchema'), output: ref('OfferorTaskOfferViewSchema'), contextKinds: ['task_request'], ...OFFEROR, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.withdrawOffer' }),
  // Agreements and assignment
  capability({ id: 'task_marketplace.accept_offer', kind: 'commit', mandateAction: 'place_order', confirmation: 'person_each', budgetKind: 'transaction', input: ref('AcceptTaskOfferCommandSchema'), output: ref('OwnerTaskRequestViewSchema'), contextKinds: ['task_request', 'agreement'], ...OWNER, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.acceptOffer' }),
  capability({ id: 'task_marketplace.withdraw_acceptance', kind: 'commit', mandateAction: 'place_order', confirmation: 'person_each', budgetKind: 'transaction', input: ref('WithdrawTaskAgreementCommandSchema'), output: ref('OwnerTaskRequestViewSchema'), contextKinds: ['agreement'], ...OWNER, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.withdrawAcceptance' }),
  capability({ id: 'task_marketplace.confirm_agreement', kind: 'commit', mandateAction: 'accept_order', confirmation: 'person_each', budgetKind: 'transaction', input: ref('ConfirmTaskAgreementCommandSchema'), output: ref('TaskAssignmentViewSchema'), contextKinds: ['agreement', 'task_request'], ...OFFEROR, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.confirmAgreement' }),
  capability({ id: 'task_marketplace.decline_agreement', kind: 'commit', mandateAction: 'accept_order', confirmation: 'person_each', budgetKind: 'transaction', input: ref('DeclineTaskAgreementCommandSchema'), output: ref('OfferorTaskOfferViewSchema'), contextKinds: ['agreement'], ...OFFEROR, sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.declineAgreement' }),
  // Execution and reviews
  capability({ id: 'task_marketplace.record_delivery', kind: 'commit', mandateAction: 'record_evidence', confirmation: 'mandate', input: ref('RecordTaskExecutionCommandSchema'), output: ref('TaskAssignmentViewSchema'), contextKinds: ['agreement', 'plan_item'], reads: ['party_private'], privateDataClasses: [], sideEffects: ['state_change', 'outbound_message'], labelKey: 'tasks.capability.recordDelivery' }),
  capability({ id: 'task_marketplace.decide_delivery', kind: 'commit', mandateAction: 'confirm_execution', confirmation: 'person_each', input: ref('RecordTaskExecutionCommandSchema'), output: ref('TaskAssignmentViewSchema'), contextKinds: ['agreement', 'plan_item'], reads: ['party_private'], privateDataClasses: ['private_projects'], sideEffects: ['state_change', 'outbound_message'], surfaces: ['ui', 'agent'], labelKey: 'tasks.capability.decideDelivery' }),
  capability({ id: 'task_marketplace.review', kind: 'commit', mandateAction: 'record_evidence', confirmation: 'person_each', input: ref('SubmitTaskReviewCommandSchema'), output: ref('TaskAssignmentViewSchema'), contextKinds: ['agreement'], reads: ['party_private'], privateDataClasses: [], sideEffects: ['state_change', 'reputation_signal'], surfaces: ['ui', 'agent'], labelKey: 'tasks.capability.review' }),
];

export const TASK_MARKETPLACE_MANIFEST: AgentModuleManifest = AgentModuleManifestSchema.parse({
  key: MODULE.key,
  version: MODULE.version,
  family: 'plan_to_people',
  status: 'live',
  actions: ['prepare', 'publish', 'communicate', 'send_quote', 'place_order', 'accept_order', 'record_evidence', 'confirm_execution'],
  capabilities: TASK_MARKETPLACE_CAPABILITIES,
  meters: ['model_tokens', 'agent_actions'],
  suits: ['homeowner', 'developer', 'small_contractor', 'subcontractor', 'individual_professional'],
  freeFloor: [{ meter: 'agent_actions', units: '50', window: 'month' }],
  safetySuite: 'tests/tasks',
});
