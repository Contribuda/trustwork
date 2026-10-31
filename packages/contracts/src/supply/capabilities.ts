import { z } from 'zod';
import {
  AgentCapabilitySchema, ApprovalPolicySchema, BUDGET_KIND_BY_ACTION, DEFAULT_APPROVAL_BY_ACTION, isHumanOnlyAction,
  type AgentCapability, type ApprovalPolicy, type CapabilityConfirmation, type CapabilityKind, type CapabilitySurface, type ContextKindV2,
  type MandateActionV2, type Meter, type PrivateDataClass, type SideEffect,
} from '../agent-catalog.js';

/**
 * The suite's entries for the one capability registry of ADR 010 decision 23 (agent parity), as data. Each entry wraps
 * a frozen `AgentCapability` (AGT-002) and adds what the parity table of docs/engine/procurement-and-supply.md states:
 * the interface flow, the design's dotted operation names, the default approval of mandate templates, stricter
 * approvals for named cases, and whether a person confirms each time (`humanOnly`).
 *
 * Ids follow the frozen format `<agent module key>.<operation>` (ADR 012 decision 36). Inputs and outputs reference
 * exported schemas: contract `supply` resolves to `packages/contracts/src/supply/index.ts`, other contracts to
 * `packages/contracts/src/<contract>.ts`. PRC-023 registers these entries in the runtime registry; this file only
 * declares them (status `proposed` until a use case exists).
 */

export const SUPPLY_MODULE_KEYS = ['procurement', 'requisition_desk', 'sourcing_desk', 'document_intake', 'receiving_clerk', 'payables_desk', 'supply_watch', 'order_desk', 'core'] as const;
export const SupplyModuleKeySchema = z.enum(SUPPLY_MODULE_KEYS);

/** Capabilities the suite relies on that another package already declares (the supplier answers RFQs through `quoting`). */
export const REUSED_CAPABILITY_IDS = ['quoting.draft_quote', 'quoting.send_quote'] as const;

export const StricterCaseSchema = z.strictObject({ case: z.string().regex(/^[a-z][a-z_]{2,60}$/), approval: ApprovalPolicySchema });

const PERSON: readonly CapabilityConfirmation[] = ['person_each', 'person_each_step_up'];
const GOVERN: readonly CapabilityConfirmation[] = ['first_party_form', 'first_party_step_up'];
const rank = (p: ApprovalPolicy) => (p.mode === 'ask_each' ? 3 : p.mode === 'ask_above' ? 2 : p.mode === 'ask_first' ? 1 : 0);

export const SupplyCapabilityEntrySchema = z.strictObject({
  capability: AgentCapabilitySchema,
  /** Dotted names used by the design's parity table (one entry may serve several rows). */
  designOperations: z.array(z.string().regex(/^[a-z]+(\.[a-z_*]+){1,3}$/)).min(1),
  /** First-party interface route that performs the same use case. */
  uiRoute: z.string().regex(/^\/app\/[a-z0-9/_-]+$/),
  /** Default approval of the mandate templates modules propose; `null` for reads, drafts and governance. */
  defaultApproval: ApprovalPolicySchema.nullable(),
  stricterCases: z.array(StricterCaseSchema).max(5),
  /** A person confirms every single time (human-only verbs, person-confirmed commits, governance). */
  humanOnly: z.boolean(),
}).superRefine((e, ctx) => {
  const c = e.capability;
  const add = (message: string) => ctx.addIssue({ code: 'custom', message, path: [] });
  const personEach = PERSON.includes(c.confirmation) || GOVERN.includes(c.confirmation);
  if (e.humanOnly !== personEach) add('humanOnly exactly when a person confirms each time');
  if (c.mandateAction !== null && isHumanOnlyAction(c.mandateAction) && !e.humanOnly) add('human-only mandate actions are humanOnly');
  if (c.kind === 'commit' && e.defaultApproval === null) add('a commit declares its default approval');
  if (c.kind !== 'commit' && (e.defaultApproval !== null || e.stricterCases.length > 0)) add('only commits carry approvals');
  if (e.humanOnly && e.defaultApproval !== null && e.defaultApproval.mode !== 'ask_each') add('human-only entries ask each time');
  if (c.mandateAction === 'approve' && (c.surfaces.includes('mcp') || c.surfaces.includes('a2a'))) add('approvals are never reachable from connections');
  if (c.mandateAction === 'release_payment' && e.defaultApproval?.mode === 'pre_authorized') add('payment release is never pre-authorized by default');
  if (e.defaultApproval && e.stricterCases.some((s) => rank(s.approval) <= rank(e.defaultApproval!))) add('stricter cases are stricter than the default');
  if (!c.surfaces.includes('ui') || !c.surfaces.includes('agent')) add('every entry is reachable from the interface and the agent');
});
export type SupplyCapabilityEntry = z.infer<typeof SupplyCapabilityEntrySchema>;

