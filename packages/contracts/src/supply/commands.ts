import { z } from 'zod';
import { PartySchema } from '../access.js';
import { DigestSchema } from '../common/digest-schema.js';
import { BusinessDateSchema, IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { IdempotencyKeySchema } from '../common/idempotency.js';
import { VersionNumberSchema } from '../common/version.js';
import { ApprovalRoutePayloadSchema, ApprovalSubjectKindSchema } from './approvals.js';
import { BudgetLineSchema } from './cost-control.js';
import { IntakeChannelSchema, IntakeDocumentKindSchema } from './intake.js';
import { ExternalOrderLineSchema, CallOffLineSchema } from './orders.js';
import { GoodsReceiptLineSchema, SupplierReturnSchema } from './receiving.js';
import { RequisitionLineSchema, RequisitionSourceSchema, AllocationTargetKindSchema } from './requisitions.js';
import { BidLevelSheetPayloadSchema, AwardDecisionSchema } from './sourcing.js';
import { SupplierStatusSchema } from './suppliers.js';
import { StockMovementFieldsSchema, stockMovementViolations } from './stock.js';
import { KeySchema, MaterialRefSchema, PositiveQuantitySchema, EvidenceRefsSchema, PrioritySchema } from './common.js';
import { PaymentProposalItemSchema } from './payments.js';

/**
 * Inputs and outputs of the suite's capabilities (`capabilities.ts`). Every command that changes shared state carries
 * the expected revision and an idempotency key; nothing here carries free text that could authorize anything.
 */

const commit = { expectedRevision: RevisionSchema, idempotencyKey: IdempotencyKeySchema };

export const ListSupplyDocumentsQuerySchema = z.strictObject({
  kind: z.enum(['requisition', 'approval_request', 'order', 'goods_receipt', 'stock', 'trade_invoice', 'payment_proposal', 'supplier_record', 'analytics']),
  projectId: IdSchema.nullable(),
  cursor: z.string().max(200).nullable(),
  limit: z.int().min(1).max(100),
});
export const SupplyDocumentListSchema = z.strictObject({
  items: z.array(z.strictObject({ kind: z.string().regex(/^[a-z_]{3,40}$/), id: IdSchema, status: z.string().regex(/^[a-z_]{2,40}$/), updatedAt: TimestampSchema })).max(100),
  nextCursor: z.string().max(200).nullable(),
});

export const DraftRequisitionCommandSchema = z.strictObject({
  owner: PartySchema,
  projectId: IdSchema.nullable(),
  source: RequisitionSourceSchema,
  priority: PrioritySchema,
  lines: z.array(RequisitionLineSchema).min(1).max(500),
  /** Files, photos or spreadsheets the draft was extracted from (untrusted input, drafts only). */
  sourceFileIds: z.array(IdSchema).max(20),
});
export const SubmitRequisitionCommandSchema = z.strictObject({ requisitionId: IdSchema, version: VersionNumberSchema, ...commit });
export const AllocateRequisitionCommandSchema = z.strictObject({ requisitionId: IdSchema, lineKey: KeySchema, quantity: PositiveQuantitySchema, target: z.strictObject({ kind: AllocationTargetKindSchema, id: IdSchema }), ...commit });

export const DecideApprovalCommandSchema = z.strictObject({
  approvalRequestId: IdSchema,
  step: KeySchema,
  decision: z.enum(['approve', 'reject', 'return']),
  /** The digest the person saw on the decision card; a different current digest refuses the decision. */
  subjectDigest: DigestSchema,
  reason: ShortTextSchema.nullable(),
  ...commit,
});
export const DelegateApprovalsCommandSchema = z.strictObject({ companyId: IdSchema, delegatePersonId: IdSchema, subjectKinds: z.array(ApprovalSubjectKindSchema).min(1), validFrom: TimestampSchema, validUntil: TimestampSchema, ...commit });
export const DraftApprovalRouteCommandSchema = z.strictObject({ owner: PartySchema, subjectKind: ApprovalSubjectKindSchema, payload: ApprovalRoutePayloadSchema, templateKey: KeySchema.nullable() });
export const ActivateApprovalRouteCommandSchema = z.strictObject({ routeVersionId: IdSchema, digest: DigestSchema, ...commit });

export const MaintainSupplierCommandSchema = z.strictObject({
  supplierRecordId: IdSchema.nullable(),
  link: z.strictObject({ kind: z.enum(['company', 'sourced_company', 'external_counterparty']), id: IdSchema }),
  status: SupplierStatusSchema,
  ...commit,
});
export const RecordSupplierAssessmentCommandSchema = z.strictObject({ supplierRecordId: IdSchema, assessmentDraftId: IdSchema, shareWithSupplier: z.boolean(), ...commit });
export const DraftSupplierAssessmentCommandSchema = z.strictObject({ supplierRecordId: IdSchema, criteriaVersion: z.int().min(1), period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }) });

