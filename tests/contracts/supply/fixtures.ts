/* Synthetic records only (US demo hub, San Diego County, USD). No real people, companies or prices. */
import type * as s from '../../../packages/contracts/src/supply/index.js';

export const at = '2026-10-31T15:00:00Z';
export const later = '2026-11-30T15:00:00Z';
export const digest = { algorithm: 'trustwork-digest-1' as const, value: '0'.repeat(63) + '1' };
export const digest2 = { algorithm: 'trustwork-digest-1' as const, value: '0'.repeat(63) + '2' };
export const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
export const qty = (value: string, unit = 'pc') => ({ value, unit });
export const company = { kind: 'company' as const, id: 'company-demo-mesa-builders' };
export const supplier = { kind: 'company' as const, id: 'company-demo-harbor-lumber' };
export const ana = 'person-demo-ana';
export const ben = 'person-demo-ben';
export const cy = 'person-demo-cy';
export const sdDate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
export const confirm = (personId: string) => ({ via: 'first_party_form' as const, personId, at, stepUp: false });

export const routeVersion: s.ApprovalRouteVersion = {
  id: 'route-demo-req-1', owner: company, subjectKind: 'requisition', version: 1,
  payload: {
    steps: [
      { key: 'pm', order: 1, conditions: [], selector: { kind: 'permission_holders', permission: 'procurement.requisition.source', scope: 'project' }, quorum: 1, timeoutHours: 48, escalation: { kind: 'route_owner' } },
      { key: 'director', order: 2, conditions: [{ kind: 'amount_above', amount: usd('2500000') }], selector: { kind: 'named_person', personId: cy }, quorum: 1, timeoutHours: 72, escalation: { kind: 'next_selector', selector: { kind: 'project_leader' } } },
    ],
    receiverSoleApprovalThreshold: usd('500000'),
  },
  digest, templateKey: 'general_contractor', templateVersion: 1, draftedBy: ana, activatedBy: ben, activatedAt: at, secondPersonRequired: true, status: 'active',
};

export const approvalRequest: s.ApprovalRequest = {
  id: 'approval-request-demo-1', owner: company, subject: { kind: 'requisition', id: 'requisition-demo-1' }, subjectVersionId: 'requisition-version-demo-1', subjectDigest: digest,
  routeVersionId: routeVersion.id, currentStep: 'pm', requestedByPersonId: ana, amount: usd('1250000'), status: 'pending', createdAt: at, revision: 1,
};

export const approvalDecision: s.ApprovalDecision = {
  id: 'approval-decision-demo-1', approvalRequestId: approvalRequest.id, step: 'pm', approverPersonId: ben, onBehalf: company, delegatedFromPersonId: null, delegationId: null,
  decision: 'approve', subjectDigest: digest, reason: null, confirmation: confirm(ben), decidedAt: at,
};

export const requisitionLine: s.RequisitionLine = {
  lineKey: 'l1', description: 'Ready-mix concrete, 4000 psi', stepTerms: ['material.concrete'], materialRef: null, quantity: qty('12', 'yd3'), alternativesAllowed: false,
  estimate: usd('210000'), neededBy: sdDate('2026-11-20'), costCodeId: 'cost-code-demo-03', planItemKey: 'foundation-pour', extractionLocator: null,
};

export const requisitionVersion: s.RequisitionVersion = {
  id: 'requisition-version-demo-1', requisitionId: 'requisition-demo-1', version: 1,
  payload: { lines: [requisitionLine], deliveryLocationId: 'stock-location-demo-site', notes: null }, digest, submittedBy: ana, submittedAt: at,
};

export const payeeAccount: s.PayeeAccount = {
  id: 'payee-demo-1', holder: supplier, externalCounterpartyId: null, providerConnectionId: 'provider-connection-demo-fake', tokenRef: 'token-demo-1',
  maskedDisplay: '•••4821', fingerprint: 'a'.repeat(64), verification: [{ method: 'provider_validation', byPersonId: null, at, outcome: 'passed' }],
  usableFrom: later, status: 'cooling_off', createdAt: at,
};

export const outcomeNotice: s.BidOutcomeNotice = {
  id: 'notice-demo-1', rfqId: 'rfq-demo-1', recipient: supplier, outcome: 'not_awarded', feedbackBand: 'within_15pct', reasonCategory: 'price', buyerOptedInToFeedback: true, sentAt: at,
};

export const tolerance: s.MatchTolerancePolicyPayload = {
  price: { percent: null, absolute: null },
  quantity: { percent: null, absolute: null },
  tax: { percent: null, absolute: null },
  invoiceTotal: { percent: null, absolute: null },
};
