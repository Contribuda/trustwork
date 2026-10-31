import { z } from 'zod';
import { PartySchema, type Party } from './access.js';
import { AgentModuleManifestSchema, type AgentCapability, type AgentModuleManifest, type ContractRef } from './agent-catalog.js';
import { AttachmentRefSchema, IanaTimeZoneSchema, IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { DigestSchema } from './common/digest-schema.js';
import { NonNegativeMoneySchema } from './common/money.js';
import { QuantitySchema } from './common/quantity.js';

/**
 * Project plans (PLAN-001; ADR 010 decision 17, ADR 012 decisions 13, 14, 23 and 37): one plan per project, versions
 * `draft -> proposed -> approved -> superseded`, plan items keyed by the open plan-step taxonomy (data/taxonomy, CC0),
 * acyclic dependencies, the mutable execution state beside the frozen version, plan changes with attribution for fair
 * timing, per-item sharing with invited parties, permit records, a private diary and the owner-private site location.
 *
 * Everything here is owner-private by default. The only projection another party ever receives is the invited view
 * (`toInvitedPlanView`), built from the listed fields of live shares; budgets appear only as estimate ranges with their
 * basis, never as quotes.
 */
export const PLANS_CONTRACT_VERSION = 1;

/* ---------- Vocabulary ---------- */

/** A released code of the plan-step taxonomy (`taxonomy_term.code`), for example `work.envelope.roofing`. */
export const TaxonomyCodeSchema = z.string().max(200).regex(/^[a-z]+(\.[a-z0-9_]+)*$/, 'taxonomy code');
/** Taxonomy schemes a plan item may reference (prefix of the code). */
export const STEP_TERM_PREFIXES = ['stage', 'project', 'work', 'trade', 'material', 'permit', 'inspection', 'decision'] as const;
export const StepTermSchema = TaxonomyCodeSchema.refine((code) => (STEP_TERM_PREFIXES as readonly string[]).includes(code.split('.')[0] as string), { message: 'unknown plan-step scheme' });
/** Stable across versions: the same step keeps its key when a revised version is drafted. */
export const PlanItemKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'plan item key');
export type PlanItemKey = z.infer<typeof PlanItemKeySchema>;
/** Jurisdiction or place code (`jurisdiction.code`), for example `US-CA` or `US-CA:san-diego-county`. */
export const PlaceCodeSchema = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$/, 'place code');
export const PlanDateSchema = z.iso.date();

export const PLAN_ITEM_KINDS = ['phase', 'task', 'milestone', 'consultation', 'purchase', 'material', 'permit', 'inspection', 'decision', 'risk', 'self'] as const;
/** Named `ProjectPlanItemKind` because hub.ts already exports the planner-template `PlanItemKindSchema`. */
export const ProjectPlanItemKindSchema = z.enum(PLAN_ITEM_KINDS);
export type ProjectPlanItemKind = z.infer<typeof ProjectPlanItemKindSchema>;
/**
 * Which taxonomy scheme an item kind must carry (data/taxonomy manifest `exampleStepKinds`): permits, inspections and
 * decisions are questions tied to jurisdiction facets; steps people do name a work type; purchases name a material.
 */
export const KIND_REQUIRED_PREFIX: Readonly<Partial<Record<ProjectPlanItemKind, (typeof STEP_TERM_PREFIXES)[number]>>> = {
  phase: 'stage', task: 'work', consultation: 'work', self: 'work', purchase: 'material', material: 'material', permit: 'permit', inspection: 'inspection', decision: 'decision',
};

/* ---------- Ranges: estimates are ranges with a basis, never quotes ---------- */

/** Where an estimate comes from. Only cost data the hub licensed for display and model use, or the owner's own data (ADR 012 decision 23). */
export const ESTIMATE_BASES = ['template', 'licensed_source', 'own_quote', 'lesson', 'owner_estimate'] as const;
export const EstimateBasisSchema = z.enum(ESTIMATE_BASES);
/**
 * A budget range. `kind: 'estimate_range'` and the strict `low < high` make it impossible to present a single figure as
 * if it were a price: a quote is an immutable offer from a counterparty (sales.ts), never a plan field.
 */
export const BudgetRangeSchema = z.strictObject({
  kind: z.literal('estimate_range'),
  low: NonNegativeMoneySchema,
  high: NonNegativeMoneySchema,
  basis: EstimateBasisSchema,
  /** Dataset, template or the owner's own quote the range derives from; `null` for the owner's own estimate. */
  basisRef: z.string().min(1).max(200).nullable(),
  asOf: PlanDateSchema,
})
  .refine((r) => r.low.currency === r.high.currency, { message: 'one currency', path: ['high'] })
  .refine((r) => BigInt(r.low.minorUnits) < BigInt(r.high.minorUnits), { message: 'a range has low < high; a single figure is not an estimate', path: ['high'] })
  .refine((r) => r.basis === 'owner_estimate' || r.basisRef !== null, { message: 'a sourced range names its source', path: ['basisRef'] });
export type BudgetRange = z.infer<typeof BudgetRangeSchema>;

export const DurationRangeSchema = z.strictObject({ lowDays: z.int().min(0).max(3650), highDays: z.int().min(0).max(3650) })
  .refine((d) => d.lowDays <= d.highDays, { message: 'lowDays <= highDays', path: ['highDays'] });
export type DurationRange = z.infer<typeof DurationRangeSchema>;
export const ScheduleWindowSchema = z.strictObject({ earliestStart: PlanDateSchema.nullable(), latestFinish: PlanDateSchema.nullable() })
  .refine((w) => w.earliestStart === null || w.latestFinish === null || w.earliestStart <= w.latestFinish, { message: 'start before finish', path: ['latestFinish'] });
export type ScheduleWindow = z.infer<typeof ScheduleWindowSchema>;

/* ---------- Plan items and dependencies ---------- */

export const PlanItemSourceSchema = z.strictObject({
  kind: z.enum(['template', 'licensed_source', 'own_quote', 'lesson', 'jurisdiction_facet']),
  ref: z.string().min(1).max(200),
});

