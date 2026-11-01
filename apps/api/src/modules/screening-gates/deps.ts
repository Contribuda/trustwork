/**
 * Relative re-exports of the screening-gates slice (SANC-004). The module imports its contract and repository files
 * directly so the shared package entries (`packages/contracts/src/client.ts`, `packages/data/src/index.ts`) stay
 * untouched; adding them to those barrels is integrator bookkeeping.
 */
export * from '../../../../../packages/contracts/src/screening-gates.js';
export { screeningGates } from '../../../../../packages/data/src/repositories/screening-gates.js';
export type { ScreeningSubjectRef } from '../../../../../packages/contracts/src/sanctions.js';
