import { DIGEST_ALGORITHM, type Party } from '../../deps/contracts.js';
import {
  isoDate, PermitRecordSchema, PlanChangeSchema, PlanItemStateSchema, PlanSchema, PlanShareSchema, PlanVersionSchema, PlanVersionSummarySchema, ProjectDiaryEntrySchema, ProjectLocationSchema, toInvitedPlanView,
  type InvitedPlanView, type PermitRecord, type PermitRecordRow, type Plan, type PlanActor, type PlanChange, type PlanChangeRow, type PlanItem, type PlanItemState, type PlanItemStateRow, type PlanRow,
  type PlanShare, type PlanShareRow, type PlanSharedViewRow, type PlanVersion, type PlanVersionRow, type PlanVersionSummary, type ProjectDiaryEntry, type ProjectDiaryEntryRow, type ProjectLocation, type ProjectLocationRow,
} from './deps.js';

/** Row -> contract serializers of the plans slice; every output is re-validated by its strict schema. */
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const digestOf = (value: string | null) => (value === null ? null : { algorithm: DIGEST_ALGORITHM, value });

function actor(via: 'person' | 'agent' | null, personId: string | null, mandateId: string | null): PlanActor {
  return via === 'agent' ? { via: 'agent', personId: personId as string, mandateId: mandateId as string } : { via: 'person', personId: personId as string, mandateId: null };
}
export function party(personId: string | null, companyId: string | null): Party {
  return personId ? { kind: 'person', id: personId } : { kind: 'company', id: companyId as string };
}

export function toPlan(row: PlanRow): Plan {
  return PlanSchema.parse({
    id: row.id, projectId: row.project_id, status: row.status, currentVersionId: row.current_version_id, timeZone: row.time_zone,
    drafted: actor(row.drafted_via, row.created_by_person_id, row.drafted_mandate_id), revision: row.revision, createdAt: iso(row.created_at),
  });
}

export function toVersion(row: PlanVersionRow): PlanVersion {
  return PlanVersionSchema.parse({
    id: row.id, planId: row.plan_id, projectId: row.project_id, version: row.version, status: row.status, content: row.content, digest: digestOf(row.digest),
    basedOnVersionId: row.based_on_version_id, drafted: actor(row.drafted_via, row.drafted_by_person_id, row.drafted_mandate_id),
    proposed: row.proposed_at ? { actor: actor(row.proposed_via, row.proposed_by_person_id, row.proposed_mandate_id), at: iso(row.proposed_at) } : null,
    approved: row.approved_at ? { personId: row.approved_by_person_id, at: iso(row.approved_at) } : null,
    superseded: row.superseded_at ? { at: iso(row.superseded_at), byVersionId: row.superseded_by_version_id, reason: row.superseded_reason } : null,
    changeId: row.change_id, revision: row.revision, createdAt: iso(row.created_at),
  });
}

export function toVersionSummary(row: PlanVersionRow): PlanVersionSummary {
  return PlanVersionSummarySchema.parse({
    id: row.id, version: row.version, status: row.status, digest: digestOf(row.digest), createdAt: iso(row.created_at),
    approvedAt: row.approved_at ? iso(row.approved_at) : null, supersededReason: row.superseded_reason,
  });
}

export function toItemState(row: PlanItemStateRow): PlanItemState {
  return PlanItemStateSchema.parse({
    planId: row.plan_id, itemKey: row.item_key, status: row.status, path: row.path, link: row.link_kind && row.link_id ? { kind: row.link_kind, id: row.link_id } : null,
    blockedFrom: row.blocked_from, actualStart: isoDate(row.actual_start), actualEnd: isoDate(row.actual_end), updatedBy: row.updated_by_person_id, revision: row.revision, updatedAt: iso(row.updated_at),
  });
}