type Spec = {
  id: string;
  kind: CapabilityKind;
  action: MandateActionV2 | null;
  confirmation?: CapabilityConfirmation;
  approval?: ApprovalPolicy | null;
  stricter?: z.infer<typeof StricterCaseSchema>[];
  input: [string, string];
  output: [string, string];
  contexts: ContextKindV2[];
  reads?: AgentCapability['reads'];
  privateData?: PrivateDataClass[];
  effects: SideEffect[];
  untrusted?: boolean;
  meters?: Meter[];
  surfaces?: CapabilitySurface[];
  route: string;
  design: string[];
};

const camel = (s: string) => s.replace(/[._]([a-z])/g, (_, ch: string) => ch.toUpperCase());

function entry(s: Spec): SupplyCapabilityEntry {
  const moduleKey = s.id.split('.')[0]!;
  const confirmation: CapabilityConfirmation = s.confirmation ?? (s.kind === 'commit' ? 'mandate' : 'none');
  const humanOnly = PERSON.includes(confirmation) || GOVERN.includes(confirmation);
  const approval = s.kind === 'commit' ? (s.approval ?? (humanOnly ? { mode: 'ask_each' } : DEFAULT_APPROVAL_BY_ACTION[s.action!])) : null;
  const defaultSurfaces: CapabilitySurface[] = s.kind === 'govern' || s.action === 'approve' ? ['ui', 'agent'] : ['ui', 'agent', 'mcp'];
  const capability: AgentCapability = {
    id: s.id,
    version: 1,
    source: { kind: 'module', moduleKey, moduleVersion: '1.0.0' },
    kind: s.kind,
    input: { contract: s.input[0], schema: s.input[1], version: 1 },
    output: { contract: s.output[0], schema: s.output[1], version: 1 },
    mandateAction: s.kind === 'commit' || s.kind === 'draft' ? s.action : null,
    contextKinds: s.contexts,
    confirmation,
    budgetKind: s.kind === 'commit' && s.action ? BUDGET_KIND_BY_ACTION[s.action] : null,
    reads: s.reads ?? ['party_private'],
    privateDataClasses: s.privateData ?? [],
    sideEffects: s.effects,
    acceptsUntrustedText: s.untrusted ?? false,
    meters: s.meters ?? (s.kind === 'commit' ? ['agent_actions'] : s.kind === 'draft' ? ['model_tokens'] : []),
    surfaces: s.surfaces ?? defaultSurfaces,
    status: 'proposed',
    labelKey: `procurement.capability.${camel(s.id)}`,
  };
  return { capability, designOperations: s.design, uiRoute: s.route, defaultApproval: approval, stricterCases: s.stricter ?? [], humanOnly };
}

const S = 'supply';
const askEach: ApprovalPolicy = { mode: 'ask_each' };
const askFirst5: ApprovalPolicy = { mode: 'ask_first', count: 5 };

