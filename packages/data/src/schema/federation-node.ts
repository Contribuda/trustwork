import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Federation node module (FED-001, packages/data/migrations/federation-node; docs/engine/federation.md, protocol
 * sections 4 to 8, ADR 011 decisions 2, 6 and 12): the node identity the manifest publishes, the Ed25519 key chain
 * with its sealed seeds (never readable by a runtime role), append-only manifest versions, known peers with their
 * validated manifests and SANC-008 admission outcome, peering records with their double opt-in phases and history,
 * admission refusal records, replay nonces, per-deal admissions and noticed key revocations. The runtime role reads under
 * row-level security and writes only through the `federation_*` SECURITY DEFINER commands (repositories/federation-node.ts).
 */
export type PeeringLevelCode = 'syndicate' | 'trust_verifications' | 'deal_routing' | 'identity';
export type PeeringState = 'pending_approval' | 'active' | 'ended';
export type PeeringPhase = 'awaiting_peer' | 'awaiting_acceptance' | 'awaiting_second_approver' | 'complete';
export type PeeringDirection = 'outgoing' | 'incoming';
export type SuspensionReason = 'operator' | 'admission_refused' | 'attestation_expired' | 'equivocation' | 'peer_suspended';
export type PeeringEndReason = 'defederated' | 'declined' | 'refused_by_peer' | 'peer_ended' | 'superseded';
export type PeerAdmissionState = 'admitted' | 'refused';
export type AdmissionTrigger = 'handshake' | 'request' | 'refresh' | 'key_unknown' | 'manifest_changed' | 'attestation_changed' | 'capability_changed' | 'deal_delivery' | 'manual';

