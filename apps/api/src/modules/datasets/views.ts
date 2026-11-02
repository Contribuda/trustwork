import type { DatasetLicenceRow, DatasetRecordRow, DatasetRow, DatasetTombstoneRow, EntityDistinctPairRow, EntityLinkBatchRow, EntityLinkProposalRow } from './deps.js';

/**
 * Response projections of the datasets routes: camelCase, timestamps as ISO strings, licence dates as calendar dates,
 * confidence and similarity as decimal strings. Tombstones carry a digest of the key, never the key.
 */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const day = (d: Date | string): string => {
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const toDataset = (r: DatasetRow) => ({
  id: r.id, hubId: r.hub_id, subject: r.subject, name: r.name, sourceIds: r.source_ids, purpose: r.purpose, legalBasis: r.legal_basis,
  personalData: { present: r.personal_present, naturalPersons: r.natural_persons, categories: r.personal_categories }, impactAssessmentRef: r.impact_assessment_ref,
  retention: { className: r.retention_class, days: r.retention_days }, outputs: r.outputs, publicDisplay: r.public_display, subjectNotice: r.subject_notice,
  contactUseAllowed: r.contact_use_allowed, refreshScheduleId: r.refresh_schedule_id, status: r.status, proposedBy: r.proposed_by, activatedBy: r.activated_by,
  activatedAt: iso(r.activated_at), approvalId: r.approval_id, version: r.version, revision: r.revision, createdAt: iso(r.created_at),
});
export const toLicence = (r: DatasetLicenceRow) => ({
  id: r.id, datasetId: r.dataset_id, supplier: r.supplier, agreementDigest: r.agreement_digest, agreementRef: r.agreement_ref, purposes: r.purposes, uses: r.uses,
  validFrom: day(r.valid_from), validUntil: day(r.valid_until), recordedBy: r.recorded_by, createdAt: iso(r.created_at),
});
export const toRecord = (r: DatasetRecordRow) => ({
  id: r.id, datasetId: r.dataset_id, sourceId: r.source_id, externalKey: r.external_key, identifierKind: r.identifier_kind, identifierValue: r.identifier_value,
  naturalPerson: r.natural_person, fields: r.fields, provenance: r.provenance, contactUse: r.contact_use, observedAt: iso(r.observed_at), expiresAt: iso(r.expires_at),
});
export const toTombstone = (r: DatasetTombstoneRow) => ({ id: r.id, datasetId: r.dataset_id, keyDigest: r.key_digest, reason: r.reason, createdAt: iso(r.created_at) });
export const toProposal = (r: EntityLinkProposalRow) => ({
  id: r.id, hubId: r.hub_id, recordId: r.record_id, datasetId: r.dataset_id, target: { kind: r.target_kind, id: r.target_id }, evidence: r.evidence,
  confidence: String(r.confidence), scoringMethod: r.scoring_method, statutoryIdentifier: r.statutory_identifier, proposedBy: r.proposed_by_kind === 'person' ? { kind: 'person', id: r.proposed_by } : { kind: 'resolver' },
  state: r.state, decidedBy: r.decided_by, decidedAt: iso(r.decided_at), batchId: r.batch_id, effect: r.effect, revision: r.revision, createdAt: iso(r.created_at),
});
export const toBatch = (r: EntityLinkBatchRow) => ({
  id: r.id, decision: r.decision, proposalCount: r.proposal_count, sampleIds: r.sample_ids, scoringMethod: r.scoring_method, decidedBy: r.decided_by, createdAt: iso(r.created_at),
});
export const toDistinct = (r: EntityDistinctPairRow) => ({
  recordId: r.record_id, target: { kind: r.target_kind, id: r.target_id }, reason: r.reason, markedBy: r.marked_by, createdAt: iso(r.created_at),
});