/** The agent parity table of the procurement and supply design, as data. */
export const SUPPLY_CAPABILITIES: readonly SupplyCapabilityEntry[] = [
  entry({ id: 'procurement.list_documents', kind: 'read', action: null, input: [S, 'ListSupplyDocumentsQuerySchema'], output: [S, 'SupplyDocumentListSchema'], contexts: ['project', 'company'], reads: ['party_private', 'shared_party'], privateData: ['budgets'], effects: ['none'], route: '/app/procurement', design: ['procurement.*.read'] }),
  entry({ id: 'order_desk.view_invoice_status', kind: 'read', action: null, input: [S, 'ViewInvoiceStatusQuerySchema'], output: [S, 'SupplierInvoiceStatusViewSchema'], contexts: ['order'], reads: ['shared_party'], effects: ['none'], route: '/app/sales/invoices', design: ['sales.invoice.status'] }),

  entry({ id: 'requisition_desk.draft_requisition', kind: 'draft', action: 'prepare', input: [S, 'DraftRequisitionCommandSchema'], output: [S, 'RequisitionSchema'], contexts: ['project', 'plan_item'], effects: ['draft_state'], untrusted: true, route: '/app/requisitions/new', design: ['procurement.requisition.draft'] }),
  entry({ id: 'requisition_desk.submit_requisition', kind: 'commit', action: 'communicate', approval: askFirst5, input: [S, 'SubmitRequisitionCommandSchema'], output: [S, 'RequisitionVersionSchema'], contexts: ['project'], effects: ['state_change', 'outbound_message'], route: '/app/requisitions', design: ['procurement.requisition.submit'] }),
  entry({ id: 'requisition_desk.allocate_requisition', kind: 'commit', action: 'maintain_records', input: [S, 'AllocateRequisitionCommandSchema'], output: [S, 'RequisitionAllocationSchema'], contexts: ['project'], effects: ['state_change'], route: '/app/requisitions/sourcing', design: ['procurement.requisition.allocate'] }),

  entry({ id: 'procurement.decide_approval', kind: 'commit', action: 'approve', confirmation: 'person_each', input: [S, 'DecideApprovalCommandSchema'], output: [S, 'ApprovalDecisionSchema'], contexts: ['project', 'company', 'rfq', 'order', 'agreement'], effects: ['state_change'], route: '/app/approvals', design: ['procurement.approval.decide'] }),
  entry({ id: 'procurement.delegate_approvals', kind: 'commit', action: 'maintain_records', approval: askEach, input: [S, 'DelegateApprovalsCommandSchema'], output: [S, 'ApprovalDelegationSchema'], contexts: ['company'], effects: ['state_change'], route: '/app/approvals/settings', design: ['procurement.approval.delegate'] }),
  entry({ id: 'procurement.draft_route', kind: 'draft', action: 'prepare', input: [S, 'DraftApprovalRouteCommandSchema'], output: [S, 'ApprovalRouteVersionSchema'], contexts: ['company'], effects: ['draft_state'], route: '/app/approvals/routes', design: ['procurement.routes.edit'] }),
  entry({ id: 'procurement.activate_route', kind: 'commit', action: 'approve', confirmation: 'person_each', input: [S, 'ActivateApprovalRouteCommandSchema'], output: [S, 'ApprovalRouteVersionSchema'], contexts: ['company'], effects: ['state_change'], route: '/app/approvals/routes', design: ['procurement.routes.activate'] }),

  entry({ id: 'procurement.maintain_supplier', kind: 'commit', action: 'maintain_records', stricter: [{ case: 'status_blocked', approval: askEach }], input: [S, 'MaintainSupplierCommandSchema'], output: [S, 'SupplierRecordSchema'], contexts: ['company'], effects: ['state_change'], route: '/app/suppliers', design: ['procurement.suppliers.maintain'] }),
  entry({ id: 'procurement.draft_supplier_assessment', kind: 'draft', action: 'prepare', input: [S, 'DraftSupplierAssessmentCommandSchema'], output: [S, 'SupplierAssessmentSchema'], contexts: ['company'], effects: ['draft_state'], route: '/app/suppliers', design: ['procurement.suppliers.assess'] }),
  entry({ id: 'procurement.record_supplier_assessment', kind: 'commit', action: 'maintain_records', approval: askEach, input: [S, 'RecordSupplierAssessmentCommandSchema'], output: [S, 'SupplierAssessmentSchema'], contexts: ['company'], effects: ['state_change'], route: '/app/suppliers', design: ['procurement.suppliers.assess'] }),

  entry({ id: 'sourcing_desk.draft_rfq', kind: 'draft', action: 'prepare', input: ['procurement', 'CreateRfqDraftCommandSchema'], output: ['procurement', 'RfqVersionSchema'], contexts: ['project', 'rfq'], privateData: ['negotiation_constraints'], effects: ['draft_state'], untrusted: true, route: '/app/sourcing/new', design: ['procurement.sourcing.draft_rfq'] }),
  entry({ id: 'sourcing_desk.publish_rfq', kind: 'commit', action: 'publish', input: ['procurement', 'PublishRfqVersionCommandSchema'], output: ['procurement', 'SharedRfqVersionSchema'], contexts: ['rfq'], effects: ['state_change', 'publication', 'outbound_message'], route: '/app/sourcing', design: ['procurement.sourcing.publish'] }),
  entry({ id: 'sourcing_desk.remind_suppliers', kind: 'commit', action: 'communicate', approval: { mode: 'pre_authorized' }, input: [S, 'RemindSuppliersCommandSchema'], output: [S, 'ReminderBatchResultSchema'], contexts: ['rfq'], reads: ['party_private', 'shared_party'], effects: ['outbound_message'], route: '/app/sourcing', design: ['procurement.sourcing.remind'] }),
  entry({ id: 'sourcing_desk.answer_clarification', kind: 'commit', action: 'communicate', approval: askEach, input: [S, 'AnswerClarificationCommandSchema'], output: ['procurement', 'SharedRfqVersionSchema'], contexts: ['rfq'], reads: ['party_private', 'shared_party'], effects: ['outbound_message'], route: '/app/sourcing', design: ['procurement.sourcing.clarify'] }),
  entry({ id: 'sourcing_desk.level_bids', kind: 'draft', action: 'prepare', input: [S, 'DraftBidLevelSheetCommandSchema'], output: [S, 'BidLevelSheetVersionSchema'], contexts: ['rfq'], reads: ['party_private', 'shared_party'], privateData: ['negotiation_constraints'], effects: ['draft_state'], route: '/app/sourcing/levelling', design: ['procurement.sourcing.level'] }),
  entry({ id: 'sourcing_desk.propose_award', kind: 'commit', action: 'prepare', approval: askEach, input: [S, 'ProposeAwardCommandSchema'], output: [S, 'AwardDecisionSchema'], contexts: ['rfq'], privateData: ['negotiation_constraints'], effects: ['state_change'], route: '/app/sourcing/award', design: ['procurement.sourcing.propose_award'] }),
  entry({ id: 'sourcing_desk.execute_award', kind: 'commit', action: 'place_order', input: [S, 'ExecuteAwardCommandSchema'], output: ['transactions', 'OrderSchema'], contexts: ['rfq', 'agreement'], reads: ['party_private', 'shared_party'], privateData: ['budgets'], effects: ['state_change', 'money_commitment'], route: '/app/sourcing/award', design: ['procurement.sourcing.execute_award'] }),
  entry({ id: 'sourcing_desk.notify_outcomes', kind: 'commit', action: 'communicate', approval: { mode: 'pre_authorized' }, input: [S, 'NotifyOutcomesCommandSchema'], output: [S, 'BidOutcomeNoticeSchema'], contexts: ['rfq'], effects: ['outbound_message'], route: '/app/sourcing', design: ['procurement.sourcing.notify_outcome'] }),

  entry({ id: 'document_intake.submit_document', kind: 'draft', action: 'prepare', input: [S, 'SubmitIntakeDocumentCommandSchema'], output: [S, 'IntakeDocumentSchema'], contexts: ['company', 'project'], effects: ['draft_state', 'external_call'], untrusted: true, meters: ['document_pages', 'model_tokens'], route: '/app/intake', design: ['procurement.intake.submit'] }),
  entry({ id: 'document_intake.accept_review', kind: 'commit', action: 'maintain_records', confirmation: 'person_each', input: [S, 'AcceptExtractionReviewCommandSchema'], output: [S, 'ExtractionReviewSchema'], contexts: ['company', 'project'], effects: ['state_change'], route: '/app/intake/review', design: ['procurement.intake.review'] }),
  entry({ id: 'document_intake.accept_delivery_note_review', kind: 'commit', action: 'maintain_records', input: [S, 'AcceptExtractionReviewCommandSchema'], output: [S, 'ExtractionReviewSchema'], contexts: ['company', 'project'], effects: ['state_change'], route: '/app/intake/review', design: ['procurement.intake.review'] }),

  entry({ id: 'procurement.propose_substitution', kind: 'commit', action: 'communicate', approval: askEach, input: [S, 'ProposeSubstitutionCommandSchema'], output: [S, 'SubstitutionRequestSchema'], contexts: ['rfq', 'order', 'project'], reads: ['party_private', 'shared_party'], effects: ['state_change', 'outbound_message'], route: '/app/sourcing/substitutions', design: ['procurement.substitution.propose'] }),

  entry({ id: 'procurement.draft_budget', kind: 'draft', action: 'prepare', input: [S, 'DraftBudgetCommandSchema'], output: [S, 'BudgetLineSchema'], contexts: ['project'], reads: ['owner_private'], privateData: ['budgets'], effects: ['draft_state'], route: '/app/budgets', design: ['procurement.budget.draft'] }),
  entry({ id: 'procurement.request_budget_change', kind: 'commit', action: 'prepare', approval: askEach, input: [S, 'RequestBudgetChangeCommandSchema'], output: [S, 'BudgetChangeSchema'], contexts: ['project'], reads: ['owner_private'], privateData: ['budgets'], effects: ['state_change'], route: '/app/budgets', design: ['procurement.budget.request_change'] }),

  entry({ id: 'procurement.place_order', kind: 'commit', action: 'place_order', input: ['transactions', 'PlaceOrderCommandSchema'], output: ['transactions', 'OrderSchema'], contexts: ['agreement'], reads: ['party_private', 'shared_party'], privateData: ['budgets'], effects: ['state_change', 'money_commitment'], route: '/app/orders/new', design: ['procurement.order.place'] }),
  entry({ id: 'procurement.place_call_off', kind: 'commit', action: 'place_order', input: [S, 'PlaceCallOffCommandSchema'], output: [S, 'CallOffSchema'], contexts: ['agreement'], reads: ['party_private', 'shared_party'], privateData: ['budgets'], effects: ['state_change', 'money_commitment'], route: '/app/orders/new', design: ['procurement.order.place'] }),
  entry({ id: 'procurement.record_external_order', kind: 'commit', action: 'place_order', input: [S, 'RecordExternalOrderCommandSchema'], output: [S, 'ExternalOrderSchema'], contexts: ['company', 'project'], privateData: ['budgets'], effects: ['state_change', 'money_commitment'], route: '/app/orders/new', design: ['procurement.order.place'] }),
  entry({ id: 'procurement.change_order', kind: 'commit', action: 'negotiate', input: [S, 'ChangeOrderCommandSchema'], output: ['transactions', 'OrderSchema'], contexts: ['order'], reads: ['party_private', 'shared_party'], effects: ['state_change', 'outbound_message'], route: '/app/orders', design: ['procurement.order.change'] }),
  entry({ id: 'procurement.close_order_line', kind: 'commit', action: 'maintain_records', approval: askEach, input: [S, 'CloseOrderLineCommandSchema'], output: ['transactions', 'OrderSchema'], contexts: ['order'], reads: ['party_private', 'shared_party'], effects: ['state_change'], route: '/app/orders', design: ['procurement.order.change'] }),

  entry({ id: 'receiving_clerk.propose_delivery_slot', kind: 'commit', action: 'schedule', approval: { mode: 'pre_authorized' }, input: [S, 'ProposeDeliverySlotCommandSchema'], output: [S, 'DeliverySlotSchema'], contexts: ['order'], reads: ['party_private', 'shared_party'], effects: ['state_change', 'outbound_message'], route: '/app/receiving/calendar', design: ['procurement.delivery.schedule'] }),
  entry({ id: 'receiving_clerk.confirm_delivery_slot', kind: 'commit', action: 'schedule', approval: askEach, input: [S, 'ConfirmDeliverySlotCommandSchema'], output: [S, 'DeliverySlotSchema'], contexts: ['order'], reads: ['party_private', 'shared_party'], effects: ['state_change', 'outbound_message'], route: '/app/receiving/calendar', design: ['procurement.delivery.schedule'] }),
  entry({ id: 'receiving_clerk.record_receipt', kind: 'commit', action: 'record_evidence', input: [S, 'RecordGoodsReceiptCommandSchema'], output: [S, 'GoodsReceiptSchema'], contexts: ['order', 'project'], reads: ['party_private', 'shared_party'], effects: ['state_change'], route: '/app/receiving', design: ['procurement.receipt.record'] }),
  entry({ id: 'receiving_clerk.accept_delivered_goods', kind: 'commit', action: 'confirm_execution', confirmation: 'person_each', input: [S, 'AcceptDeliveredGoodsCommandSchema'], output: ['execution', 'AcceptanceRecordSchema'], contexts: ['order', 'agreement'], reads: ['shared_party'], effects: ['state_change', 'reputation_signal'], route: '/app/receiving/acceptance', design: ['procurement.receipt.accept'] }),
  entry({ id: 'receiving_clerk.request_return', kind: 'commit', action: 'communicate', approval: askEach, input: [S, 'RequestReturnCommandSchema'], output: [S, 'SupplierReturnSchema'], contexts: ['order'], reads: ['party_private', 'shared_party'], effects: ['state_change', 'outbound_message'], route: '/app/receiving/returns', design: ['procurement.return.request'] }),
  entry({ id: 'receiving_clerk.move_stock', kind: 'commit', action: 'maintain_records', stricter: [{ case: 'write_off', approval: askEach }], input: [S, 'MoveStockCommandSchema'], output: [S, 'StockMovementSchema'], contexts: ['project', 'company'], effects: ['state_change'], route: '/app/stock', design: ['procurement.stock.move'] }),

  entry({ id: 'payables_desk.capture_invoice', kind: 'commit', action: 'maintain_records', input: [S, 'CaptureTradeInvoiceCommandSchema'], output: [S, 'TradeInvoiceSchema'], contexts: ['order', 'agreement', 'company'], effects: ['state_change'], route: '/app/invoices', design: ['procurement.invoice.process'] }),
  entry({ id: 'payables_desk.resolve_match_exception', kind: 'commit', action: 'communicate', approval: askEach, input: [S, 'ResolveMatchExceptionCommandSchema'], output: [S, 'InvoiceMatchSchema'], contexts: ['order', 'agreement'], reads: ['party_private', 'shared_party'], effects: ['outbound_message'], route: '/app/invoices', design: ['procurement.invoice.process'] }),
  entry({ id: 'payables_desk.clear_risk_signal', kind: 'commit', action: 'approve', confirmation: 'person_each', input: [S, 'ClearRiskSignalCommandSchema'], output: [S, 'PaymentRiskSignalSchema'], contexts: ['company', 'order'], effects: ['state_change'], route: '/app/payments/risk', design: ['procurement.risk.clear'] }),
  entry({ id: 'payables_desk.prepare_payment_proposal', kind: 'draft', action: 'prepare', input: [S, 'DraftPaymentProposalCommandSchema'], output: [S, 'PaymentProposalVersionSchema'], contexts: ['company', 'project'], reads: ['owner_private', 'party_private'], privateData: ['budgets'], effects: ['draft_state'], route: '/app/payments', design: ['procurement.payments.prepare'] }),
  entry({ id: 'payables_desk.release_payments', kind: 'commit', action: 'release_payment', approval: askEach, input: [S, 'ReleasePaymentsCommandSchema'], output: [S, 'PaymentInstructionSchema'], contexts: ['company', 'project'], reads: ['owner_private', 'party_private'], privateData: ['budgets'], effects: ['state_change', 'money_commitment', 'external_call'], route: '/app/payments/release', design: ['procurement.payments.release'] }),
  entry({ id: 'payables_desk.record_external_payment', kind: 'commit', action: 'record_evidence', approval: askEach, input: [S, 'RecordExternalPaymentCommandSchema'], output: [S, 'PaymentInstructionSchema'], contexts: ['company', 'project'], effects: ['state_change'], route: '/app/payments', design: ['procurement.payments.record_external'] }),
  entry({ id: 'payables_desk.export_to_accounting', kind: 'commit', action: 'communicate', approval: { mode: 'ask_first', count: 3 }, input: [S, 'RunAccountingExportCommandSchema'], output: [S, 'AccountingExportResultSchema'], contexts: ['company'], effects: ['external_call'], route: '/app/integrations', design: ['procurement.export.run'] }),

  entry({ id: 'supply_watch.draft_procurement_report', kind: 'draft', action: 'prepare', input: [S, 'DraftProcurementReportCommandSchema'], output: [S, 'ProcurementReportDraftSchema'], contexts: ['company', 'project'], reads: ['owner_private', 'party_private'], privateData: ['budgets'], effects: ['draft_state'], route: '/app/procurement/analytics', design: ['procurement.analytics.report'] }),

  entry({ id: 'order_desk.issue_trade_invoice', kind: 'commit', action: 'record_evidence', input: [S, 'IssueTradeInvoiceCommandSchema'], output: [S, 'TradeInvoiceVersionSchema'], contexts: ['order'], reads: ['party_private', 'shared_party'], effects: ['state_change', 'outbound_message'], route: '/app/sales/invoices', design: ['sales.invoice.issue'] }),
  entry({ id: 'order_desk.send_dispatch_notice', kind: 'commit', action: 'communicate', approval: askFirst5, input: [S, 'SendDispatchNoticeCommandSchema'], output: [S, 'DispatchNoticeSchema'], contexts: ['order'], reads: ['party_private', 'shared_party'], effects: ['state_change', 'outbound_message'], route: '/app/sales/orders', design: ['sales.dispatch.notify'] }),

  entry({ id: 'core.change_payee', kind: 'govern', action: null, confirmation: 'first_party_step_up', input: [S, 'ChangePayeeCommandSchema'], output: [S, 'PayeeChangeRequestSchema'], contexts: ['company'], reads: ['owner_private'], effects: ['state_change'], route: '/app/company/billing', design: ['company.payee.change'] }),
];

