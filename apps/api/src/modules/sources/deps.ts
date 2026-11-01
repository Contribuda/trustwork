/**
 * Relative re-exports of the SRC-001 slice. Like the hubs and content slices, the module imports its repository,
 * schema and contract files directly so the shared package entries stay untouched (exporting them from the barrels is
 * integrator bookkeeping).
 */
export {
  importBatches, publicSources, recordLinks, sourceItems, sources, sponsoredPolicy, takedowns,
  type RegisterSourceInput, type RobotsInput, type SourceTermsInput,
} from '../../../../../packages/data/src/repositories/sources.js';
export type {
  CrawlPolicyRow, ImportBatchRow, RecordLinkProposalRow, SourceItemRow, SourceRow, SourceTakedownRow, SourceTombstoneRow, SponsoredContentPolicyRow,
} from '../../../../../packages/data/src/schema/sources.js';
export { approvals, adminAudit, type CommandContext } from '../../../../../packages/data/src/repositories/admin.js';
export type { StaffRole } from '../../../../../packages/data/src/schema/admin.js';
export { publications, type DraftInput } from '../../../../../packages/data/src/repositories/content.js';
// SRC-001 contracts (additive to the frozen console contract hub.ts), imported directly like the repository.
export * from '../../../../../packages/contracts/src/sources.js';
export { SourceStatusSchema, type AllowedUses } from '../../../../../packages/contracts/src/hub.js';