/** One step of a plan version; frozen with its version once proposed. */
export const PlanItemSchema = z.strictObject({
  key: PlanItemKeySchema,
  parentKey: PlanItemKeySchema.nullable(),
  kind: ProjectPlanItemKindSchema,
  title: NameSchema,
  description: TextSchema.nullable(),
  stepTerms: z.array(StepTermSchema).max(30),
  /** Trades and expertise the step needs (taxonomy `trade.*`; trades double as skills in taxonomy 1.0.0). */
  requiredSkills: z.array(TaxonomyCodeSchema.refine((c) => c.startsWith('trade.'), { message: 'a trade code' })).max(20),
  quantity: QuantitySchema.nullable(),
  estimate: BudgetRangeSchema.nullable(),
  duration: DurationRangeSchema.nullable(),
  window: ScheduleWindowSchema.nullable(),
  riskLevel: z.enum(['low', 'medium', 'high']).nullable(),
  decisionQuestion: ShortTextSchema.nullable(),
  sources: z.array(PlanItemSourceSchema).max(20),
  /** Drawings and documents attached to this item; the only files an invitee can ever receive from a plan. */
  attachments: z.array(AttachmentRefSchema).max(20),
  /** Never leaves the owner-private projection. */
  privateNotes: TextSchema.nullable(),
})
  .refine((i) => new Set(i.stepTerms).size === i.stepTerms.length && new Set(i.requiredSkills).size === i.requiredSkills.length, { message: 'terms are distinct', path: ['stepTerms'] })
  .refine((i) => {
    const prefix = KIND_REQUIRED_PREFIX[i.kind];
    return prefix === undefined || i.stepTerms.some((t) => t.split('.')[0] === prefix);
  }, { message: 'the item kind needs a term of its taxonomy scheme', path: ['stepTerms'] })
  .refine((i) => i.kind !== 'risk' || i.riskLevel !== null, { message: 'a risk names its level', path: ['riskLevel'] })
  .refine((i) => i.parentKey !== i.key, { message: 'an item is not its own parent', path: ['parentKey'] });
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const DEPENDENCY_TYPES = ['fs', 'ss', 'ff', 'sf'] as const;
export const PlanDependencySchema = z.strictObject({
  predecessorKey: PlanItemKeySchema,
  successorKey: PlanItemKeySchema,
  type: z.enum(DEPENDENCY_TYPES),
  lagDays: z.int().min(-365).max(365),
}).refine((d) => d.predecessorKey !== d.successorKey, { message: 'no self dependency', path: ['successorKey'] });
export type PlanDependency = z.infer<typeof PlanDependencySchema>;

