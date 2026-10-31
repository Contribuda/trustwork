/**
 * Relative re-exports of the attestation slice (SANC-009). Like the jurisdiction slice, the module imports its contract
 * and repository files directly so the shared package entries stay untouched (integrator bookkeeping).
 */
export {
  AttestDeploymentLocationCommandSchema, DeploymentAttestationStatusSchema, DeploymentLocationAttestationSchema, DeploymentLocationAttestationSummarySchema,
  deploymentAttestationStatus, type AttestDeploymentLocationCommand, type DeploymentAttestationStatus, type DeploymentConfiguration, type DeploymentLocationAttestation,
  type DeploymentLocationAttestationSummary,
} from '../../../../../../packages/contracts/src/sanctions-attestation.js';
export type { JurisdictionGateMode } from '../../../../../../packages/contracts/src/sanctions.js';
export { deploymentAttestations } from '../../../../../../packages/data/src/repositories/attestation.js';
export type { DeploymentLocationAttestationRow, DeploymentLocationAttestationSummaryRow } from '../../../../../../packages/data/src/schema/attestation.js';
