/**
 * Relative re-exports of the supplier base slice (PRC-003). The module imports the supply contracts and its own
 * repository directly so the shared package entries (`packages/contracts/src/index.ts`, `packages/data/src/index.ts`)
 * stay untouched; the `./supply` package export is an open integrator request (PRC-000).
 */
export {
  CounterpartyIdentifierSchema, ExternalCounterpartySchema, OnboardingItemSchema, SupplierAssessmentSchema, SupplierCardSchema, SupplierRecordSchema, SupplierStatusSchema,
  SUPPLIER_BASE_PRIVATE_FIELDS, toSupplierCard,
  type ExternalCounterparty, type SupplierAssessment, type SupplierCard, type SupplierRecord, type SupplierStatus,
} from '../../../../../packages/contracts/src/supply/suppliers.js';
export { DraftSupplierAssessmentCommandSchema, MaintainSupplierCommandSchema, RecordSupplierAssessmentCommandSchema } from '../../../../../packages/contracts/src/supply/commands.js';
export { KeySchema, EvidenceRefsSchema } from '../../../../../packages/contracts/src/supply/common.js';
export { externalCounterparties, supplierAssessments, supplierRecords, type LinkKind, type RecordFields, type SharedAssessmentRow } from '../../../../../packages/data/src/repositories/supplier-base.js';
export type { ExternalCounterpartyRow, SupplierAssessmentRow, SupplierRecordRow } from '../../../../../packages/data/src/schema/supplier-base.js';
export { directory } from '../../../../../packages/data/src/repositories/directory.js';
export { reputationSnapshots } from '../../../../../packages/data/src/repositories/execution.js';
