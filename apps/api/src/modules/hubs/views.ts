import {
  DIGEST_ALGORITHM, HubSchema, LAUNCH_GATES, SOFT_LAUNCH_GATES, type HubConfigDomain, type LaunchGateId,
} from '../../deps/contracts.js';
import {
  configActivationAction, configActivationDigestInput, COUNSEL_GATE_DOCUMENT_KINDS, credentialActivationDigestInput, legalActivationDigestInput, type LaunchChecklist, type LegalDocumentKind,
} from './deps.js';
import { computeDigest } from '../../deps/contracts.js';
import type {
  CounselApprovalRow, HubConfigVersionRow, HubProfileRow, HubRow, HubTerritoryRow, LaunchGateRow, LegalAcceptanceRow, LegalDocumentVersionRow, ProviderCredentialRefRow,
  RetentionPolicyRow,
} from './deps.js';

/**
 * Row-to-view serializers (camelCase, ISO timestamps, digests as `{ algorithm, value }`). Configuration, gates, counsel
 * records and credential references reach staff of the hub only (row-level security); a credential view names the
 * secret's reference in the store, never a value.
 */
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const req = (d: Date): string => new Date(d).toISOString();
const digest = (value: string) => ({ algorithm: DIGEST_ALGORITHM, value });
const localDate = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function toHub(hub: HubRow, profile: HubProfileRow, territories: HubTerritoryRow[]) {
  return {
    hub: HubSchema.parse({
      id: hub.id, nodeId: profile.node_id, slug: hub.slug, name: profile.name, lifecycle: hub.lifecycle,
      territories: territories.map((t) => (t.level === 'place' ? { level: 'place', code: t.code, wikidata: null, osmRelation: null } : { level: t.level, code: t.code })),
      countryPack: hub.pack_code && hub.pack_version ? { code: hub.pack_code, version: hub.pack_version } : null, defaultLocale: profile.default_locale, locales: profile.locales,
      timeZone: profile.time_zone, currency: profile.currency, brandOverlay: profile.brand_overlay, revision: hub.revision,
    }),
    territoryIds: Object.fromEntries(territories.map((t) => [t.code, t.id])),
    profileRevision: profile.revision,
    createdAt: req(profile.created_at),
  };
}

export function toConfigVersion(v: HubConfigVersionRow) {
  const domain = v.domain as HubConfigDomain;
  const action = configActivationAction(domain);
  return {
    id: v.id, hubId: v.hub_id, domain, version: v.version, payload: v.payload, payloadDigest: digest(v.payload_digest), status: v.status, source: v.source, reason: v.reason,
    draftedBy: v.drafted_by, draftedAt: req(v.drafted_at), activatedBy: v.activated_by, activatedAt: iso(v.activated_at), approvalId: v.approval_id, effectiveFrom: iso(v.effective_from),
    revision: v.revision,
    /** What a second person approves before a sensitive version is activated (null for non-sensitive domains). */
    activation: action
      ? { secondPersonAction: action, actionDigest: computeDigest(configActivationDigestInput({ id: v.id, hubId: v.hub_id, domain, version: v.version, payloadDigest: v.payload_digest })).value }
      : null,
  };
}

export function toGate(g: LaunchGateRow) {
  return {
    hubId: g.hub_id, gate: g.gate as LaunchGateId, state: g.state, evidenceRef: g.evidence_ref, checkedBy: g.checked_by, checkedAt: iso(g.checked_at),
    invalidatedAt: iso(g.invalidated_at), invalidationReason: g.invalidation_reason,
  };
}