/** First cycle found in a directed graph given as edges, as a closed path (`[a, b, a]`); `null` when acyclic. */
export function findCycle(edges: readonly { from: string; to: string }[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, 'open');
    stack.push(node);
    for (const to of next.get(node) ?? []) {
      const s = state.get(to);
      if (s === 'open') return [...stack.slice(stack.indexOf(to)), to];
      if (s === undefined) {
        const found = visit(to);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of [...next.keys()].sort()) {
    if (state.get(node) === undefined) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}
export function findDependencyCycle(dependencies: readonly PlanDependency[]): string[] | null {
  return findCycle(dependencies.map((d) => ({ from: d.predecessorKey, to: d.successorKey })));
}

/** The editable body of a version; frozen and digest-bound once proposed. */
export const PlanContentSchema = z.strictObject({
  summary: TextSchema.nullable(),
  assumptions: z.array(ShortTextSchema).max(50),
  budget: BudgetRangeSchema.nullable(),
  timeline: ScheduleWindowSchema.nullable(),
  items: z.array(PlanItemSchema).max(500),
  dependencies: z.array(PlanDependencySchema).max(2000),
}).superRefine((c, ctx) => {
  const keys = new Set<string>();
  c.items.forEach((item, index) => {
    if (keys.has(item.key)) ctx.addIssue({ code: 'custom', message: `duplicate item key ${item.key}`, path: ['items', index, 'key'] });
    keys.add(item.key);
  });
  c.items.forEach((item, index) => {
    if (item.parentKey !== null && !keys.has(item.parentKey)) ctx.addIssue({ code: 'custom', message: `unknown parent ${item.parentKey}`, path: ['items', index, 'parentKey'] });
  });
  const parentCycle = findCycle(c.items.filter((i) => i.parentKey !== null).map((i) => ({ from: i.key, to: i.parentKey as string })));
  if (parentCycle) ctx.addIssue({ code: 'custom', message: `parent cycle ${parentCycle.join(' -> ')}`, path: ['items'] });
  const pairs = new Set<string>();
  c.dependencies.forEach((d, index) => {
    for (const k of [d.predecessorKey, d.successorKey]) if (!keys.has(k)) ctx.addIssue({ code: 'custom', message: `unknown item ${k}`, path: ['dependencies', index] });
    const pair = `${d.predecessorKey}>${d.successorKey}`;
    if (pairs.has(pair)) ctx.addIssue({ code: 'custom', message: `duplicate dependency ${pair}`, path: ['dependencies', index] });
    pairs.add(pair);
  });
  const cycle = findDependencyCycle(c.dependencies);
  if (cycle) ctx.addIssue({ code: 'custom', message: `dependency cycle ${cycle.join(' -> ')}`, path: ['dependencies'], params: { reason: 'dependency_cycle', cycle } });
  const currencies = new Set([c.budget, ...c.items.map((i) => i.estimate)].filter((r): r is BudgetRange => r !== null).map((r) => r.low.currency));
  if (currencies.size > 1) ctx.addIssue({ code: 'custom', message: 'one currency per plan version', path: ['items'] });
});
export type PlanContent = z.infer<typeof PlanContentSchema>;
export const EMPTY_PLAN_CONTENT: PlanContent = { summary: null, assumptions: [], budget: null, timeline: null, items: [], dependencies: [] };

/** Canonical digest input of a version: the owner approves exactly this (items and dependencies in key order). */
export function planVersionDigestInput(input: { planId: string; version: number; content: PlanContent }): unknown {
  const items = [...input.content.items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const dependencies = [...input.content.dependencies].sort((a, b) => {
    const x = `${a.predecessorKey}>${a.successorKey}`;
    const y = `${b.predecessorKey}>${b.successorKey}`;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { contract: `plans:v${PLANS_CONTRACT_VERSION}`, planId: input.planId, version: input.version, content: { ...input.content, items, dependencies } };
}

/* ---------- Plans and versions ---------- */

/** Who drafted or proposed: the person, or their own agent under a named mandate (never an approval). */
export const PlanActorSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person'), personId: IdSchema, mandateId: z.null() }),
  z.strictObject({ via: z.literal('agent'), personId: IdSchema, mandateId: IdSchema }),
]);
export type PlanActor = z.infer<typeof PlanActorSchema>;
/** Request-side form: the principal is the session; an agent names the mandate it acts under. */
export const PlanActorInputSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person') }),
  z.strictObject({ via: z.literal('agent'), mandateId: IdSchema }),
]);
export type PlanActorInput = z.infer<typeof PlanActorInputSchema>;

export const PLAN_VERSION_STATUSES = ['draft', 'proposed', 'approved', 'superseded'] as const;
export const PlanVersionStatusSchema = z.enum(PLAN_VERSION_STATUSES);
export type PlanVersionStatus = z.infer<typeof PlanVersionStatusSchema>;
const VERSION_TRANSITIONS: Record<PlanVersionStatus, readonly PlanVersionStatus[]> = {
  draft: ['proposed'],
  proposed: ['approved', 'superseded'],
  approved: ['superseded'],
  superseded: [],
};
export function planVersionTransitionAllowed(from: PlanVersionStatus, to: PlanVersionStatus): boolean {
  return VERSION_TRANSITIONS[from].includes(to);
}
/** `returned`: the owner sent a proposal back (a new draft continues); `replaced`: a later version was proposed or approved. */
export const SupersededReasonSchema = z.enum(['returned', 'replaced']);

export const PlanVersionSchema = z.strictObject({
  id: IdSchema,
  planId: IdSchema,
  projectId: IdSchema,
  version: z.int().min(1),
  status: PlanVersionStatusSchema,
  content: PlanContentSchema,
  digest: DigestSchema.nullable(),
  basedOnVersionId: IdSchema.nullable(),
  drafted: PlanActorSchema,
  proposed: z.strictObject({ actor: PlanActorSchema, at: TimestampSchema }).nullable(),
  approved: z.strictObject({ personId: IdSchema, at: TimestampSchema }).nullable(),
  superseded: z.strictObject({ at: TimestampSchema, byVersionId: IdSchema.nullable(), reason: SupersededReasonSchema }).nullable(),
  changeId: IdSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
})
  .refine((v) => (v.status === 'draft') === (v.digest === null) && (v.status === 'draft') === (v.proposed === null), { message: 'a version is digest-bound from the moment it is proposed', path: ['digest'] })
  .refine((v) => (v.status === 'approved' ? v.approved !== null : v.status === 'superseded' || v.approved === null), { message: 'approval recorded for approved versions (and kept when superseded)', path: ['approved'] })
  .refine((v) => v.approved === null || v.status === 'approved' || v.superseded?.reason === 'replaced', { message: 'a returned proposal was never approved', path: ['approved'] })
  .refine((v) => (v.status === 'superseded') === (v.superseded !== null), { message: 'superseded versions record when and why', path: ['superseded'] });
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

export const PlanVersionSummarySchema = z.strictObject({
  id: IdSchema, version: z.int().min(1), status: PlanVersionStatusSchema, digest: DigestSchema.nullable(), createdAt: TimestampSchema,
  approvedAt: TimestampSchema.nullable(), supersededReason: SupersededReasonSchema.nullable(),
});
export type PlanVersionSummary = z.infer<typeof PlanVersionSummarySchema>;

export const PlanSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  /** `drafting` until a first version is approved; `closed` when the project ends. */
  status: z.enum(['drafting', 'active', 'closed']),
  /** The approved baseline. */
  currentVersionId: IdSchema.nullable(),
  timeZone: IanaTimeZoneSchema,
  drafted: PlanActorSchema,
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

/** The owner-private projection: the plan, every version (kept for ever) and the open draft and proposal. */
export const OwnerPlanViewSchema = z.strictObject({
  projection: z.literal('owner_private'),
  plan: PlanSchema,
  versions: z.array(PlanVersionSummarySchema),
  approved: PlanVersionSchema.nullable(),
  proposed: PlanVersionSchema.nullable(),
  draft: PlanVersionSchema.nullable(),
});
export type OwnerPlanView = z.infer<typeof OwnerPlanViewSchema>;

/* ---------- Execution state beside the frozen version ---------- */

export const PLAN_ITEM_STATES = ['proposed', 'accepted', 'requested', 'in_progress', 'done', 'blocked', 'cancelled', 'skipped'] as const;
export const PlanItemStatusSchema = z.enum(PLAN_ITEM_STATES);
export type PlanItemStatus = z.infer<typeof PlanItemStatusSchema>;
const ITEM_TRANSITIONS: Record<PlanItemStatus, readonly PlanItemStatus[]> = {
  proposed: ['accepted', 'cancelled', 'skipped'],
  accepted: ['requested', 'in_progress', 'cancelled', 'skipped'],
  requested: ['in_progress', 'blocked', 'cancelled', 'skipped'],
  in_progress: ['done', 'blocked', 'cancelled', 'skipped'],
  blocked: ['requested', 'in_progress', 'cancelled', 'skipped'],
  done: [], cancelled: [], skipped: [],
};
/** `blocked` returns only to the state it came from. */
export function planItemTransitionAllowed(from: PlanItemStatus, to: PlanItemStatus, blockedFrom: PlanItemStatus | null = null): boolean {
  if (!ITEM_TRANSITIONS[from].includes(to)) return false;
  if (from === 'blocked' && (to === 'requested' || to === 'in_progress')) return blockedFrom === to;
  return true;
}

/**
 * The path a plan item takes (ADR 012 decision 37): consumers turn works into tasks and goods into RFQs; inside a
 * company with approval routes every purchase starts as a requisition. An item records one path and cannot take two.
 */
export const PLAN_ITEM_PATHS = ['task', 'rfq', 'requisition', 'consultation', 'self'] as const;
export const PlanItemPathSchema = z.enum(PLAN_ITEM_PATHS);
export type PlanItemPath = z.infer<typeof PlanItemPathSchema>;
export const PlanItemLinkKindSchema = z.enum(['task_request', 'rfq', 'requisition', 'consultation_request', 'permit_record', 'course', 'event']);
export const PlanItemLinkSchema = z.strictObject({ kind: PlanItemLinkKindSchema, id: IdSchema });
export type PlanItemLink = z.infer<typeof PlanItemLinkSchema>;
/** The request kind each path links to; `self` (do it myself) links to a course or event at most. */
export const PATH_LINK_KINDS: Readonly<Record<PlanItemPath, readonly z.infer<typeof PlanItemLinkKindSchema>[]>> = {
  task: ['task_request'], rfq: ['rfq'], requisition: ['requisition'], consultation: ['consultation_request'], self: ['course', 'event'],
};
/** Whether an item already on `current` may take `next`; once a path is recorded it is never replaced by another. */
export function pathChangeAllowed(current: PlanItemPath | null, next: PlanItemPath | null): boolean {
  return current === null || current === next;
}

export const PlanItemStateSchema = z.strictObject({
  planId: IdSchema,
  itemKey: PlanItemKeySchema,
  status: PlanItemStatusSchema,
  path: PlanItemPathSchema.nullable(),
  link: PlanItemLinkSchema.nullable(),
  blockedFrom: PlanItemStatusSchema.nullable(),
  actualStart: PlanDateSchema.nullable(),
  actualEnd: PlanDateSchema.nullable(),
  updatedBy: IdSchema,
  revision: RevisionSchema,
  updatedAt: TimestampSchema,
})
  .refine((s) => s.link === null || (s.path !== null && PATH_LINK_KINDS[s.path].includes(s.link.kind)), { message: 'a link matches the item path', path: ['link'] })
  .refine((s) => s.status !== 'requested' || (s.path !== null && s.path !== 'self' && s.link !== null), { message: 'requested is entered only with a linked request', path: ['link'] })
  .refine((s) => (s.status === 'blocked') === (s.blockedFrom !== null), { message: 'blocked records where it came from', path: ['blockedFrom'] });
export type PlanItemState = z.infer<typeof PlanItemStateSchema>;

/* ---------- Plan changes and fair timing ---------- */

export const PLAN_CHANGE_CAUSES = ['owner_request', 'counterparty', 'site_condition', 'regulatory', 'external', 'unknown'] as const;
export const PlanChangeCauseSchema = z.enum(PLAN_CHANGE_CAUSES);
export type PlanChangeCause = z.infer<typeof PlanChangeCauseSchema>;
export const PlanChangeStatusSchema = z.enum(['proposed', 'approved', 'rejected', 'withdrawn']);
export type PlanChangeStatus = z.infer<typeof PlanChangeStatusSchema>;
export function planChangeTransitionAllowed(from: PlanChangeStatus, to: PlanChangeStatus): boolean {
  return from === 'proposed' && to !== 'proposed';
}
/** What changed, why, who asked, which agreement covers it and who is accountable; never rewritten afterwards. */
export const PlanChangeSchema = z.strictObject({
  id: IdSchema,
  planId: IdSchema,
  fromVersionId: IdSchema,
  toVersionId: IdSchema,
  reason: ShortTextSchema,
  cause: PlanChangeCauseSchema,
  requestedBy: PartySchema,
  accountable: PartySchema,
  agreementId: IdSchema.nullable(),
  scheduleImpactDays: z.int().min(-3650).max(3650).nullable(),
  status: PlanChangeStatusSchema,
  createdBy: IdSchema,
  decidedBy: IdSchema.nullable(),
  decidedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
}).refine((c) => (c.status === 'proposed') === (c.decidedAt === null), { message: 'decided changes record the decision', path: ['decidedAt'] });
export type PlanChange = z.infer<typeof PlanChangeSchema>;

/** Who a schedule change is attributed to when timing reputation is computed (EXE-001). */
export type DelayAttribution = 'client' | 'counterparty' | 'neutral' | 'unattributed';
export function attributeDelay(cause: PlanChangeCause): DelayAttribution {
  if (cause === 'owner_request') return 'client';
  if (cause === 'counterparty') return 'counterparty';
  if (cause === 'unknown') return 'unattributed';
  return 'neutral';
}
/**
 * The facts EXE-001 reads for fair timing: only approved changes, with both versions kept, so a supplier is measured
 * against the plan as agreed at the time and a client-caused change is never an unexplained supplier delay.
 */
export const PlanTimingFactSchema = z.strictObject({
  changeId: IdSchema,
  planId: IdSchema,
  fromVersion: z.int().min(1),
  toVersion: z.int().min(1),
  decidedAt: TimestampSchema,
  cause: PlanChangeCauseSchema,
  attribution: z.enum(['client', 'counterparty', 'neutral', 'unattributed']),
  accountable: PartySchema,
  agreementId: IdSchema.nullable(),
  scheduleImpactDays: z.int().nullable(),
  /** True when the change must not count against the counterparty's timeliness. */
  excludedFromCounterpartyTiming: z.boolean(),
});
export type PlanTimingFact = z.infer<typeof PlanTimingFactSchema>;
export function toTimingFacts(changes: readonly PlanChange[], versionNumbers: ReadonlyMap<string, number>): PlanTimingFact[] {
  return changes
    .filter((c) => c.status === 'approved' && c.decidedAt !== null)
    .map((c) => {
      const attribution = attributeDelay(c.cause);
      return PlanTimingFactSchema.parse({
        changeId: c.id, planId: c.planId, fromVersion: versionNumbers.get(c.fromVersionId), toVersion: versionNumbers.get(c.toVersionId), decidedAt: c.decidedAt,
        cause: c.cause, attribution, accountable: c.accountable, agreementId: c.agreementId, scheduleImpactDays: c.scheduleImpactDays,
        excludedFromCounterpartyTiming: attribution === 'client' || attribution === 'neutral',
      });
    });
}

/* ---------- Sharing one item with one audience ---------- */

export const PLAN_SHARE_AUDIENCES = ['public', 'invited', 'after_acceptance'] as const;
export const PlanShareAudienceSchema = z.enum(PLAN_SHARE_AUDIENCES);
export type PlanShareAudience = z.infer<typeof PlanShareAudienceSchema>;
export const PLAN_SHARE_FIELDS = ['scope', 'trade', 'locality', 'address', 'drawings', 'quantities', 'schedule', 'budget_range', 'contact'] as const;
export const PlanShareFieldSchema = z.enum(PLAN_SHARE_FIELDS);
export type PlanShareField = z.infer<typeof PlanShareFieldSchema>;
/** The needs board shows trade, scope summary, city or county and timing; never the street address or a budget. */
export const PUBLIC_SHARE_FIELDS: readonly PlanShareField[] = ['scope', 'trade', 'locality', 'schedule'];
/** Address, contact details and site-access notes only after a booked site visit or an accepted task. */
export const AFTER_ACCEPTANCE_FIELDS: readonly PlanShareField[] = ['address', 'contact'];
export const AcceptanceRefSchema = z.strictObject({ kind: z.enum(['consultation_booking', 'task_assignment']), id: IdSchema });

const shareFieldRules = <T extends { audience: PlanShareAudience; invitee: Party | null; fields: readonly PlanShareField[]; acceptanceRef: unknown }>(schema: z.ZodType<T>) => schema
  .refine((s) => s.fields.length > 0 && new Set(s.fields).size === s.fields.length, { message: 'distinct fields, at least one', path: ['fields'] })
  .refine((s) => (s.audience === 'public') === (s.invitee === null), { message: 'public shares name no invitee; invited shares name exactly one', path: ['invitee'] })
  .refine((s) => s.audience !== 'public' || s.fields.every((f) => PUBLIC_SHARE_FIELDS.includes(f)), { message: 'the public needs board shows only scope, trade, locality and schedule', path: ['fields'] })
  .refine((s) => s.audience === 'after_acceptance' || !s.fields.some((f) => AFTER_ACCEPTANCE_FIELDS.includes(f)), { message: 'address and contact only after acceptance', path: ['fields'] })
  .refine((s) => (s.audience === 'after_acceptance') === (s.acceptanceRef !== null), { message: 'after_acceptance names the booking or assignment', path: ['acceptanceRef'] });

export const PlanShareSchema = shareFieldRules(z.strictObject({
  id: IdSchema,
  planId: IdSchema,
  itemKey: PlanItemKeySchema,
  audience: PlanShareAudienceSchema,
  invitee: PartySchema.nullable(),
  fields: z.array(PlanShareFieldSchema).max(PLAN_SHARE_FIELDS.length),
  acceptanceRef: AcceptanceRefSchema.nullable(),
  /** Digest of the projection the owner reviewed before sharing. */
  previewDigest: DigestSchema,
  confirmedBy: IdSchema,
  confirmedAt: TimestampSchema,
  validUntil: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
}));
export type PlanShare = z.infer<typeof PlanShareSchema>;
export function shareLive(share: Pick<PlanShare, 'revokedAt' | 'validUntil'>, now: Date): boolean {
  return share.revokedAt === null && (share.validUntil === null || Date.parse(share.validUntil) > now.getTime());
}

/* ---------- Site location, permits and diary ---------- */

export const PostalAddressSchema = z.strictObject({
  lines: z.array(ShortTextSchema).min(1).max(4),
  locality: ShortTextSchema,
  region: ShortTextSchema.nullable(),
  postalCode: z.string().min(1).max(20).nullable(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
});
export const SiteContactSchema = z.strictObject({ name: NameSchema, phone: z.string().min(3).max(40).nullable(), email: z.email().max(254).nullable() });
/** Owner-private; the public page shows the region only, an invitee the address only after acceptance. */
export const ProjectLocationSchema = z.strictObject({
  projectId: IdSchema,
  address: PostalAddressSchema.nullable(),
  regionCode: PlaceCodeSchema.nullable(),
  /** Pack format where one exists, for example a US county APN. */
  cadastralRef: z.string().min(1).max(80).nullable(),
  siteContact: SiteContactSchema.nullable(),
  siteAccessNotes: TextSchema.nullable(),
  revision: RevisionSchema,
  updatedAt: TimestampSchema,
});
export type ProjectLocation = z.infer<typeof ProjectLocationSchema>;

export const PERMIT_STATUSES = ['planned', 'applied', 'issued', 'rejected', 'expired', 'closed'] as const;
export const InspectionResultSchema = z.strictObject({
  inspectionType: TaxonomyCodeSchema.refine((c) => c.startsWith('inspection.'), { message: 'an inspection code' }),
  date: PlanDateSchema,
  outcome: z.enum(['passed', 'failed', 'partial', 'cancelled']),
  note: ShortTextSchema.nullable(),
  evidence: z.array(AttachmentRefSchema).max(20),
});
/** A record of a permit the owner (or their professional) obtained; the engine never files permits. */
const PermitRecordShape = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  planItemKey: PlanItemKeySchema.nullable(),
  jurisdiction: PlaceCodeSchema,
  permitType: TaxonomyCodeSchema.refine((c) => c.startsWith('permit.'), { message: 'a permit code' }),
  authority: NameSchema,
  number: z.string().min(1).max(80).nullable(),
  appliedAt: PlanDateSchema.nullable(),
  issuedAt: PlanDateSchema.nullable(),
  expiresAt: PlanDateSchema.nullable(),
  inspectionResults: z.array(InspectionResultSchema).max(100),
  evidence: z.array(AttachmentRefSchema).max(50),
  status: z.enum(PERMIT_STATUSES),
  createdBy: IdSchema,
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
const permitRules = <T extends { status: string; issuedAt: string | null; appliedAt: string | null }>(schema: z.ZodType<T>) => schema
  .refine((p) => p.status !== 'issued' || p.issuedAt !== null, { message: 'an issued permit records its date', path: ['issuedAt'] })
  .refine((p) => p.appliedAt === null || p.issuedAt === null || p.appliedAt <= p.issuedAt, { message: 'issued after applying', path: ['issuedAt'] });
export const PermitRecordSchema = permitRules(PermitRecordShape);
export type PermitRecord = z.infer<typeof PermitRecordSchema>;

/** Private while the project runs; becomes shared knowledge only through KNOW-001 with consent. */
export const ProjectDiaryEntrySchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  authorPersonId: IdSchema,
  entryDate: PlanDateSchema,
  text: TextSchema.refine((t) => t.trim().length > 0, { message: 'not empty' }),
  evidence: z.array(AttachmentRefSchema).max(20),
  planItemKey: PlanItemKeySchema.nullable(),
  visibility: z.enum(['owner_private', 'participants']),
  createdAt: TimestampSchema,
});
export type ProjectDiaryEntry = z.infer<typeof ProjectDiaryEntrySchema>;

