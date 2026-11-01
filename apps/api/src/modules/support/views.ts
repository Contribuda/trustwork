import { z } from 'zod';
import { AccountServiceActionSchema, COOLING_OFF_ACTIONS, NameSchema, SupportAccountSummarySchema, type AccountServiceAction } from '../../deps/contracts.js';
import type { AccountCardJson, AccountServiceActionRow, SupportCaseNoteRow, SupportCaseRow, SupportDiagnosticSnapshotRow } from './deps.js';

const iso = (value: Date | string | null | undefined): string | null => (value === null || value === undefined ? null : (value instanceof Date ? value : new Date(value)).toISOString());
const isoOf = (value: Date | string): string => iso(value) as string;
const cooling = (action: string): boolean => (COOLING_OFF_ACTIONS as readonly string[]).includes(action);

/**
 * The account card as served: the contract allowlist `SupportAccountSummarySchema`, with `displayName` and
 * `maskedEmail` nullable because a provider sign-up may have no name (identity hardening item 7) and an account may
 * have no address on file; clients render a localized placeholder. Strict: an extra field fails the response.
 */
export const SupportAccountCardSchema = SupportAccountSummarySchema.extend({
  displayName: NameSchema.nullable(),
  maskedEmail: SupportAccountSummarySchema.shape.maskedEmail.nullable(),
});
export type SupportAccountCard = z.infer<typeof SupportAccountCardSchema>;

export function toAccountCard(json: AccountCardJson): SupportAccountCard {
  const card = json as Record<string, unknown> & { entitlements: Array<{ offerCode: string; validUntil: string | null }>; consents: Array<{ kind: string; version: string; state: string; at: string }> };
  return SupportAccountCardSchema.parse({
    ...card,
    entitlements: card.entitlements.map((e) => ({ offerCode: e.offerCode, validUntil: iso(e.validUntil) })),
    consents: card.consents.map((c) => ({ kind: c.kind, version: c.version, state: c.state, at: isoOf(c.at) })),
  });
}

export const caseView = (r: SupportCaseRow) => ({
  id: r.id, number: Number(r.number), hubId: r.hub_id, requesterPersonId: r.requester_person_id, openedBy: r.opened_by,
  subject: r.external_source_subject_id ? { kind: 'external_source' as const, id: r.external_source_subject_id } : r.subject_person_id ? { kind: 'person' as const, id: r.subject_person_id } : { kind: 'company' as const, id: r.subject_company_id as string },
  category: r.category, summary: r.summary, status: r.status, urgency: r.priority, assignedTo: r.assigned_to, openedAt: isoOf(r.opened_at), resolvedAt: iso(r.resolved_at),
  closedAt: iso(r.closed_at), resolutionCode: r.resolution_code, revision: r.revision,
});
/** The requester's view: no staff identities. */
export const ownCaseView = (r: SupportCaseRow) => ({
  id: r.id, number: Number(r.number), forCompany: r.subject_company_id !== null, category: r.category, summary: r.summary, status: r.status, openedAt: isoOf(r.opened_at),
  resolvedAt: iso(r.resolved_at), closedAt: iso(r.closed_at),
});
export const noteView = (r: SupportCaseNoteRow) => ({ id: r.id, authorPersonId: r.author_person_id, body: r.body, visibility: r.visibility, createdAt: isoOf(r.created_at) });
/** The requester sees whether a note came from support, never which staff member wrote it. */
export const ownNoteView = (r: SupportCaseNoteRow, requester: string) => ({ id: r.id, fromSupport: r.author_person_id !== requester, body: r.body, createdAt: isoOf(r.created_at) });

/** The `AccountServiceAction` contract record, once the action carries what the contract requires (an approval for the sign-in factor changes). */
export function contractRecord(r: AccountServiceActionRow): AccountServiceAction | null {
  if (cooling(r.action) && r.approved_by === null) return null;
  return AccountServiceActionSchema.parse({
    id: r.id, hubId: r.hub_id, supportCaseId: r.support_case_id, subjectPersonId: r.subject_person_id, action: r.action, requestedBy: r.requested_by, approvedBy: r.approved_by,
    evidenceRefs: r.evidence_refs, requestedAt: isoOf(r.requested_at), effectiveAt: isoOf(r.effective_at), subjectNotified: true, state: r.state,
  });
}

export const actionView = (r: AccountServiceActionRow, maskedNewEmail: string | null) => ({
  id: r.id, hubId: r.hub_id, supportCaseId: r.support_case_id, subjectPersonId: r.subject_person_id, action: r.action, state: r.state, requestedBy: r.requested_by,
  requestedAt: isoOf(r.requested_at), reason: r.reason, evidenceRefs: r.evidence_refs, requestDigest: r.request_digest, approvalId: r.approval_id, approvedBy: r.approved_by,
  approvedAt: iso(r.approved_at), effectiveAt: isoOf(r.effective_at), coolingOff: cooling(r.action), subjectNotified: true as const, newEmailMasked: maskedNewEmail,
  guidedTask: r.guided_task, secondFactorResetId: r.second_factor_reset_id, cancelledAt: iso(r.cancelled_at), executedAt: iso(r.executed_at), revision: r.revision,
  record: contractRecord(r),
});
/** The subject's view of an action on their account: what, when it takes effect, whether they can still stop it; no staff identities. */
export const ownActionView = (r: AccountServiceActionRow, maskedNewEmail: string | null) => ({
  id: r.id, action: r.action, state: r.state, requestedAt: isoOf(r.requested_at), effectiveAt: isoOf(r.effective_at), coolingOff: cooling(r.action),
  cancellable: cooling(r.action) && (r.state === 'pending' || r.state === 'cooling_off'), newEmailMasked: maskedNewEmail, guidedTask: r.guided_task,
  cancelledAt: iso(r.cancelled_at), executedAt: iso(r.executed_at),
});

export const snapshotView = (r: SupportDiagnosticSnapshotRow) => ({
  id: r.id, supportCaseId: r.support_case_id, sharedBy: r.shared_by, pageId: r.page_id, appVersion: r.app_version, locale: r.locale, featureFlags: r.feature_flags,
  errorCodes: r.error_codes, requestIds: r.request_ids, objects: r.objects as Array<{ type: string; id: string }>, createdAt: isoOf(r.created_at),
});
