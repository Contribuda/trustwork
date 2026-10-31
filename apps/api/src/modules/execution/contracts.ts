import { z } from 'zod';
import {
  AgentModuleManifestSchema, IdSchema, PartySchema, QuantitySchema, RevisionSchema, TimestampSchema, type AgentCapability, type AgentModuleManifest, type ContractRef,
} from '../../deps/contracts.js';

/**
 * Execution and evidence contracts (EXE-001). They live beside the module because the package owns no
 * `packages/contracts` file; promoting them into `packages/contracts/src/execution.ts` (next to the frozen
 * `DeliveryClaimSchema`, `AcceptanceRecordSchema` and `AssertionSchema`, which stay unchanged) is integrator
 * bookkeeping. Storage: packages/data/migrations/execution.
 *
 * Vocabulary: a claim is an assertion by the party that owes an obligation; evidence supports it; a confirmation is
 * the counterparty person's recorded decision (human-only: confirmation commands have no actor field); a dispute
 * challenges a confirmation or a defect and is decided by a trust reviewer, its appeal by a different reviewer;
 * supersession appends a correcting claim. Missing evidence is not failure: a claim without evidence is still a claim,
 * and an obligation without a claim is unknown, never late.
 */

const Hex64Schema = z.string().regex(/^[a-f0-9]{64}$/);
const TextSchema = (max: number) => z.string().trim().min(1).max(max);
const DateOnlySchema = z.iso.date();

export const CLAIM_KINDS = ['goods_delivery', 'work_performed', 'service_delivered', 'payment_made', 'remediation'] as const;
export const ClaimKindSchema = z.enum(CLAIM_KINDS);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;
export const DECISIONS = ['accepted', 'partially_accepted', 'rejected'] as const;
export const DecisionSchema = z.enum(DECISIONS);
export const EVIDENCE_KINDS = ['photo', 'delivery_note', 'acceptance_act', 'inspection_report', 'test_report', 'e_document', 'invoice', 'other'] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export const DefectSeveritySchema = z.enum(['minor', 'major', 'critical']);
export const DisputeTargetKindSchema = z.enum(['confirmation', 'defect']);
export const DisputeStatusSchema = z.enum(['open', 'decided', 'appealed', 'appeal_decided']);
export const DisputeDecisionSchema = z.enum(['upheld', 'overturned', 'partially']);
export const DisputeAppealDecisionSchema = z.enum(['upheld', 'overturned', 'partially_overturned']);

/** Which obligation kinds each claim kind answers (the database guard repeats it). */
export const CLAIM_KIND_FOR_OBLIGATION: Readonly<Record<'deliver' | 'perform' | 'pay', readonly ClaimKind[]>> = {
  deliver: ['goods_delivery'], perform: ['work_performed', 'service_delivered'], pay: ['payment_made'],
};

/** A person on their own authority, or the person's agent under a record_evidence mandate (claims, evidence, defects only). */
export const ExecutionActorSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person') }),
  z.strictObject({ via: z.literal('agent'), mandateId: IdSchema }),
]);
export type ExecutionActorInput = z.infer<typeof ExecutionActorSchema>;

export const ClaimLineSchema = z.strictObject({ ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/), quantity: QuantitySchema });
export const DecisionLineSchema = z.strictObject({
  ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/), accepted: QuantitySchema, contested: QuantitySchema.nullable(), note: TextSchema(500).nullable(),
});

/* ---------- Commands ---------- */

export const RecordClaimCommandSchema = z.strictObject({
  /** The obligation the claimant owes (null only for a remediation, which names the defect). */
  obligationId: IdSchema.nullable(),
  defectId: IdSchema.nullable(),
  kind: ClaimKindSchema,
  claimant: PartySchema,
  lines: z.array(ClaimLineSchema).max(100),
  period: z.strictObject({ from: DateOnlySchema, to: DateOnlySchema }).nullable(),
  performedAt: TimestampSchema,
  statement: TextSchema(2000).nullable(),
  /** Appends a correction of the claimant's own open claim; the original is kept and marked superseded. */
  supersedesClaimId: IdSchema.nullable(),
  actor: ExecutionActorSchema,
})
  .refine((c) => (c.kind === 'remediation') === (c.defectId !== null) && (c.kind === 'remediation') === (c.obligationId === null), { message: 'a remediation names a defect, every other claim an obligation', path: ['kind'] })
  .refine((c) => c.kind !== 'goods_delivery' || c.lines.length > 0, { message: 'a goods delivery lists delivered lines', path: ['lines'] })
  .refine((c) => c.period === null || c.period.from <= c.period.to, { message: 'the period runs forward', path: ['period'] });