/* ---------- The invited projection ---------- */

/**
 * What an invited expert or contractor sees of one shared item: the identity of the step plus exactly the listed
 * fields. Every optional key is present only when its field was shared.
 */
export const InvitedPlanItemSchema = z.strictObject({
  itemKey: PlanItemKeySchema,
  kind: ProjectPlanItemKindSchema,
  title: NameSchema,
  audiences: z.array(PlanShareAudienceSchema).min(1),
  fields: z.array(PlanShareFieldSchema).min(1),
  sharedBy: IdSchema,
  validUntil: TimestampSchema.nullable(),
  description: TextSchema.nullable().optional(),
  stepTerms: z.array(StepTermSchema).optional(),
  requiredSkills: z.array(TaxonomyCodeSchema).optional(),
  regionCode: PlaceCodeSchema.nullable().optional(),
  address: PostalAddressSchema.nullable().optional(),
  attachments: z.array(AttachmentRefSchema).optional(),
  quantity: QuantitySchema.nullable().optional(),
  window: ScheduleWindowSchema.nullable().optional(),
  duration: DurationRangeSchema.nullable().optional(),
  budgetRange: BudgetRangeSchema.nullable().optional(),
  siteContact: SiteContactSchema.nullable().optional(),
  siteAccessNotes: TextSchema.nullable().optional(),
});
export type InvitedPlanItem = z.infer<typeof InvitedPlanItemSchema>;
export const InvitedPlanViewSchema = z.strictObject({
  projection: z.literal('invited'),
  projectId: IdSchema,
  planId: IdSchema,
  planVersion: z.int().min(1),
  timeZone: IanaTimeZoneSchema,
  items: z.array(InvitedPlanItemSchema).min(1),
});
export type InvitedPlanView = z.infer<typeof InvitedPlanViewSchema>;
/**
 * Keys that must never appear in an invited view, whatever was shared: private notes, sources (which may name the
 * owner's own quotes), single-figure estimates, risk and decision notes, other invitees, offers, diary entries.
 */
