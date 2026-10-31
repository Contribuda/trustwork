import { ApprovalDecisionSchema, ApprovalRequestSchema, type ApprovalDecision, type ApprovalRequest } from '../../../_data/schemas.js';
import { HUB_US_ID } from '../../../_fixtures/ids.js';

/**
 * Section-local fixtures of HC-02 Approvals (ADM-002). Synthetic second-person requests on the US demo hub covering
 * every state the screen shows: approvable, the viewer's own request, void because the action changed after the
 * request, and expired; plus one approved and one declined decision. The Samarkand example hub has none (empty state).
 * Values are change descriptions (locale keys under `admin.values` or staff text with its language), never payloads.
 */

const digest = (seed: string) => ({ algorithm: 'trustwork-digest-1' as const, value: seed.repeat(64 / seed.length) });
const hub = { kind: 'hub' as const, hubId: HUB_US_ID };
const en = (value: string) => ({ value, lang: 'en' });

export const APPROVAL_REQUESTS: readonly ApprovalRequest[] = [
  {
    id: 'rq-legal-privacy-2',
    action: 'legal.activate_document_version',
    requestedBy: 'p-compliance',
    reason: en('Activate privacy notice version 2 with its Spanish edition; counsel approved both on 2026-10-29'),
    requestedAt: '2026-10-30T16:00:00Z',
    expiresAt: '2026-11-02T16:00:00Z',
    actionDigest: digest('d4'),
    currentDigest: digest('d4'),
    changes: [
      { field: 'documentVersion', before: { kind: 'text', value: 'Privacy notice 1', lang: 'en' }, after: { kind: 'text', value: 'Privacy notice 2', lang: 'en' } },
      { field: 'languages', before: { kind: 'key', key: 'values.languages.en' }, after: { kind: 'key', key: 'values.languages.enEs' } },
    ],
  },
  {
    id: 'rq-provider-email-live',
    action: 'providers.enable_non_fake',
    requestedBy: 'p-ops',
    reason: en('Enable the prepared e-mail connection; the synthetic connection test passed'),
    requestedAt: '2026-10-31T09:10:00Z',
    expiresAt: '2026-11-03T09:10:00Z',
    actionDigest: digest('f6'),
    currentDigest: digest('f6'),
    changes: [{ field: 'providerMode', before: { kind: 'key', key: 'values.mode.fake' }, after: { kind: 'key', key: 'values.mode.live' } }],
  },
  {
    id: 'rq-automation-editorial',
    action: 'automation.raise_to_supervised_autonomous',
    requestedBy: 'p-editor',
    reason: en('Run the news desk pipeline without a person starting each step; human gates stay'),
    requestedAt: '2026-10-29T08:00:00Z',
    expiresAt: '2026-11-01T08:00:00Z',
    actionDigest: digest('a7'),
    // The pipeline version changed after the request, so the digest the approver would bind no longer matches.
    currentDigest: digest('a8'),
    changes: [{ field: 'automationLevel', before: { kind: 'key', key: 'values.automation.assisted' }, after: { kind: 'key', key: 'values.automation.supervised_autonomous' } }],
  },
  {
    id: 'rq-fee-consultation',
    action: 'billing.activate_fee_version',
    requestedBy: 'p-commercial',
    reason: en('Consultation commission version 1 for the demo price page'),
    requestedAt: '2026-10-27T09:00:00Z',
    expiresAt: '2026-10-30T09:00:00Z',
    actionDigest: digest('b9'),
    currentDigest: digest('b9'),
    changes: [{ field: 'feeVersion', before: { kind: 'none' }, after: { kind: 'text', value: 'Consultation fee 1', lang: 'en' } }],
  },
  {
    id: 'rq-role-compliance',
    action: 'staff.assign_sensitive_role',
    requestedBy: 'p-hub-owner',
    reason: en('A second compliance officer for counsel reviews while the first is away'),
    requestedAt: '2026-10-31T10:30:00Z',
    expiresAt: '2026-11-03T10:30:00Z',
    actionDigest: digest('c0'),
    currentDigest: digest('c0'),
    changes: [{ field: 'role', before: { kind: 'none' }, after: { kind: 'key', key: 'roles.compliance-officer' } }],
  },
].map((r) => ApprovalRequestSchema.parse({ ...r, hubId: HUB_US_ID, scope: hub, state: 'pending', synthetic: true }));

export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  ApprovalDecisionSchema.parse({
    synthetic: true,
    requestId: 'rq-residency-us',
    hubId: HUB_US_ID,
    action: 'hub.change_residency',
    requestedBy: 'p-compliance',
    decision: 'approve',
    decidedBy: 'p-hub-owner',
    decidedAt: '2026-10-12T14:00:00Z',
    approval: {
      id: 'ap-us-residency-1',
      action: 'hub.change_residency',
      scope: hub,
      actionDigest: digest('c3'),
      requestedBy: 'p-compliance',
      approvedBy: 'p-hub-owner',
      approvedAt: '2026-10-12T14:00:00Z',
      expiresAt: '2026-10-13T14:00:00Z',
      revokedAt: null,
    },
  }),
  ApprovalDecisionSchema.parse({
    synthetic: true,
    requestId: 'rq-sponsored-us',
    hubId: HUB_US_ID,
    action: 'sponsored.enable',
    requestedBy: 'p-commercial',
    decision: 'decline',
    decidedBy: 'p-hub-owner',
    decidedAt: '2026-10-22T11:00:00Z',
    approval: null,
  }),
];
