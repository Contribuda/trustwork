/**
 * Relative re-exports of the HUB-001 slice. Like the attestation and administration slices, the module imports its
 * repository, schema and contract files directly so the shared package entries stay untouched (integrator bookkeeping).
 */
export {
  hubConfig, hubs, launchGates, legalDocuments, providerCredentials, type CreateHubInput, type ProfileInput, type TerritoryInput,
} from '../../../../../packages/data/src/repositories/hubs.js';
export type {
  CounselApprovalRow, HubConfigVersionRow, HubProfileRow, LaunchGateRow, LegalAcceptanceRow, LegalDocumentVersionRow, ProviderCredentialRefRow, RetentionPolicyRow,
} from '../../../../../packages/data/src/schema/hubs.js';
export type { Hub as HubRow, HubTerritory as HubTerritoryRow } from '../../../../../packages/data/src/schema/kernel.js';
export { adminAudit, approvals, type CommandContext } from '../../../../../packages/data/src/repositories/admin.js';
export type { SecondPersonApprovalRow, StaffRole } from '../../../../../packages/data/src/schema/admin.js';
// HUB-001 contracts (additive to the frozen console contract hub.ts), imported directly like the repository.
export * from '../../../../../packages/contracts/src/hub-core.js';
