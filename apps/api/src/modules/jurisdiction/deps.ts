/**
 * Relative re-exports of the jurisdiction slice (SANC-001). The module imports its contract and repository files
 * directly so the shared package entry `packages/data/src/index.ts` stays untouched (integrator bookkeeping).
 */
export * from '../../../../../packages/contracts/src/sanctions.js';
export { jurisdictionGate as jurisdictionGateStore, jurisdictionHolds } from '../../../../../packages/data/src/repositories/jurisdiction.js';
export type { JurisdictionHoldRow } from '../../../../../packages/data/src/schema/jurisdiction.js';
