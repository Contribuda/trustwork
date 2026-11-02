/**
 * Relative re-exports of the MINE-001 slice: the module imports its repository and schema files directly so the shared
 * package entries stay untouched (exporting them from the barrels is integrator bookkeeping).
 */
export { datasets, links, type DatasetRecordInput, type LinkTargetKind } from '../../../../../packages/data/src/repositories/datasets.js';
export type {
  DatasetLicenceRow, DatasetRecordRow, DatasetRow, DatasetTombstoneRow, EntityDistinctPairRow, EntityLinkBatchRow, EntityLinkProposalRow,
} from '../../../../../packages/data/src/schema/datasets.js';
export { adminAudit, type CommandContext } from '../../../../../packages/data/src/repositories/admin.js';
export type { StaffRole } from '../../../../../packages/data/src/schema/admin.js';