export function toChecklist(hub: HubRow, gates: LaunchGateRow[], engine: Map<string, boolean>, blockers: { soft_launch: string[]; public: string[] }): LaunchChecklist {
  const byGate = new Map(gates.map((g) => [g.gate, g]));
  return {
    hubId: hub.id, lifecycle: hub.lifecycle,
    gates: LAUNCH_GATES.map((gate) => {
      const g = byGate.get(gate);
      return {
        gate, state: g?.state ?? 'open', requiredFor: SOFT_LAUNCH_GATES.includes(gate) ? 'soft_launch' as const : 'public' as const, engineConfirms: engine.get(gate) ?? false,
        evidenceRef: g?.evidence_ref ?? null, checkedBy: g?.checked_by ?? null, checkedAt: iso(g?.checked_at), invalidationReason: g?.invalidation_reason ?? null,
      };
    }),
    blockers,
  };
}

export function toLegalDocument(d: LegalDocumentVersionRow, counselApprovalId: string | null) {
  const counsel = d.counsel_approval_id ?? counselApprovalId;
  return {
    id: d.id, hubId: d.hub_id, kind: d.kind as LegalDocumentKind, locale: d.locale, version: d.version, body: d.body, bodyDigest: d.body_digest, status: d.status,
    counselApprovalId: d.counsel_approval_id, draftedBy: d.drafted_by, draftedAt: req(d.drafted_at), activatedBy: d.activated_by, activatedAt: iso(d.activated_at), approvalId: d.approval_id,
    revision: d.revision, requiredForLaunch: COUNSEL_GATE_DOCUMENT_KINDS.includes(d.kind as LegalDocumentKind),
    activation: d.status === 'draft' && counsel
      ? { secondPersonAction: 'legal.activate_document_version' as const, actionDigest: computeDigest(legalActivationDigestInput({ id: d.id, hubId: d.hub_id, kind: d.kind as LegalDocumentKind, locale: d.locale, version: d.version, bodyDigest: d.body_digest, counselApprovalId: counsel })).value }
      : null,
  };
}

/** What a participant sees of an active legal text. */
export const toPublicLegalDocument = (d: LegalDocumentVersionRow) => ({ id: d.id, hubId: d.hub_id, kind: d.kind, locale: d.locale, version: d.version, body: d.body, bodyDigest: d.body_digest, activatedAt: iso(d.activated_at) });

export const toCounselApproval = (c: CounselApprovalRow) => ({
  id: c.id, hubId: c.hub_id, documentVersionIds: c.document_version_ids, counselName: c.counsel_name, firm: c.firm, approvedOn: localDate(new Date(c.approved_on)),
  scopeNote: c.scope_note, recordedBy: c.recorded_by, recordedAt: req(c.recorded_at),
});

export const toAcceptance = (a: LegalAcceptanceRow) => ({ id: a.id, personId: a.person_id, documentVersionId: a.legal_document_version_id, context: a.context, acceptedAt: req(a.accepted_at) });

export function toCredential(c: ProviderCredentialRefRow) {
  return {
    id: c.id, hubId: c.hub_id, provider: c.provider, adapter: c.adapter, mode: c.mode, secret: { store: c.secret_store, ref: c.secret_ref }, status: c.status,
    registeredBy: c.registered_by, registeredAt: req(c.registered_at), activatedBy: c.activated_by, activatedAt: iso(c.activated_at), approvalId: c.approval_id,
    retiredAt: iso(c.retired_at), rotatedFromId: c.rotated_from_id, revision: c.revision,
    activation: c.status === 'registered' && c.mode !== 'fake'
      ? { secondPersonAction: 'providers.enable_non_fake' as const, actionDigest: computeDigest(credentialActivationDigestInput({ id: c.id, hubId: c.hub_id, provider: c.provider, adapter: c.adapter, mode: c.mode, secretStore: c.secret_store, secretRef: c.secret_ref })).value }
      : null,
  };
}

export const toRetention = (r: RetentionPolicyRow) => ({
  class: r.class, minPeriod: r.min_period, maxPeriod: r.max_period, packFactRef: r.pack_fact_ref, disclosureTextKey: r.disclosure_text_key, configVersionId: r.config_version_id,
});

export const toTerritory = (t: HubTerritoryRow) => ({ id: t.id, hubId: t.hub_id, level: t.level, code: t.code, placeKey: t.place_key, createdAt: req(t.created_at) });