export const AttachEvidenceCommandSchema = z.strictObject({
  target: z.strictObject({ kind: z.enum(['claim', 'defect']), id: IdSchema }),
  /** A FILE-001 evidence artifact uploaded to this agreement (parent kind `agreement`). */
  artifactId: IdSchema,
  artifactSha256: Hex64Schema,
  kind: EvidenceKindSchema,
  observedAt: TimestampSchema.nullable(),
  note: TextSchema(500).nullable(),
  actor: ExecutionActorSchema,
});

/** No actor field: deciding on delivered work is never delegated to an agent (`confirm_execution` is human-only). */
export const DecideClaimCommandSchema = z.strictObject({
  onBehalfOf: PartySchema,
  decision: DecisionSchema,
  lines: z.array(DecisionLineSchema).max(100),
  note: TextSchema(2000).nullable(),
  /** Hidden-works stage code from the country pack template, when the acceptance closes a stage. */
  stageCode: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).nullable(),
}).refine((c) => c.decision === 'accepted' || c.note !== null, { message: 'a partial acceptance or a rejection gives the reason', path: ['note'] });

export const ReportDefectCommandSchema = z.strictObject({
  reporter: PartySchema,
  obligationId: IdSchema.nullable(),
  claimId: IdSchema.nullable(),
  severity: DefectSeveritySchema,
  location: TextSchema(200).nullable(),
  description: TextSchema(2000),
  observedAt: TimestampSchema,
  actor: ExecutionActorSchema,
});

/** No actor field: challenging a decision is the person's own act. */
export const OpenDisputeCommandSchema = z.strictObject({
  target: z.strictObject({ kind: DisputeTargetKindSchema, id: IdSchema }),
  opener: PartySchema,
  reason: TextSchema(2000),
});
export const AppealDisputeCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: TextSchema(2000) });

/* ---------- Views (shared_party: the two parties of the agreement) ---------- */

export const ClaimStateSchema = z.enum(['claimed', 'evidence_attached', 'confirmed', 'partially_confirmed', 'rejected', 'disputed', 'superseded', 'reversed']);
export type ClaimState = z.infer<typeof ClaimStateSchema>;
export const ObligationProgressSchema = z.enum(['open', 'claimed', 'partially_accepted', 'fulfilled', 'waived']);
export const DefectStateSchema = z.enum(['open', 'remediation_claimed', 'resolved', 'disputed', 'dismissed']);

