/**
 * Relative re-exports of the REG-001 slice: the module imports its repository, schema and contract files directly so the
 * shared package entries stay untouched (exporting them from the barrels is integrator bookkeeping).
 */
export { calendarDate, registers, type OwnRegisterReminderRow, type PublicRegisterFactRow } from '../../../../../packages/data/src/repositories/registers.js';
export type { RegisterAdapterRow, RegisterFactLinkRow, RegisterFactRow } from '../../../../../packages/data/src/schema/registers.js';
export { adminAudit, type CommandContext } from '../../../../../packages/data/src/repositories/admin.js';
export type { StaffRole } from '../../../../../packages/data/src/schema/admin.js';
export {
  PublicSourcedFactSchema, REGISTER_ADAPTERS, findRegisterAdapter, type PublicSourcedFact,
} from '../../../../../packages/contracts/src/sourced-facts.js';
