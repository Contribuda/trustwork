/**
 * Relative re-exports of the execution slice (EXE-001). The module imports its own repository and schema files directly
 * so the shared package entry (`packages/data/src/index.ts`) stays untouched; adding them to that barrel is integrator
 * bookkeeping.
 */
export {
  executionAgreements, executionClaims, executionConfirmations, executionDefects, executionDisputes, executionEvidence, performanceObservations, reputationSnapshots, reviewResponses,
  reviews, trustAppeals, type StaffCommandContext,
} from '../../../../../packages/data/src/repositories/execution.js';
export type {
  ExecutionClaimRow, ExecutionConfirmationRow, ExecutionDefectRow, ExecutionDisputeRow, ExecutionEvidenceRow, PerformanceObservationRow, ReputationSnapshotRow, ReviewResponseRow, ReviewRow,
} from '../../../../../packages/data/src/schema/execution.js';