export const INVITED_FORBIDDEN_KEYS = [
  'privateNotes', 'sources', 'estimate', 'riskLevel', 'decisionQuestion', 'invitee', 'invitees', 'offers', 'diary', 'previewDigest', 'confirmedBy',
  'budget', 'assumptions', 'summary', 'digest', 'drafted', 'proposed', 'approved', 'mandateId', 'cadastralRef',
] as const;

/** Per-field picks: the only path from a frozen item to another party. */
function pickShared(item: PlanItem, fields: ReadonlySet<PlanShareField>, location: ProjectLocation | null): Partial<InvitedPlanItem> {
  const out: Partial<InvitedPlanItem> = {};
  if (fields.has('scope')) out.description = item.description;
  if (fields.has('trade')) {
    out.stepTerms = item.stepTerms;
    out.requiredSkills = item.requiredSkills;
  }
  if (fields.has('locality')) out.regionCode = location?.regionCode ?? null;
  if (fields.has('address')) out.address = location?.address ?? null;
  if (fields.has('drawings')) out.attachments = item.attachments;
  if (fields.has('quantities')) out.quantity = item.quantity;
  if (fields.has('schedule')) {
    out.window = item.window;
    out.duration = item.duration;
  }
  if (fields.has('budget_range')) out.budgetRange = item.estimate;
  if (fields.has('contact')) {
    out.siteContact = location?.siteContact ?? null;
    out.siteAccessNotes = location?.siteAccessNotes ?? null;
  }
  return out;
}

