/**
 * Relative re-exports of the HUB-004 slice. Like the hubs and attestation slices, the module imports its contract and
 * repository files directly so the shared package entries stay untouched (integrator bookkeeping).
 */
export * from '../../../../../../packages/contracts/src/hub-setup.js';
export { setupRuns } from '../../../../../../packages/data/src/repositories/setup.js';
export type { SetupRunRow } from '../../../../../../packages/data/src/schema/setup.js';
export type { CandidateRow } from '../../../../../../packages/data/src/repositories/screening.js';
export { configPayloadProblems, splitDeploymentConfig } from '../../../../../../packages/contracts/src/hub-core.js';
export { hubConfig, hubs } from '../../../../../../packages/data/src/repositories/hubs.js';
export { deploymentAttestations } from '../../../../../../packages/data/src/repositories/attestation.js';
export type { CommandContext } from '../../../../../../packages/data/src/repositories/admin.js';
export { MATCHER_VERSION, screenedEntryTypes, screenNames } from '../../../../../../packages/compliance/src/matching/index.js';
export { nameTokens } from '../../../../../../packages/compliance/src/names/index.js';
export { DEPLOYMENT_ATTESTATION_STATEMENT_VERSION } from '../../../../../../packages/contracts/src/sanctions-attestation.js';