export const RemindSuppliersCommandSchema = z.strictObject({ rfqId: IdSchema, rfqVersionId: IdSchema, invitationIds: z.array(IdSchema).min(1).max(100), templateKey: KeySchema, ...commit });
export const ReminderBatchResultSchema = z.strictObject({ sent: z.int().min(0), skippedQuota: z.int().min(0), skippedResponded: z.int().min(0) });
export const AnswerClarificationCommandSchema = z.strictObject({ rfqId: IdSchema, clarificationId: IdSchema, approvedFactIds: z.array(IdSchema).min(1).max(20), material: z.boolean(), ...commit });
export const DraftBidLevelSheetCommandSchema = z.strictObject({ rfqId: IdSchema, rfqVersionId: IdSchema, payload: BidLevelSheetPayloadSchema });
export const ProposeAwardCommandSchema = z.strictObject({ rfqId: IdSchema, bidLevelSheetVersionId: IdSchema, selection: AwardDecisionSchema.shape.selection, reasons: AwardDecisionSchema.shape.reasons, ...commit });
export const ExecuteAwardCommandSchema = z.strictObject({ awardDecisionId: IdSchema, transactionBudgetId: IdSchema, ...commit });
export const NotifyOutcomesCommandSchema = z.strictObject({ rfqId: IdSchema, awardDecisionId: IdSchema.nullable(), includeFeedbackBands: z.boolean(), ...commit });

export const SubmitIntakeDocumentCommandSchema = z.strictObject({ owner: PartySchema, fileId: IdSchema, kind: IntakeDocumentKindSchema, channel: IntakeChannelSchema });
export const AcceptExtractionReviewCommandSchema = z.strictObject({ intakeDocumentId: IdSchema, extractionRunId: IdSchema.nullable(), corrections: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(2000).nullable()), ...commit });

export const ProposeSubstitutionCommandSchema = z.strictObject({ context: z.strictObject({ kind: z.enum(['rfq', 'order', 'requisition']), id: IdSchema }), originalLineRef: KeySchema, proposed: MaterialRefSchema, evidenceRefs: EvidenceRefsSchema.min(1), ...commit });

export const DraftBudgetCommandSchema = z.strictObject({ budgetId: IdSchema, lines: z.array(BudgetLineSchema.omit({ id: true })).min(1).max(500) });
export const RequestBudgetChangeCommandSchema = z.strictObject({ budgetLineId: IdSchema, delta: z.strictObject({ minorUnits: z.string().regex(/^(0|-?[1-9]\d*)$/), currency: z.string().regex(/^[A-Z]{3}$/) }), reason: ShortTextSchema, planChangeId: IdSchema.nullable(), ...commit });

export const PlaceCallOffCommandSchema = z.strictObject({ frameworkAgreementId: IdSchema, lines: z.array(CallOffLineSchema).min(1).max(500), transactionBudgetId: IdSchema, ...commit });
export const RecordExternalOrderCommandSchema = z.strictObject({ supplierRecordId: IdSchema, externalCounterpartyId: IdSchema, lines: z.array(ExternalOrderLineSchema).min(1).max(500), neededBy: BusinessDateSchema.nullable(), transactionBudgetId: IdSchema, ...commit });
export const ChangeOrderCommandSchema = z.strictObject({ orderId: IdSchema, changeKind: z.enum(['quantity', 'date', 'line_added', 'line_removed']), lineKey: KeySchema, quantity: PositiveQuantitySchema.nullable(), date: BusinessDateSchema.nullable(), ...commit });
export const CloseOrderLineCommandSchema = z.strictObject({ orderId: IdSchema, lineKey: KeySchema, reason: ShortTextSchema, ...commit });