export interface InvitedViewInput {
  projectId: string;
  planId: string;
  planVersion: number;
  timeZone: string;
  /** Items of the approved baseline. */
  items: readonly PlanItem[];
  shares: readonly PlanShare[];
  location: ProjectLocation | null;
  viewer: { personId: string; companyId: string | null };
  now: Date;
}
const shareTargets = (share: PlanShare, viewer: InvitedViewInput['viewer']): boolean =>
  share.invitee !== null && ((share.invitee.kind === 'person' && share.invitee.id === viewer.personId) || (share.invitee.kind === 'company' && share.invitee.id === viewer.companyId));

/**
 * The invited-plan serializer: live shares addressed to the viewer (person, or their active employer), merged per item,
 * projected field by field. `null` means "not found" for this viewer: no live share, or nothing shared in the baseline.
 * Public shares are the needs board's business and never widen an invitee's view.
 */
export function toInvitedPlanView(input: InvitedViewInput): InvitedPlanView | null {
  const live = input.shares.filter((s) => s.audience !== 'public' && s.planId === input.planId && shareLive(s, input.now) && shareTargets(s, input.viewer));
  const byKey = new Map<string, PlanShare[]>();
  for (const share of live) byKey.set(share.itemKey, [...(byKey.get(share.itemKey) ?? []), share]);
  const items: InvitedPlanItem[] = [];
  for (const item of input.items) {
    const shares = byKey.get(item.key);
    if (!shares) continue;
    const fields = new Set(shares.flatMap((s) => s.fields));
    const validUntils = shares.map((s) => s.validUntil);
    const ordered = PLAN_SHARE_FIELDS.filter((f) => fields.has(f));
    items.push(InvitedPlanItemSchema.parse({
      itemKey: item.key, kind: item.kind, title: item.title,
      audiences: PLAN_SHARE_AUDIENCES.filter((a) => shares.some((s) => s.audience === a)),
      fields: ordered,
      sharedBy: shares[0]?.confirmedBy,
      validUntil: validUntils.includes(null) ? null : validUntils.reduce((a, b) => ((a as string) > (b as string) ? a : b)),
      ...pickShared(item, fields, input.location),
    }));
  }
  if (items.length === 0) return null;
  return InvitedPlanViewSchema.parse({ projection: 'invited', projectId: input.projectId, planId: input.planId, planVersion: input.planVersion, timeZone: input.timeZone, items });
}
/** The projection the owner reviews before confirming a share: exactly what that share would reveal. */
export function sharePreview(item: PlanItem, audience: PlanShareAudience, fields: readonly PlanShareField[], location: ProjectLocation | null): Record<string, unknown> {
  return { contract: `plans:v${PLANS_CONTRACT_VERSION}:share-preview`, itemKey: item.key, kind: item.kind, title: item.title, audience, fields: PLAN_SHARE_FIELDS.filter((f) => fields.includes(f)), ...pickShared(item, new Set(fields), location) };
}

/* ---------- Licensed professionals from the pack ---------- */

/** Taxonomy jurisdiction facet for a trade (data/taxonomy/jurisdictions/<PACK>.json `trades`). */
export const TradeLicensingFacetSchema = z.strictObject({ licensing: z.enum(['varies_by_state', 'unknown']), verification: z.enum(['unverified', 'secondary', 'verified']) });
/** Country-pack licensing fact (packages/country-packs facets `licensing`, type `activity`) for the country or the region. */
export const PackLicensingFactSchema = z.strictObject({
  factId: z.string().min(1).max(120),
  scope: z.string().min(2).max(10),
  name: z.string().min(1).max(500),
  authority: z.string().min(1).max(500),
  authorityUrl: z.url().nullable(),
  required: z.boolean(),
  verification: z.string().min(1).max(40),
});
export type PackLicensingFact = z.infer<typeof PackLicensingFactSchema>;
export const LicensingFacetsSchema = z.strictObject({
  pack: z.string().regex(/^[A-Z]{2}$/).nullable(),
  regionCode: PlaceCodeSchema.nullable(),
  trades: z.record(TaxonomyCodeSchema, TradeLicensingFacetSchema),
  facts: z.array(PackLicensingFactSchema),
});
export type LicensingFacets = z.infer<typeof LicensingFacetsSchema>;
/**
 * Per plan item: which of its trades may need a licensed professional here, and the pack facts that say so. Never a
 * ruling: `likely` when a pack fact marks the activity as requiring a licence or the taxonomy facet says it varies by
 * state; `unknown` when the hub has no answer (the item then says "licensed professional may be required; ask the local
 * authority"). Unverified facts carry the taxonomy notice `messages.unverified_notice`.
 */
export const LicensingNoticeSchema = z.strictObject({
  itemKey: PlanItemKeySchema,
  status: z.enum(['likely', 'unknown']),
  trades: z.array(z.strictObject({ trade: TaxonomyCodeSchema, licensing: z.enum(['varies_by_state', 'unknown']), verification: z.string().min(1).max(40) })),
  facts: z.array(PackLicensingFactSchema),
  noticeKey: z.enum(['plans.licensing.likely', 'plans.licensing.unknown']),
  unverified: z.boolean(),
});
export type LicensingNotice = z.infer<typeof LicensingNoticeSchema>;
export function licensingNotices(items: readonly PlanItem[], facets: LicensingFacets): LicensingNotice[] {
  const requiredFacts = facets.facts.filter((f) => f.required);
  const out: LicensingNotice[] = [];
  for (const item of items) {
    const trades = [...new Set([...item.requiredSkills, ...item.stepTerms.filter((t) => t.startsWith('trade.'))])];
    if (trades.length === 0) continue;
    const tradeFacets = trades.map((trade) => {
      const facet = facets.trades[trade];
      return { trade, licensing: facet?.licensing ?? 'unknown', verification: facet?.verification ?? 'unverified' } as const;
    });
    const varies = tradeFacets.filter((t) => t.licensing === 'varies_by_state');
    if (varies.length === 0 && tradeFacets.every((t) => facets.trades[t.trade] !== undefined)) continue;
    const likely = varies.length > 0 && (requiredFacts.length > 0 || facets.pack !== null);
    out.push(LicensingNoticeSchema.parse({
      itemKey: item.key,
      status: likely ? 'likely' : 'unknown',
      trades: tradeFacets,
      facts: likely ? requiredFacts : [],
      noticeKey: likely ? 'plans.licensing.likely' : 'plans.licensing.unknown',
      unverified: tradeFacets.some((t) => t.verification === 'unverified') || requiredFacts.some((f) => f.verification !== 'official' && f.verification !== 'verified'),
    }));
  }
  return out;
}