export const EvidenceViewSchema = z.strictObject({
  id: IdSchema, artifactId: IdSchema, artifactSha256: Hex64Schema, kind: EvidenceKindSchema, observedAt: TimestampSchema.nullable(), note: z.string().nullable(), attachedAt: TimestampSchema,
});
export const DecisionViewSchema = z.strictObject({
  id: IdSchema, decision: DecisionSchema, lines: z.array(DecisionLineSchema), note: z.string().nullable(), stageCode: z.string().nullable(), onBehalfOf: PartySchema, decidedAt: TimestampSchema,
});
export const ClaimViewSchema = z.strictObject({
  id: IdSchema, obligationId: IdSchema.nullable(), defectId: IdSchema.nullable(), kind: ClaimKindSchema, claimant: PartySchema, counterparty: PartySchema, lines: z.array(ClaimLineSchema),
  period: z.strictObject({ from: DateOnlySchema, to: DateOnlySchema }).nullable(), performedAt: TimestampSchema, statement: z.string().nullable(), supersedesClaimId: IdSchema.nullable(),
  via: z.enum(['person', 'agent']), state: ClaimStateSchema, evidence: z.array(EvidenceViewSchema), decision: DecisionViewSchema.nullable(), createdAt: TimestampSchema,
});
export const ObligationViewSchema = z.strictObject({
  id: IdSchema, position: z.int().min(0), kind: z.enum(['deliver', 'perform', 'pay', 'accept']), obligor: PartySchema, due: TimestampSchema.nullable(), progress: ObligationProgressSchema,
});
export const DefectViewSchema = z.strictObject({
  id: IdSchema, obligationId: IdSchema.nullable(), claimId: IdSchema.nullable(), reporter: PartySchema, subject: PartySchema, severity: DefectSeveritySchema, location: z.string().nullable(),
  description: z.string(), observedAt: TimestampSchema, state: DefectStateSchema, evidence: z.array(EvidenceViewSchema), createdAt: TimestampSchema,
});
export const DisputeViewSchema = z.strictObject({
  id: IdSchema, target: z.strictObject({ kind: DisputeTargetKindSchema, id: IdSchema }), opener: PartySchema, reason: z.string(), status: DisputeStatusSchema,
  decision: DisputeDecisionSchema.nullable(), decisionReason: z.string().nullable(), decidedAt: TimestampSchema.nullable(), appealReason: z.string().nullable(),
  appealDecision: DisputeAppealDecisionSchema.nullable(), appealDecisionReason: z.string().nullable(), appealDecidedAt: TimestampSchema.nullable(),
  /** What finally stands: the record (`upheld`), its reversal (`overturned`), or neither fully (`partially`); null while pending. */
  outcome: DisputeDecisionSchema.nullable(), revision: RevisionSchema, createdAt: TimestampSchema,
});
export const ObservationViewSchema = z.strictObject({
  id: IdSchema, source: z.strictObject({ kind: z.enum(['execution_confirmation', 'task_acceptance', 'task_rejection']), id: IdSchema }), obligationId: IdSchema.nullable(),
  subject: PartySchema, dimension: z.enum(['timing', 'quality', 'payment']), outcome: z.enum(['on_time', 'late', 'excused_delay', 'unknown', 'accepted', 'partially_accepted', 'rejected']),
  dueAt: TimestampSchema.nullable(), performedAt: TimestampSchema.nullable(), allowanceDays: z.int().min(0), lateDays: z.int().min(0).nullable(),
  attribution: z.enum(['subject', 'counterparty', 'external', 'unknown']), excludedReason: z.enum(['client_caused_change', 'external_change', 'unattributed_change', 'no_due_date']).nullable(),
  planChangeIds: z.array(IdSchema), baselinePlanVersionId: IdSchema.nullable(), createdAt: TimestampSchema,
});
export const TimingFactViewSchema = z.strictObject({
  changeId: IdSchema, cause: z.enum(['owner_request', 'counterparty', 'site_condition', 'regulatory', 'external', 'unknown']), accountable: PartySchema,
  scheduleImpactDays: z.int().nullable(), decidedAt: TimestampSchema,
});
export const ExecutionViewSchema = z.strictObject({
  projection: z.literal('shared_party'),
  agreement: z.strictObject({ id: IdSchema, termsKind: z.enum(['rfq_quote', 'task', 'consultation']), status: z.string(), buyer: PartySchema, seller: PartySchema, side: z.enum(['buyer', 'seller']) }),
  obligations: z.array(ObligationViewSchema),
  claims: z.array(ClaimViewSchema),
  defects: z.array(DefectViewSchema),
  disputes: z.array(DisputeViewSchema),
  observations: z.array(ObservationViewSchema),
  /** Approved plan changes that can move this agreement's dates: cause, accountable party and impact, never the reason text. */
  timingFacts: z.array(TimingFactViewSchema),
  completed: z.boolean(),
});
export type ExecutionView = z.infer<typeof ExecutionViewSchema>;

/** Outbox payload keys: identifiers only (notifications read projections under the recipient's authority). */
export const EXECUTION_EVENT_PAYLOAD_KEYS = ['agreementId', 'claimId', 'confirmationId', 'defectId', 'disputeId', 'evidenceId', 'kind', 'decision', 'via'] as const;

/* ---------- Derived states (pure) ---------- */

/** What finally stands after a dispute and its appeal; null while the case is open or appealed. */
export function disputeOutcome(d: { status: z.infer<typeof DisputeStatusSchema>; decision: z.infer<typeof DisputeDecisionSchema> | null; appealDecision: z.infer<typeof DisputeAppealDecisionSchema> | null }): z.infer<typeof DisputeDecisionSchema> | null {
  if (d.status === 'open' || d.status === 'appealed' || d.decision === null) return null;
  if (d.status === 'decided' || d.appealDecision === null || d.appealDecision === 'upheld') return d.decision;
  if (d.appealDecision === 'partially_overturned' || d.decision === 'partially') return 'partially';
  return d.decision === 'upheld' ? 'overturned' : 'upheld';
}

export function claimState(input: { superseded: boolean; evidenceCount: number; decision: z.infer<typeof DecisionSchema> | null; dispute: { pending: boolean; outcome: z.infer<typeof DisputeDecisionSchema> | null } | null }): ClaimState {
  if (input.superseded) return 'superseded';
  if (input.decision !== null) {
    if (input.dispute?.pending) return 'disputed';
    if (input.dispute?.outcome === 'overturned') return 'reversed';
    return input.decision === 'accepted' ? 'confirmed' : input.decision === 'partially_accepted' ? 'partially_confirmed' : 'rejected';
  }
  return input.evidenceCount > 0 ? 'evidence_attached' : 'claimed';
}