export function toChange(row: PlanChangeRow): PlanChange {
  return PlanChangeSchema.parse({
    id: row.id, planId: row.plan_id, fromVersionId: row.from_version_id, toVersionId: row.to_version_id, reason: row.reason, cause: row.cause,
    requestedBy: party(row.requested_by_person_id, row.requested_by_company_id), accountable: party(row.accountable_person_id, row.accountable_company_id),
    agreementId: row.agreement_id, scheduleImpactDays: row.schedule_impact_days, status: row.status, createdBy: row.created_by_person_id,
    decidedBy: row.decided_by_person_id, decidedAt: row.decided_at ? iso(row.decided_at) : null, revision: row.revision, createdAt: iso(row.created_at),
  });
}

type ShareColumns = Pick<PlanShareRow, 'id' | 'plan_id' | 'item_key' | 'audience' | 'invitee_person_id' | 'invitee_company_id' | 'fields' | 'acceptance_kind' | 'acceptance_id' | 'preview_digest' | 'confirmed_by_person_id' | 'confirmed_at' | 'valid_until' | 'revoked_at' | 'revision'>;
export function toShare(row: ShareColumns): PlanShare {
  return PlanShareSchema.parse({
    id: row.id, planId: row.plan_id, itemKey: row.item_key, audience: row.audience,
    invitee: row.invitee_person_id || row.invitee_company_id ? party(row.invitee_person_id, row.invitee_company_id) : null,
    fields: row.fields, acceptanceRef: row.acceptance_kind && row.acceptance_id ? { kind: row.acceptance_kind, id: row.acceptance_id } : null,
    previewDigest: { algorithm: DIGEST_ALGORITHM, value: row.preview_digest }, confirmedBy: row.confirmed_by_person_id, confirmedAt: iso(row.confirmed_at),
    validUntil: row.valid_until ? iso(row.valid_until) : null, revokedAt: row.revoked_at ? iso(row.revoked_at) : null, revision: row.revision,
  });
}

export function toLocation(row: ProjectLocationRow): ProjectLocation {
  return ProjectLocationSchema.parse({
    projectId: row.project_id, address: row.address ?? null, regionCode: row.region_code, cadastralRef: row.cadastral_ref, siteContact: row.site_contact ?? null,
    siteAccessNotes: row.site_access_notes, revision: row.revision, updatedAt: iso(row.updated_at),
  });
}

export function toPermit(row: PermitRecordRow): PermitRecord {
  return PermitRecordSchema.parse({
    id: row.id, projectId: row.project_id, planItemKey: row.plan_item_key, jurisdiction: row.jurisdiction, permitType: row.permit_type, authority: row.authority, number: row.number,
    appliedAt: isoDate(row.applied_at), issuedAt: isoDate(row.issued_at), expiresAt: isoDate(row.expires_at), inspectionResults: row.inspection_results, evidence: row.evidence,
    status: row.status, createdBy: row.created_by_person_id, revision: row.revision, createdAt: iso(row.created_at),
  });
}

export function toDiaryEntry(row: ProjectDiaryEntryRow): ProjectDiaryEntry {
  return ProjectDiaryEntrySchema.parse({
    id: row.id, projectId: row.project_id, authorPersonId: row.author_person_id, entryDate: isoDate(row.entry_date), text: row.body, evidence: row.evidence,
    planItemKey: row.plan_item_key, visibility: row.visibility, createdAt: iso(row.created_at),
  });
}

/**
 * The invited view from `trustwork.plan_shared_view` rows. The database already NULLed every column outside each
 * share's fields; the rows of one item (an `invited` and an `after_acceptance` share, say) are merged column by column,
 * then the contract serializer `toInvitedPlanView` picks exactly the union of the listed fields again. The partial
 * item is never parsed as a full `PlanItem` (its unshared fields are absent by construction).
 */