/** Plain `AgentCapability` list for `buildCapabilityRegistry` (PRC-023 registers them through module manifests). */
export function supplyAgentCapabilities(): AgentCapability[] {
  return SUPPLY_CAPABILITIES.map((e) => e.capability);
}

/** Every design operation of the parity table, in order; tests check each one maps to at least one entry. */
export const DESIGN_PARITY_OPERATIONS = [
  'procurement.*.read', 'procurement.requisition.draft', 'procurement.requisition.submit', 'procurement.approval.decide', 'procurement.approval.delegate',
  'procurement.routes.edit', 'procurement.routes.activate', 'procurement.requisition.allocate', 'procurement.suppliers.maintain', 'procurement.suppliers.assess',
  'procurement.sourcing.draft_rfq', 'procurement.sourcing.publish', 'procurement.sourcing.remind', 'procurement.sourcing.clarify', 'procurement.sourcing.level',
  'procurement.sourcing.propose_award', 'procurement.sourcing.execute_award', 'procurement.sourcing.notify_outcome', 'procurement.intake.submit', 'procurement.intake.review',
  'procurement.substitution.propose', 'procurement.budget.draft', 'procurement.budget.request_change', 'procurement.order.place', 'procurement.order.change',
  'procurement.delivery.schedule', 'procurement.receipt.record', 'procurement.receipt.accept', 'procurement.return.request', 'procurement.stock.move',
  'procurement.invoice.process', 'procurement.risk.clear', 'procurement.payments.prepare', 'procurement.payments.release', 'procurement.payments.record_external',
  'procurement.export.run', 'procurement.analytics.report', 'sales.quote.send', 'sales.invoice.issue', 'sales.dispatch.notify', 'company.payee.change',
  // Supplier view of its own invoice status (design: "Invoices and the three-way match", supplier view).
  'sales.invoice.status',
] as const;
/** Design rows served by a capability declared elsewhere (`REUSED_CAPABILITY_IDS`). */
export const DESIGN_OPERATIONS_SERVED_ELSEWHERE: Readonly<Record<string, string>> = { 'sales.quote.send': 'quoting.send_quote' };
