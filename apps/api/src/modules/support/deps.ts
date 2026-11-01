/**
 * Relative re-exports of the data slices the support workspace uses (SUP-001): its own repository and schema, and the
 * DATA-002 support cases. The module imports these files directly so the shared package entries
 * (`packages/data/src/index.ts`) stay untouched; adding them to that barrel is integrator bookkeeping. It never imports
 * the platform-admin module.
 */
export {
  ACCOUNT_SERVICE_ACTION_COLUMNS, diagnosticSnapshots, serviceActions, supportAccess, type AccountCardJson, type AddressPurpose, type ExplainInputsJson, type LookupKind, type LookupRow,
} from '../../../../../packages/data/src/repositories/support.js';
export type { AccountServiceActionColumn, AccountServiceActionRow, SupportDiagnosticSnapshotRow } from '../../../../../packages/data/src/schema/support.js';
export { supportCases, type CommandContext } from '../../../../../packages/data/src/repositories/admin.js';
export type { SupportCaseNoteRow, SupportCaseRow } from '../../../../../packages/data/src/schema/admin.js';