/* ---------- Capability registry (ADR 010 decision 23): every operation for the interface and the person's agent ---------- */

const ref = (schema: string): ContractRef => ({ contract: 'execution', schema, version: 1 });
const MODULE = { key: 'execution_evidence', version: '1.0.0' } as const;
const capability = (c: Omit<AgentCapability, 'version' | 'status' | 'source' | 'surfaces' | 'acceptsUntrustedText' | 'meters' | 'budgetKind'> & Partial<Pick<AgentCapability, 'surfaces'>>): AgentCapability => ({
  version: 1, status: 'live', source: { kind: 'module', moduleKey: MODULE.key, moduleVersion: MODULE.version }, budgetKind: null, surfaces: ['ui', 'agent', 'mcp'],
  acceptsUntrustedText: false, meters: c.kind === 'commit' ? ['agent_actions'] : [], ...c,
});
const SHARED: Pick<AgentCapability, 'reads' | 'privateDataClasses'> = { reads: ['shared_party'], privateDataClasses: [] };
export const EXECUTION_EVIDENCE_CAPABILITIES: readonly AgentCapability[] = [
  capability({ id: 'execution_evidence.get_execution', kind: 'read', mandateAction: null, confirmation: 'none', sideEffects: ['none'], input: ref('ExecutionQuerySchema'), output: ref('ExecutionViewSchema'), contextKinds: ['agreement'], ...SHARED, labelKey: 'execution.capability.getExecution' }),
  capability({ id: 'execution_evidence.record_claim', kind: 'commit', mandateAction: 'record_evidence', confirmation: 'mandate', sideEffects: ['state_change', 'outbound_message'], input: ref('RecordClaimCommandSchema'), output: ref('ExecutionViewSchema'), contextKinds: ['agreement'], ...SHARED, labelKey: 'execution.capability.recordClaim' }),
  capability({ id: 'execution_evidence.attach_evidence', kind: 'commit', mandateAction: 'record_evidence', confirmation: 'mandate', sideEffects: ['state_change'], input: ref('AttachEvidenceCommandSchema'), output: ref('ExecutionViewSchema'), contextKinds: ['agreement'], ...SHARED, labelKey: 'execution.capability.attachEvidence' }),
  capability({ id: 'execution_evidence.report_defect', kind: 'commit', mandateAction: 'record_evidence', confirmation: 'mandate', sideEffects: ['state_change', 'outbound_message'], input: ref('ReportDefectCommandSchema'), output: ref('ExecutionViewSchema'), contextKinds: ['agreement'], ...SHARED, labelKey: 'execution.capability.reportDefect' }),
  capability({ id: 'execution_evidence.decide_claim', kind: 'commit', mandateAction: 'confirm_execution', confirmation: 'person_each', sideEffects: ['state_change', 'outbound_message', 'reputation_signal'], input: ref('DecideClaimCommandSchema'), output: ref('ExecutionViewSchema'), contextKinds: ['agreement'], ...SHARED, surfaces: ['ui', 'agent'], labelKey: 'execution.capability.decideClaim' }),
  capability({ id: 'execution_evidence.open_dispute', kind: 'commit', mandateAction: 'confirm_execution', confirmation: 'person_each', sideEffects: ['state_change', 'reputation_signal'], input: ref('OpenDisputeCommandSchema'), output: ref('ExecutionViewSchema'), contextKinds: ['agreement'], ...SHARED, surfaces: ['ui', 'agent'], labelKey: 'execution.capability.openDispute' }),
  capability({ id: 'execution_evidence.appeal_dispute', kind: 'commit', mandateAction: 'confirm_execution', confirmation: 'person_each', sideEffects: ['state_change', 'reputation_signal'], input: ref('AppealDisputeCommandSchema'), output: ref('ExecutionViewSchema'), contextKinds: ['agreement'], ...SHARED, surfaces: ['ui', 'agent'], labelKey: 'execution.capability.appealDispute' }),
];
export const EXECUTION_EVIDENCE_MANIFEST: AgentModuleManifest = AgentModuleManifestSchema.parse({
  key: MODULE.key, version: MODULE.version, family: 'delivery', status: 'live', actions: ['record_evidence', 'confirm_execution'], capabilities: EXECUTION_EVIDENCE_CAPABILITIES,
  meters: ['agent_actions'], suits: ['homeowner', 'developer', 'small_contractor', 'general_contractor', 'subcontractor', 'supplier', 'individual_professional'], freeFloor: [],
  safetySuite: 'tests/trust',
});
