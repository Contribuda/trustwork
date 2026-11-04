import type { AdmissionRefusalRow, FederationPeerRow, NodeIdentityRow, NodeKeyRow, NodeManifestRow, PeeringEventRow, PeeringRecordRow } from './deps.js';
import { PeeringRecordSchema, type NodeKey, type PeeringRecord } from './deps.js';

/**
 * Console views of the federation node (FED-001). Public key material only; no address, no screening detail. A complete
 * peering record also validates as the protocol's `PeeringRecordSchema`.
 */
const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toNodeKey(row: NodeKeyRow): NodeKey {
  return {
    keyId: row.key_id, algorithm: 'ed25519', publicKey: row.public_key, validFrom: iso(row.valid_from), retiredAt: isoOrNull(row.retired_at),
    revocation: row.compromised_since && row.revoked_at ? { compromisedSince: iso(row.compromised_since), revokedAt: iso(row.revoked_at) } : null,
    rotation: row.rotation_previous_key_id && row.rotation_signature ? { previousKeyId: row.rotation_previous_key_id, signature: { algorithm: 'ed25519', keyId: row.rotation_previous_key_id, value: row.rotation_signature } } : null,
  };
}

export function toIdentity(row: NodeIdentityRow) {
  return {
    nodeId: row.node_id, host: row.host, engine: { version: row.engine_version, source: row.engine_source },
    operator: { name: row.operator_name, registration: row.operator_registration_kind && row.operator_registration_value ? { kind: row.operator_registration_kind, value: row.operator_registration_value } : null, abuseContact: row.abuse_contact, takedownContact: row.takedown_contact },
    jurisdiction: row.jurisdiction, licences: row.licences, tombstoneHours: row.tombstone_hours, offeredLevels: row.offered_levels, agentEnvelopesPerHour: row.agent_envelopes_per_hour,
    revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export function toManifestVersion(row: NodeManifestRow) {
  return { id: row.id, version: row.version, digest: row.digest, keyId: row.key_id, issuedAt: iso(row.issued_at), createdAt: iso(row.created_at) };
}

export function toPeer(row: FederationPeerRow) {
  const manifest = row.manifest as { hubs?: { id: string; territories: string[]; languages: string[] }[]; peeringPolicy?: { offered: string[] }; operator?: { name: string; country: string }; jurisdiction?: string };
  return {
    peerNode: row.peer_node, manifestDigest: row.manifest_digest, manifestIssuedAt: iso(row.manifest_issued_at), manifestFetchedAt: iso(row.manifest_fetched_at), refreshDueAt: iso(row.refresh_due_at),
    currentKeyId: row.current_key_id, attestationExpiresAt: iso(row.attestation_expires_at),
    admission: { state: row.admission_state, decidedAt: iso(row.admission_decided_at), judged: row.admission_judged, trigger: row.admission_trigger },
    equivocationAt: isoOrNull(row.equivocation_at),
    hubs: manifest.hubs ?? [], offered: manifest.peeringPolicy?.offered ?? [], operator: manifest.operator ? { name: manifest.operator.name, country: manifest.operator.country } : null, jurisdiction: manifest.jurisdiction ?? null,
    revision: row.revision,
  };
}

export interface PeeringRecordView {
  id: string;
  localHubId: string;
  peerNode: string;
  peerHubId: string;
  direction: string;
  level: string;
  state: string;
  phase: string;
  licences: Record<string, string>;
  tombstoneHours: number;
  agentEnvelopesPerHour: number;
  peerManifestDigest: string;
  peerKeyId: string;
  admission: { outcome: 'admitted'; decidedAt: string; judged: string[] };
  requestedBy: string | null;
  localAcceptedAt: string | null;
  peerAcceptedAt: string | null;
  secondApproverId: string | null;
  approvalId: string | null;
  suspended: { at: string; reason: string } | null;
  startedAt: string;
  activatedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  revision: number;
}
export function toPeeringRecord(row: PeeringRecordRow): PeeringRecordView {
  return {
    id: row.id, localHubId: row.local_hub_id, peerNode: row.peer_node, peerHubId: row.peer_hub_id, direction: row.direction, level: row.level, state: row.state, phase: row.phase,
    licences: row.licences, tombstoneHours: row.tombstone_hours, agentEnvelopesPerHour: row.agent_envelopes_per_hour, peerManifestDigest: row.peer_manifest_digest, peerKeyId: row.peer_key_id,
    admission: { outcome: 'admitted', decidedAt: iso(row.admission_decided_at), judged: row.admission_judged },
    requestedBy: row.requested_by, localAcceptedAt: isoOrNull(row.local_accepted_at), peerAcceptedAt: isoOrNull(row.peer_accepted_at), secondApproverId: row.second_approver_id, approvalId: row.approval_id,
    suspended: row.suspended_at && row.suspension_reason ? { at: iso(row.suspended_at), reason: row.suspension_reason } : null,
    startedAt: iso(row.started_at), activatedAt: isoOrNull(row.activated_at), endedAt: isoOrNull(row.ended_at), endReason: row.end_reason, revision: row.revision,
  };
}
/** The protocol's record (PeeringRecordSchema) for a record that has a local person; null while an incoming request waits for one. */
export function toProtocolRecord(row: PeeringRecordRow, localNode: string): PeeringRecord | null {
  if (!row.requested_by) return null;
  return PeeringRecordSchema.parse({
    id: row.id, localNode, localHubId: row.local_hub_id, peerNode: row.peer_node, peerHubId: row.peer_hub_id, level: row.level, state: row.state, licences: row.licences,
    tombstoneHours: row.tombstone_hours, agentEnvelopesPerHour: row.agent_envelopes_per_hour, peerManifestDigest: { algorithm: 'trustwork-digest-1', value: row.peer_manifest_digest }, peerKeyId: row.peer_key_id,
    admission: { outcome: 'admitted', decidedAt: iso(row.admission_decided_at), judged: ['declared', 'attested', 'observed'] },
    requestedBy: row.requested_by, secondApproverId: row.second_approver_id, startedAt: iso(row.started_at), endedAt: isoOrNull(row.ended_at), revision: row.revision,
  });
}
export function toEvent(row: PeeringEventRow) {
  return { id: row.id, occurredAt: iso(row.occurred_at), event: row.event, actorPersonId: row.actor_person_id, fromState: row.from_state, toState: row.to_state, reason: row.reason, details: row.details };
}
export function toRefusal(row: AdmissionRefusalRow) {
  return { id: row.id, service: row.service, subject: row.subject, decidedAt: iso(row.decided_at), findings: row.findings, geolocation: row.geolocation };
}