export interface NodeIdentityTable {
  node_id: string;
  host: string;
  engine_version: string;
  engine_source: string;
  operator_name: string;
  operator_registration_kind: string | null;
  operator_registration_value: string | null;
  abuse_contact: string;
  takedown_contact: string;
  jurisdiction: string;
  licences: Record<string, string>;
  tombstone_hours: number;
  offered_levels: PeeringLevelCode[];
  agent_envelopes_per_hour: number;
  created_by: string;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type NodeIdentityRow = Selectable<NodeIdentityTable>;

export interface NodeKeyTable {
  node_id: string;
  key_id: string;
  position: number;
  algorithm: Generated<'ed25519'>;
  public_key: string;
  valid_from: Date;
  retired_at: Date | null;
  compromised_since: Date | null;
  revoked_at: Date | null;
  rotation_previous_key_id: string | null;
  rotation_signature: string | null;
  created_by: string;
  created_at: Generated<Date>;
}
export type NodeKeyRow = Selectable<NodeKeyTable>;

/** Sealed seeds (mirrored for the catalogue test only; no runtime role can SELECT this table). */
export interface NodeKeySecretTable {
  node_id: string;
  key_id: string;
  algorithm: Generated<'aes-256-gcm'>;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  wrapped_key: Buffer;
  kek_id: string;
  created_at: Generated<Date>;
}

export interface NodeManifestTable {
  id: Generated<string>;
  node_id: string;
  version: number;
  document: Record<string, unknown>;
  digest: string;
  key_id: string;
  issued_at: Date;
  created_at: Generated<Date>;
}
export type NodeManifestRow = Selectable<NodeManifestTable>;

export interface FederationPeerTable {
  node_id: string;
  peer_node: string;
  manifest: Record<string, unknown>;
  manifest_digest: string;
  manifest_issued_at: Date;
  manifest_fetched_at: Date;
  refresh_due_at: Date;
  current_key_id: string;
  attestation_expires_at: Date;
  admission_state: PeerAdmissionState;
  admission_decided_at: Date;
  admission_judged: string[];
  admission_trigger: AdmissionTrigger;
  equivocation_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type FederationPeerRow = Selectable<FederationPeerTable>;

export interface PeeringRecordTable {
  id: Generated<string>;
  node_id: string;
  local_hub_id: string;
  peer_node: string;
  peer_hub_id: string;
  direction: PeeringDirection;
  level: PeeringLevelCode;
  state: Generated<PeeringState>;
  phase: PeeringPhase;
  licences: Record<string, string>;
  tombstone_hours: number;
  agent_envelopes_per_hour: number;
  peer_manifest_digest: string;
  peer_key_id: string;
  admission_decided_at: Date;
  admission_judged: string[];
  requested_by: string | null;
  local_accepted_at: Date | null;
  peer_accepted_at: Date | null;
  second_approver_id: string | null;
  approval_id: string | null;
  suspended_at: Date | null;
  suspension_reason: SuspensionReason | null;
  started_at: Generated<Date>;
  activated_at: Date | null;
  ended_at: Date | null;
  ended_by: string | null;
  end_reason: PeeringEndReason | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type PeeringRecordRow = Selectable<PeeringRecordTable>;

export interface PeeringEventTable {
  id: Generated<string>;
  peering_record_id: string;
  occurred_at: Generated<Date>;
  event: string;
  actor_person_id: string | null;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  details: Generated<Record<string, unknown>>;
}
export type PeeringEventRow = Selectable<PeeringEventTable>;

export interface AdmissionRefusalTable {
  id: Generated<string>;
  node_id: string;
  service: string;
  subject: string | null;
  decided_at: Date;
  findings: Record<string, unknown>[];
  geolocation: Record<string, unknown> | null;
  created_at: Generated<Date>;
}
export type AdmissionRefusalRow = Selectable<AdmissionRefusalTable>;

/** Replay nonces (mirrored for the catalogue test only; written and read through functions). */
export interface FederationNonceTable {
  node_id: string;
  peer_node: string;
  key_id: string;
  nonce: string;
  expires_at: Date;
}

export interface PeerDealAdmissionTable {
  id: Generated<string>;
  node_id: string;
  peer_node: string;
  deal_ref: string;
  outcome: 'admitted' | 'refused';
  decided_at: Generated<Date>;
}
export type PeerDealAdmissionRow = Selectable<PeerDealAdmissionTable>;

export interface PeerKeyRevocationTable {
  id: Generated<string>;
  node_id: string;
  peer_node: string;
  key_id: string;
  compromised_since: Date;
  revoked_at: Date;
  noticed_at: Generated<Date>;
  objects_flagged: Generated<number>;
}
export type PeerKeyRevocationRow = Selectable<PeerKeyRevocationTable>;

export interface FederationNodeDatabase {
  node_identity: NodeIdentityTable;
  node_key: NodeKeyTable;
  node_key_secret: NodeKeySecretTable;
  node_manifest: NodeManifestTable;
  federation_peer: FederationPeerTable;
  peering_record: PeeringRecordTable;
  peering_event: PeeringEventTable;
  admission_refusal: AdmissionRefusalTable;
  federation_nonce: FederationNonceTable;
  peer_deal_admission: PeerDealAdmissionTable;
  peer_key_revocation: PeerKeyRevocationTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends FederationNodeDatabase {}
}

const columns = columnsOf<FederationNodeDatabase>();
export const TABLE_COLUMNS: TableColumns<FederationNodeDatabase> = {
  node_identity: columns('node_identity', [
    'node_id', 'host', 'engine_version', 'engine_source', 'operator_name', 'operator_registration_kind', 'operator_registration_value', 'abuse_contact', 'takedown_contact',
    'jurisdiction', 'licences', 'tombstone_hours', 'offered_levels', 'agent_envelopes_per_hour', 'created_by', 'revision', 'created_at', 'updated_at',
  ]),
  node_key: columns('node_key', [
    'node_id', 'key_id', 'position', 'algorithm', 'public_key', 'valid_from', 'retired_at', 'compromised_since', 'revoked_at', 'rotation_previous_key_id', 'rotation_signature',
    'created_by', 'created_at',
  ]),
  node_key_secret: columns('node_key_secret', ['node_id', 'key_id', 'algorithm', 'ciphertext', 'iv', 'auth_tag', 'wrapped_key', 'kek_id', 'created_at']),
  node_manifest: columns('node_manifest', ['id', 'node_id', 'version', 'document', 'digest', 'key_id', 'issued_at', 'created_at']),
  federation_peer: columns('federation_peer', [
    'node_id', 'peer_node', 'manifest', 'manifest_digest', 'manifest_issued_at', 'manifest_fetched_at', 'refresh_due_at', 'current_key_id', 'attestation_expires_at',
    'admission_state', 'admission_decided_at', 'admission_judged', 'admission_trigger', 'equivocation_at', 'revision', 'created_at', 'updated_at',
  ]),
  peering_record: columns('peering_record', [
    'id', 'node_id', 'local_hub_id', 'peer_node', 'peer_hub_id', 'direction', 'level', 'state', 'phase', 'licences', 'tombstone_hours', 'agent_envelopes_per_hour',
    'peer_manifest_digest', 'peer_key_id', 'admission_decided_at', 'admission_judged', 'requested_by', 'local_accepted_at', 'peer_accepted_at', 'second_approver_id', 'approval_id',
    'suspended_at', 'suspension_reason', 'started_at', 'activated_at', 'ended_at', 'ended_by', 'end_reason', 'revision', 'updated_at',
  ]),
  peering_event: columns('peering_event', ['id', 'peering_record_id', 'occurred_at', 'event', 'actor_person_id', 'from_state', 'to_state', 'reason', 'details']),
  admission_refusal: columns('admission_refusal', ['id', 'node_id', 'service', 'subject', 'decided_at', 'findings', 'geolocation', 'created_at']),
  federation_nonce: columns('federation_nonce', ['node_id', 'peer_node', 'key_id', 'nonce', 'expires_at']),
  peer_deal_admission: columns('peer_deal_admission', ['id', 'node_id', 'peer_node', 'deal_ref', 'outcome', 'decided_at']),
  peer_key_revocation: columns('peer_key_revocation', ['id', 'node_id', 'peer_node', 'key_id', 'compromised_since', 'revoked_at', 'noticed_at', 'objects_flagged']),
};
