import {
  CrawlPolicyViewSchema, defaultSponsoredPolicyView, ImportBatchViewSchema, LinkProposalViewSchema, SourceItemViewSchema, SourceViewSchema, SponsoredPolicyViewSchema,
  TakedownViewSchema, type AllowedUses, type CrawlPolicyView, type ImportBatchView, type LinkProposalView, type SourceItemView, type SourceView, type SponsoredPolicyView, type TakedownView,
} from './deps.js';
import type {
  CrawlPolicyRow, ImportBatchRow, RecordLinkProposalRow, SourceItemRow, SourceRow, SourceTakedownRow, SourceTombstoneRow, SponsoredContentPolicyRow,
} from './deps.js';

/**
 * Row-to-view serializers (camelCase, ISO timestamps). Every registry view reaches staff of the hub only (row-level
 * security); the public sees `PublicProvenance` and the sponsored slot. Views are parsed with the contract schemas, so a
 * row the registry rules allow always serializes, and an unexpected column never leaks.
 */
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const req = (d: Date): string => new Date(d).toISOString();

export function toCrawlPolicy(p: CrawlPolicyRow): CrawlPolicyView {
  return CrawlPolicyViewSchema.parse({
    id: p.id, domain: p.domain, robotsUrl: p.robots_url, userAgent: p.user_agent, robotsDigest: p.robots_digest, allowed: p.allowed, status: p.status,
    crawlDelaySeconds: p.crawl_delay_s, allowedPaths: p.allowed_paths, disallowedPaths: p.disallowed_paths, licenceUrls: p.licence_urls, recordedBy: p.recorded_by, fetchedAt: req(p.fetched_at),
  });
}

export function toSource(s: SourceRow, policy: CrawlPolicyRow | undefined): SourceView {
  return SourceViewSchema.parse({
    id: s.id, hubId: s.hub_id, kind: s.kind, name: s.name, url: s.url, purposes: s.purposes,
    licence: { kind: s.licence_kind, name: s.licence_name, url: s.licence_url, agreementRef: s.agreement_ref },
    robots: policy ? { checkedAt: req(policy.fetched_at), robotsUrl: policy.robots_url, userAgent: policy.user_agent, allowed: policy.allowed, crawlDelaySeconds: policy.crawl_delay_s, robotsDigest: policy.robots_digest } : null,
    terms: s.terms_checked_at && s.terms_automated_access
      ? { checkedAt: req(s.terms_checked_at), termsUrl: s.terms_url, termsDigest: s.terms_digest, automatedAccess: s.terms_automated_access, reviewedBy: s.terms_reviewed_by, notes: s.terms_notes }
      : null,
    allowedUses: s.allowed_uses, attributionTemplate: s.attribution_template, takedownContact: s.takedown_contact, ownerPersonId: s.owner_person_id, personalData: s.personal_data,
    legalBasis: s.legal_basis,
    proposedBy: s.proposed_by_kind === 'person' ? { kind: 'person', personId: s.proposed_by_person } : { kind: 'pipeline', pipelineId: s.proposed_by_pipeline, runId: s.proposed_by_run },
    status: s.status, activatedBy: s.activated_by, activatedAt: iso(s.activated_at), pauseReason: s.pause_reason, revision: s.revision, readerKind: s.reader_kind, editedBy: s.edited_by,
    crawlPolicy: policy ? toCrawlPolicy(policy) : null,
    rsl: { status: s.rsl_status, digest: s.rsl_digest, checkedAt: iso(s.rsl_checked_at), ceiling: s.rsl_ceiling, suggested: s.rsl_suggested },
    createdAt: req(s.created_at), updatedAt: req(s.updated_at),
  });
}

const snapshot = (j: SourceItemRow['licence_snapshot']) => ({ licenceKind: j.licenceKind, licenceName: j.licenceName ?? null, allowedUses: j.allowedUses });

export function toBatch(b: ImportBatchRow): ImportBatchView {
  return ImportBatchViewSchema.parse({
    id: b.id, hubId: b.hub_id, sourceId: b.source_id, status: b.status, stagedBy: b.staged_by, counts: b.counts, licenceSnapshot: snapshot(b.licence_snapshot),
    decidedBy: b.decided_by, decidedAt: iso(b.decided_at), revision: b.revision, createdAt: req(b.created_at),
  });
}

export function toItem(i: SourceItemRow, effectiveUses: AllowedUses): SourceItemView {
  return SourceItemViewSchema.parse({
    id: i.id, hubId: i.hub_id, sourceId: i.source_id, batchId: i.import_batch_id, externalId: i.external_id, url: i.url, title: i.title, summary: i.summary,
    hasFullText: i.full_text !== null, sourceTime: iso(i.source_time), observedAt: req(i.observed_at), contentDigest: i.content_digest, licenceSnapshot: snapshot(i.licence_snapshot),
    effectiveUses, status: i.status, decidedBy: i.decided_by, decidedAt: iso(i.decided_at), publicationId: i.publication_id,
    sponsored: i.sponsored && i.sponsor_name ? { sponsorName: i.sponsor_name, label: 'sponsored' } : null,
    assistedSummary: i.assisted_summary && i.assisted_language && i.assisted_at
      ? { text: i.assisted_summary, language: i.assisted_language, draftedAt: req(i.assisted_at), label: 'machine_assisted' } : null,
    revision: i.revision,
  });
}

export function toLink(l: RecordLinkProposalRow): LinkProposalView {
  return LinkProposalViewSchema.parse({
    id: l.id, hubId: l.hub_id, left: { kind: l.left_kind, id: l.left_id }, rightLocalId: l.right_local_id, rightGlobalId: l.right_global_id, evidence: l.evidence,
    proposedBy: l.proposed_by, proposedByPerson: l.proposed_by_person, batchId: l.import_batch_id, state: l.state, decidedBy: l.decided_by, decidedAt: iso(l.decided_at),
    effect: 'link', revision: l.revision,
  });
}

export function toTakedown(t: SourceTakedownRow, tombstones: SourceTombstoneRow[]): TakedownView {
  return TakedownViewSchema.parse({
    id: t.id, hubId: t.hub_id, target: t.target_kind === 'source' ? { kind: 'source', id: t.source_id } : { kind: 'source_item', id: t.source_item_id },
    reasonCategory: t.reason_category, executedBy: t.executed_by, executedAt: req(t.executed_at), itemsTakenDown: t.items_taken_down, fieldsDeactivated: t.fields_deactivated,
    publicationIds: t.publication_ids,
    tombstones: tombstones.map((x) => ({ id: x.id, channel: x.channel, targetKind: x.target_kind, targetId: x.target_id, recordKind: x.record_kind, reason: x.reason, issuedAt: req(x.issued_at), applyBy: iso(x.apply_by) })),
  });
}

export function toSponsoredPolicy(hubId: string, p: SponsoredContentPolicyRow | undefined): SponsoredPolicyView {
  if (!p) return defaultSponsoredPolicyView(hubId);
  return SponsoredPolicyViewSchema.parse({
    hubId, version: p.version, allowed: p.allowed, readerLabel: true, separateSlotOnly: true, affectsRankingOrMatching: false, requireVerifiedSponsor: p.require_verified_sponsor,
    maxSlotsPerPage: p.max_slots_per_page, setBy: p.set_by, approvalId: p.approval_id,
  });
}