/* ---------- Commands ---------- */

export const GetPlanQuerySchema = z.strictObject({ projectId: IdSchema });
export const CreatePlanCommandSchema = z.strictObject({ timeZone: IanaTimeZoneSchema, actor: PlanActorInputSchema, content: PlanContentSchema });
/** Opens the plan's one draft, copying the content of `basedOnVersionId` (or the approved baseline); a second open draft is a conflict. */
export const CreateDraftVersionCommandSchema = z.strictObject({ basedOnVersionId: IdSchema.nullable(), actor: PlanActorInputSchema });
export const SaveDraftContentCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, content: PlanContentSchema, actor: PlanActorInputSchema });
export const ProposePlanVersionCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, actor: PlanActorInputSchema });
/** Governance on the first-party form: no actor field, an agent can never approve. The digest is what the owner saw. */
export const ApprovePlanVersionCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, digest: DigestSchema });
export const ReturnPlanVersionCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema });
export const UpdatePlanItemStateCommandSchema = z.strictObject({
  status: PlanItemStatusSchema,
  path: PlanItemPathSchema.nullable(),
  link: PlanItemLinkSchema.nullable(),
  actualStart: PlanDateSchema.nullable(),
  actualEnd: PlanDateSchema.nullable(),
  /** `null` when the item has no state yet. */
  expectedRevision: RevisionSchema.nullable(),
});
export const RecordPlanChangeCommandSchema = z.strictObject({
  fromVersionId: IdSchema,
  toVersionId: IdSchema,
  reason: ShortTextSchema,
  cause: PlanChangeCauseSchema,
  requestedBy: PartySchema,
  accountable: PartySchema,
  agreementId: IdSchema.nullable(),
  scheduleImpactDays: z.int().min(-3650).max(3650).nullable(),
});
export const DecidePlanChangeCommandSchema = z.discriminatedUnion('decision', [
  /** Approving a change approves its target version in the same transaction (digest of what the owner saw). */
  z.strictObject({ decision: z.literal('approve'), expectedRevision: RevisionSchema, digest: DigestSchema }),
  z.strictObject({ decision: z.literal('reject'), expectedRevision: RevisionSchema }),
  z.strictObject({ decision: z.literal('withdraw'), expectedRevision: RevisionSchema }),
]);
const shareRequestShape = z.strictObject({
  itemKey: PlanItemKeySchema,
  audience: PlanShareAudienceSchema,
  invitee: PartySchema.nullable(),
  fields: z.array(PlanShareFieldSchema).max(PLAN_SHARE_FIELDS.length),
  acceptanceRef: AcceptanceRefSchema.nullable(),
});
export const PreviewPlanShareCommandSchema = shareFieldRules(shareRequestShape);
export const SharePlanItemCommandSchema = shareFieldRules(shareRequestShape.extend({ validUntil: TimestampSchema.nullable(), previewDigest: DigestSchema }));
export const SharePreviewSchema = z.strictObject({ preview: z.record(z.string(), z.unknown()), previewDigest: DigestSchema, notice: z.literal('plans.share.forwarding_notice') });
export const RevokePlanShareCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema });
export const RecordPermitCommandSchema = permitRules(PermitRecordShape.omit({ id: true, projectId: true, createdBy: true, revision: true, createdAt: true }));
export const AddDiaryEntryCommandSchema = ProjectDiaryEntrySchema.omit({ id: true, projectId: true, authorPersonId: true, createdAt: true });
export const SetProjectLocationCommandSchema = ProjectLocationSchema.omit({ projectId: true, revision: true, updatedAt: true }).extend({ expectedRevision: RevisionSchema.nullable() });
export const PlanTimingFactsSchema = z.strictObject({ items: z.array(PlanTimingFactSchema) });
export const LicensingNoticesSchema = z.strictObject({ facets: z.strictObject({ pack: z.string().nullable(), regionCode: PlaceCodeSchema.nullable() }), items: z.array(LicensingNoticeSchema) });

/* ---------- Where plans may go: nowhere outside the owner and listed invitees ---------- */

/**
 * Plans are `owner_private`: they are never indexed for search or retrieval, never federated, never part of a public
 * projection, and outbox events (the source of notifications) carry identifiers only. The invited view is fetched by the
 * invitee under their own authorization, never pushed.
 */
export const PLAN_EGRESS = { search: false, retrieval: false, federation: false, publicProjection: false, notificationPayload: 'identifiers_only' } as const;
/** Keys an outbox payload of a plan event may contain. */
export const PLAN_EVENT_PAYLOAD_KEYS = ['planId', 'projectId', 'versionId', 'version', 'status', 'changeId', 'shareId', 'inviteeKind', 'inviteeId', 'via', 'mandateId'] as const;

/* ---------- Capability registry: the project planner module (ADR 010 decision 23) ---------- */

const ref = (schema: string, contract = 'plans'): ContractRef => ({ contract, schema, version: 1 });
const MODULE = { key: 'project_planner', version: '1.0.0' } as const;
type CapabilityInput = Omit<AgentCapability, 'version' | 'status' | 'source' | 'surfaces' | 'contextKinds' | 'budgetKind' | 'acceptsUntrustedText' | 'meters'> & Partial<Pick<AgentCapability, 'surfaces' | 'contextKinds' | 'acceptsUntrustedText' | 'meters'>>;
const capability = (c: CapabilityInput): AgentCapability => ({
  version: 1, status: 'live', source: { kind: 'module', moduleKey: MODULE.key, moduleVersion: MODULE.version }, budgetKind: null,
  surfaces: ['ui', 'agent', 'mcp'], contextKinds: ['project'], acceptsUntrustedText: false, meters: [], ...c,
});
const OWNER_READ = { reads: ['owner_private'] as AgentCapability['reads'], privateDataClasses: ['private_projects', 'budgets'] as AgentCapability['privateDataClasses'] };

/**
 * Every plan operation is reachable from the interface and from the person's agent, defined once here: reads, inert
 * drafts and proposals under a `prepare` mandate, commits under `record_evidence` or `publish` mandates, and governance
 * (approving or returning a version, deciding a change) on the first-party form only. Hubs cannot widen this module.
 */
