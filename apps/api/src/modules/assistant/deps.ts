/**
 * Relative re-exports of the assistant slice (AST-001). The module imports its own repository and schema files
 * directly so the shared package entries (`packages/data/src/index.ts`) stay untouched; adding them to that barrel is
 * integrator bookkeeping.
 */
export {
  actionIntents, assistantNotes, assistantWorker, conversationTurns, mandateProposals, mandates, runs, runSteps, serviceBacklog, stops,
  type ConfirmMandateInput, type MandateFacts, type RecordIntentInput,
} from '../../../../../packages/data/src/repositories/assistant.js';
export type {
  ActionAttemptRow, ActionIntentRow, ActionOutcomeRow, ApprovalRow, AssistantNoteRow, ConversationTurnRow, MandateContextRow, MandateProposalRow, MandateRevisionRow, MandateRow,
  ParticipantStopRow, ReconciliationRow, RunRow, RunStepRow, ServiceBacklogItemRow,
} from '../../../../../packages/data/src/schema/assistant.js';
export { findRepositoryRoot } from '../plans/facets.js';
