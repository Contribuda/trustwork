import {
  calendarDate, PublicSourcedFactSchema, type OwnRegisterReminderRow, type PublicRegisterFactRow, type PublicSourcedFact, type RegisterAdapterRow, type RegisterFactLinkRow,
  type RegisterFactRow,
} from './deps.js';

/**
 * Response projections of the registers routes: camelCase, timestamps as ISO strings, register dates as calendar dates.
 * The public projection is parsed by PublicSourcedFactSchema, so nothing beyond it can leave.
 */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
export const toAdapter = (r: RegisterAdapterRow) => ({
  id: r.id, hubId: r.hub_id, adapter: r.adapter, sourceId: r.source_id, mode: r.mode, credentialRefId: r.credential_ref_id, approvalId: r.approval_id, refreshDays: r.refresh_days,
  status: r.status, lastRunAt: iso(r.last_run_at), revision: r.revision, createdBy: r.created_by, createdAt: iso(r.created_at),
});
export const toFact = (r: RegisterFactRow) => ({
  id: r.id, hubId: r.hub_id, adapterId: r.adapter_id, sourceId: r.source_id, mode: r.mode, method: r.method, kind: r.kind,
  subject: { identifierKind: r.identifier_kind, identifierValue: r.identifier_value, holderKind: r.holder_kind }, value: r.value, recordRef: r.record_ref, link: r.link,
  licenceSnapshot: r.licence_snapshot, observedAt: iso(r.observed_at), validUntil: calendarDate(r.valid_until), recordedBy: r.recorded_by, createdAt: iso(r.created_at),
});
export const toLink = (r: RegisterFactLinkRow) => ({
  id: r.id, hubId: r.hub_id, adapterId: r.adapter_id, recordRef: r.record_ref, companyId: r.company_id, reason: r.reason, linkedBy: r.linked_by, linkedAt: iso(r.linked_at),
  endedAt: iso(r.ended_at), endedBy: r.ended_by,
});
export const toReminder = (r: OwnRegisterReminderRow) => ({
  id: r.id, kind: r.kind, recordRef: r.record_ref, validUntil: calendarDate(r.valid_until), daysBefore: r.days_before, link: r.link, createdAt: iso(r.created_at),
});
export const toPublicFact = (r: PublicRegisterFactRow): PublicSourcedFact => PublicSourcedFactSchema.parse({
  kind: r.kind, identifierKind: r.identifier_kind, value: r.value, sourceId: r.source_id, link: r.link, observedAt: r.observed_at.toISOString(), validUntil: calendarDate(r.valid_until),
  stale: r.stale,
});
