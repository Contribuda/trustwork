/**
 * Relative re-exports of the FED-001 slice. Like the hubs and attestation slices, the module imports its contract,
 * compliance and repository files directly so the shared package entries stay untouched (integrator bookkeeping).
 */
export * from '../../../../../../packages/contracts/src/federation.js';
export { computeDigest } from '../../../../../../packages/contracts/src/common/digest.js';
export { canonicalize } from '../../../../../../packages/contracts/src/common/canonical.js';
export { fromBase64Url, toBase64Url, utf8Encode } from '../../../../../../packages/contracts/src/common/encoding.js';
export { IdSchema, RevisionSchema, TimestampSchema } from '../../../../../../packages/contracts/src/common/ids.js';
export { consoleCommand, HUB_CONSOLE_CONTRACT_VERSION, type ConsoleCommandResult } from '../../../../../../packages/contracts/src/hub.js';
export { parseAddress, restrictedPlaces, unconfiguredGate, type GateRequest, type JurisdictionGate, type RestrictedPlaces } from '../../../../../../packages/contracts/src/sanctions.js';
export { DeploymentLocationAttestationSummarySchema, type DeploymentLocationAttestationSummary } from '../../../../../../packages/contracts/src/sanctions-attestation.js';
export {
  admissionLogEvent, admitPeerAtHandshake, AdmissionRefusalRecordSchema, FEDERATION_PEER_RESTRICTED, type AdmissionDecision, type AdmissionRefusalRecord,
} from '../../../../../../packages/compliance/src/admission/index.js';
export { deploymentAttestations } from '../../../../../../packages/data/src/repositories/attestation.js';
export { adminAudit, approvals, type CommandContext } from '../../../../../../packages/data/src/repositories/admin.js';
export type { StaffRole } from '../../../../../../packages/data/src/schema/admin.js';
export {
  federationPeers, nodeIdentity, nodeKeys, nodeManifests, peeringRecords, type NodeIdentityInput, type PeeringTerms, type PeerRecordInput, type Runner, type SealedSeed, type SigningMaterialRow,
} from '../../../../../../packages/data/src/repositories/federation-node.js';
export type {
  AdmissionRefusalRow, AdmissionTrigger, FederationPeerRow, NodeIdentityRow, NodeKeyRow, NodeManifestRow, PeeringEventRow, PeeringLevelCode, PeeringRecordRow, SuspensionReason,
} from '../../../../../../packages/data/src/schema/federation-node.js';