export const ProposeDeliverySlotCommandSchema = z.strictObject({ stockLocationId: IdSchema, orderId: IdSchema, startsAt: TimestampSchema, endsAt: TimestampSchema, resourceIds: z.array(IdSchema).max(10), ...commit });
export const ConfirmDeliverySlotCommandSchema = z.strictObject({ deliverySlotId: IdSchema, ...commit });
export const RecordGoodsReceiptCommandSchema = z.strictObject({
  stockLocationId: IdSchema,
  basis: z.strictObject({ kind: z.enum(['order', 'external_order', 'stock_transfer', 'supplier_return']), id: IdSchema }),
  clientId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  deviceTime: TimestampSchema,
  lines: z.array(GoodsReceiptLineSchema).min(1).max(500),
  photoRefs: EvidenceRefsSchema,
  ...commit,
});
export const AcceptDeliveredGoodsCommandSchema = z.strictObject({ deliveryClaimId: IdSchema, goodsReceiptIds: z.array(IdSchema).min(1), ...commit });
export const RequestReturnCommandSchema = z.strictObject({ basis: SupplierReturnSchema.shape.basis, lines: SupplierReturnSchema.shape.lines, reason: ShortTextSchema, ...commit });
export const MoveStockCommandSchema = z.strictObject({ movement: StockMovementFieldsSchema.omit({ id: true, recordedByPersonId: true, occurredAt: true }), ...commit })
  .superRefine((c, ctx) => { for (const message of stockMovementViolations(c.movement)) ctx.addIssue({ code: 'custom', message, path: ['movement'] }); });

export const CaptureTradeInvoiceCommandSchema = z.strictObject({ recipient: PartySchema, intakeDocumentId: IdSchema.nullable(), eDocumentExchangeId: IdSchema.nullable(), basis: z.strictObject({ kind: z.enum(['order', 'external_order', 'agreement', 'pay_application', 'milestone']), id: IdSchema }), ...commit });
export const ResolveMatchExceptionCommandSchema = z.strictObject({ tradeInvoiceId: IdSchema, lineNo: z.int().min(1), messageTemplateKey: KeySchema, ...commit });
export const ClearRiskSignalCommandSchema = z.strictObject({ paymentRiskSignalId: IdSchema, outcome: z.enum(['cleared', 'confirmed']), reason: ShortTextSchema, ...commit });
export const DraftPaymentProposalCommandSchema = z.strictObject({ owner: PartySchema, fundingBudgetId: IdSchema, items: z.array(PaymentProposalItemSchema).min(1).max(1000) });
export const ReleasePaymentsCommandSchema = z.strictObject({ proposalVersionId: IdSchema, proposalDigest: DigestSchema, instructionIds: z.array(IdSchema).min(1).max(1000), ...commit });
export const RecordExternalPaymentCommandSchema = z.strictObject({ paymentInstructionId: IdSchema, paidOn: BusinessDateSchema, evidenceRefs: EvidenceRefsSchema.min(1), ...commit });
export const RunAccountingExportCommandSchema = z.strictObject({ connectionId: IdSchema, objects: z.array(z.enum(['suppliers', 'cost_codes', 'purchase_orders', 'receipts', 'bills', 'credit_notes', 'payments'])).min(1), since: TimestampSchema.nullable(), ...commit });
export const AccountingExportResultSchema = z.strictObject({ exportId: IdSchema, objectCount: z.int().min(0), payloadDigest: DigestSchema, outcome: z.enum(['succeeded', 'failed', 'outcome_unknown']) });
export const DraftProcurementReportCommandSchema = z.strictObject({ owner: PartySchema, period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }), sections: z.array(z.enum(['spend', 'prices', 'suppliers', 'fulfilment', 'cycle_times', 'team_throughput'])).min(1) });
export const ProcurementReportDraftSchema = z.strictObject({ id: IdSchema, owner: PartySchema, period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }), sectionKeys: z.array(z.string().regex(/^[a-z_]{3,40}$/)), audience: z.literal('owner_private') });

export const IssueTradeInvoiceCommandSchema = z.strictObject({ orderId: IdSchema, lines: z.array(z.strictObject({ orderLineRef: KeySchema, quantity: PositiveQuantitySchema })).min(1).max(5000), dueDate: BusinessDateSchema, ...commit });
export const SendDispatchNoticeCommandSchema = z.strictObject({ orderId: IdSchema, lines: z.array(z.strictObject({ orderLineRef: KeySchema, quantity: PositiveQuantitySchema })).min(1).max(500), carrier: z.string().max(120).nullable(), trackingRef: z.string().max(120).nullable(), ...commit });
export const ViewInvoiceStatusQuerySchema = z.strictObject({ tradeInvoiceId: IdSchema });
export const ChangePayeeCommandSchema = z.strictObject({ companyId: IdSchema, providerConnectionId: IdSchema, hostedFormSessionId: IdSchema, ...commit });