export function invitedViewFromRows(projectId: string, rows: readonly PlanSharedViewRow[], viewer: { personId: string; companyId: string | null }, now: Date): InvitedPlanView | null {
  if (rows.length === 0) return null;
  const first = rows[0] as PlanSharedViewRow;
  const byKey = new Map<string, PlanSharedViewRow[]>();
  for (const row of rows) byKey.set(row.item_key, [...(byKey.get(row.item_key) ?? []), row]);
  const pick = <K extends keyof PlanSharedViewRow>(group: readonly PlanSharedViewRow[], key: K): PlanSharedViewRow[K] | null => group.map((r) => r[key]).find((v) => v !== null && v !== undefined) ?? null;
  const items: PlanItem[] = [];
  let location: ProjectLocation | null = null;
  for (const [key, group] of byKey) {
    const low = pick(group, 'estimate_low');
    const currency = pick(group, 'estimate_currency');
    const durationLow = pick(group, 'duration_low_days');
    const quantityValue = pick(group, 'quantity_value');
    const windowStart = pick(group, 'window_start');
    const windowFinish = pick(group, 'window_finish');
    items.push({
      key, parentKey: null, kind: (group[0] as PlanSharedViewRow).kind, title: (group[0] as PlanSharedViewRow).title, description: pick(group, 'description'),
      stepTerms: pick(group, 'step_terms') ?? [], requiredSkills: pick(group, 'required_skills') ?? [],
      quantity: quantityValue !== null ? { value: quantityValue, unit: pick(group, 'quantity_unit') as string } : null,
      estimate: low !== null && currency !== null ? {
        kind: 'estimate_range', low: { minorUnits: String(low), currency }, high: { minorUnits: String(pick(group, 'estimate_high')), currency },
        basis: pick(group, 'estimate_basis') as NonNullable<PlanItem['estimate']>['basis'], basisRef: pick(group, 'estimate_basis_ref'), asOf: isoDate(pick(group, 'estimate_as_of')) as string,
      } : null,
      duration: durationLow !== null ? { lowDays: durationLow, highDays: pick(group, 'duration_high_days') as number } : null,
      window: windowStart !== null || windowFinish !== null ? { earliestStart: isoDate(windowStart), latestFinish: isoDate(windowFinish) } : null,
      riskLevel: null, decisionQuestion: null, sources: [], attachments: (pick(group, 'attachments') as PlanItem['attachments'] | null) ?? [], privateNotes: null,
    });
    location ??= {
      projectId, address: (pick(group, 'address') as ProjectLocation['address']) ?? null, regionCode: pick(group, 'region_code'), cadastralRef: null,
      siteContact: (pick(group, 'site_contact') as ProjectLocation['siteContact']) ?? null, siteAccessNotes: pick(group, 'site_access_notes'), revision: 1, updatedAt: new Date(0).toISOString(),
    };
    if (location.regionCode === null) location.regionCode = pick(group, 'region_code');
    if (location.address === null) location.address = (pick(group, 'address') as ProjectLocation['address']) ?? null;
    if (location.siteContact === null) location.siteContact = (pick(group, 'site_contact') as ProjectLocation['siteContact']) ?? null;
    if (location.siteAccessNotes === null) location.siteAccessNotes = pick(group, 'site_access_notes');
  }
  const shares = rows.map((r) => toShare({
    id: r.share_id, plan_id: r.plan_id, item_key: r.item_key, audience: r.audience, invitee_person_id: r.invitee_person_id, invitee_company_id: r.invitee_company_id, fields: r.fields,
    acceptance_kind: r.acceptance_kind as PlanShareRow['acceptance_kind'], acceptance_id: r.acceptance_id, preview_digest: r.preview_digest, confirmed_by_person_id: r.confirmed_by,
    confirmed_at: r.confirmed_at, valid_until: r.valid_until, revoked_at: null, revision: r.share_revision,
  }));
  return toInvitedPlanView({ projectId, planId: first.plan_id, planVersion: first.plan_version, timeZone: first.time_zone, items, shares, location, viewer, now });
}