export const PROJECT_PLANNER_CAPABILITIES: readonly AgentCapability[] = [
  capability({ id: 'project_planner.get_plan', kind: 'read', input: ref('GetPlanQuerySchema'), output: ref('OwnerPlanViewSchema'), mandateAction: null, confirmation: 'none', ...OWNER_READ, sideEffects: ['none'], labelKey: 'plans.capability.getPlan' }),
  capability({ id: 'project_planner.list_shared_items', kind: 'read', input: ref('GetPlanQuerySchema'), output: ref('InvitedPlanViewSchema'), mandateAction: null, confirmation: 'none', reads: ['shared_party'], privateDataClasses: [], sideEffects: ['none'], contextKinds: ['project', 'plan_item'], labelKey: 'plans.capability.listSharedItems' }),
  capability({ id: 'project_planner.preview_share', kind: 'read', input: ref('PreviewPlanShareCommandSchema'), output: ref('SharePreviewSchema'), mandateAction: null, confirmation: 'none', ...OWNER_READ, sideEffects: ['none'], contextKinds: ['project', 'plan_item'], labelKey: 'plans.capability.previewShare' }),
  capability({ id: 'project_planner.list_licensing_notices', kind: 'read', input: ref('GetPlanQuerySchema'), output: ref('LicensingNoticesSchema'), mandateAction: null, confirmation: 'none', reads: ['owner_private'], privateDataClasses: ['private_projects'], sideEffects: ['none'], labelKey: 'plans.capability.listLicensingNotices' }),
  capability({ id: 'project_planner.list_timing_facts', kind: 'read', input: ref('GetPlanQuerySchema'), output: ref('PlanTimingFactsSchema'), mandateAction: null, confirmation: 'none', reads: ['owner_private'], privateDataClasses: ['private_projects'], sideEffects: ['none'], labelKey: 'plans.capability.listTimingFacts' }),
  capability({ id: 'project_planner.draft_plan', kind: 'draft', input: ref('SaveDraftContentCommandSchema'), output: ref('PlanVersionSchema'), mandateAction: 'prepare', confirmation: 'none', ...OWNER_READ, sideEffects: ['draft_state'], acceptsUntrustedText: true, meters: ['model_tokens'], labelKey: 'plans.capability.draftPlan' }),
  capability({ id: 'project_planner.propose_version', kind: 'draft', input: ref('ProposePlanVersionCommandSchema'), output: ref('PlanVersionSchema'), mandateAction: 'prepare', confirmation: 'none', ...OWNER_READ, sideEffects: ['draft_state'], labelKey: 'plans.capability.proposeVersion' }),
  capability({ id: 'project_planner.approve_version', kind: 'govern', input: ref('ApprovePlanVersionCommandSchema'), output: ref('PlanVersionSchema'), mandateAction: null, confirmation: 'first_party_form', ...OWNER_READ, sideEffects: ['state_change'], surfaces: ['ui', 'agent'], labelKey: 'plans.capability.approveVersion' }),
  capability({ id: 'project_planner.return_version', kind: 'govern', input: ref('ReturnPlanVersionCommandSchema'), output: ref('PlanVersionSchema'), mandateAction: null, confirmation: 'first_party_form', ...OWNER_READ, sideEffects: ['state_change'], surfaces: ['ui', 'agent'], labelKey: 'plans.capability.returnVersion' }),
  capability({ id: 'project_planner.record_change', kind: 'commit', input: ref('RecordPlanChangeCommandSchema'), output: ref('PlanChangeSchema'), mandateAction: 'record_evidence', confirmation: 'mandate', ...OWNER_READ, sideEffects: ['state_change'], meters: ['agent_actions'], labelKey: 'plans.capability.recordChange' }),
  capability({ id: 'project_planner.decide_change', kind: 'govern', input: ref('DecidePlanChangeCommandSchema'), output: ref('PlanChangeSchema'), mandateAction: null, confirmation: 'first_party_form', ...OWNER_READ, sideEffects: ['state_change'], surfaces: ['ui', 'agent'], labelKey: 'plans.capability.decideChange' }),
  capability({ id: 'project_planner.share_item', kind: 'commit', input: ref('SharePlanItemCommandSchema'), output: ref('PlanShareSchema'), mandateAction: 'publish', confirmation: 'mandate', ...OWNER_READ, sideEffects: ['state_change', 'outbound_message'], contextKinds: ['project', 'plan_item'], meters: ['agent_actions'], labelKey: 'plans.capability.shareItem' }),
  capability({ id: 'project_planner.revoke_share', kind: 'commit', input: ref('RevokePlanShareCommandSchema'), output: ref('PlanShareSchema'), mandateAction: 'publish', confirmation: 'mandate', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], contextKinds: ['project', 'plan_item'], meters: ['agent_actions'], labelKey: 'plans.capability.revokeShare' }),
  capability({ id: 'project_planner.update_item_state', kind: 'commit', input: ref('UpdatePlanItemStateCommandSchema'), output: ref('PlanItemStateSchema'), mandateAction: 'record_evidence', confirmation: 'mandate', reads: ['owner_private'], privateDataClasses: ['private_projects'], sideEffects: ['state_change'], contextKinds: ['project', 'plan_item'], meters: ['agent_actions'], labelKey: 'plans.capability.updateItemState' }),
  capability({ id: 'project_planner.record_permit', kind: 'commit', input: ref('RecordPermitCommandSchema'), output: ref('PermitRecordSchema'), mandateAction: 'record_evidence', confirmation: 'mandate', reads: ['owner_private'], privateDataClasses: ['private_projects'], sideEffects: ['state_change'], meters: ['agent_actions'], labelKey: 'plans.capability.recordPermit' }),
  capability({ id: 'project_planner.add_diary_entry', kind: 'commit', input: ref('AddDiaryEntryCommandSchema'), output: ref('ProjectDiaryEntrySchema'), mandateAction: 'record_evidence', confirmation: 'mandate', reads: ['owner_private'], privateDataClasses: ['private_projects'], sideEffects: ['state_change'], meters: ['agent_actions'], labelKey: 'plans.capability.addDiaryEntry' }),
  capability({ id: 'project_planner.set_location', kind: 'commit', input: ref('SetProjectLocationCommandSchema'), output: ref('ProjectLocationSchema'), mandateAction: 'record_evidence', confirmation: 'person_each', reads: ['owner_private'], privateDataClasses: ['private_projects'], sideEffects: ['state_change'], labelKey: 'plans.capability.setLocation' }),
];

export const PROJECT_PLANNER_MANIFEST: AgentModuleManifest = AgentModuleManifestSchema.parse({
  key: MODULE.key,
  version: MODULE.version,
  family: 'plan_to_people',
  status: 'live',
  actions: ['prepare', 'publish', 'record_evidence'],
  capabilities: PROJECT_PLANNER_CAPABILITIES,
  meters: ['model_tokens', 'agent_actions'],
  suits: ['homeowner', 'developer', 'general_contractor', 'small_contractor', 'public_client', 'design_office'],
  freeFloor: [{ meter: 'agent_actions', units: '50', window: 'month' }],
  safetySuite: 'tests/plans',
});
