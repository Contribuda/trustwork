/**
 * Relative re-exports of the agents slice (AGT-001). The module imports its own repository and schema files directly so
 * the shared package entries (`packages/data/src/index.ts`) stay untouched; adding them to that barrel is integrator
 * bookkeeping. The AST-001 mandate store is reused through the assistant module's own re-exports.
 */
export {
  agentReports, agentsWorker, companyMandates, envelopes, escalations, goalProgress, goals, jobSubscriptions, negotiationSessions, representatives,
  type DeliveryResult, type InsertGoalInput,
} from '../../../../../packages/data/src/repositories/agents.js';
export type {
  AgentEnvelopeReceiptRow, AgentEnvelopeRow, AgentEnvelopeSenderRow, AgentEscalationRow, AgentReportRow, CompanyMandateRow, CompanyRepresentativeRow, GoalProgressRow, GoalRow,
  JobSubscriptionRow, NegotiationSessionRow, RepresentativeAccountabilityRow,
} from '../../../../../packages/data/src/schema/agents.js';
export { actionIntents, mandateProposals, mandates, runs, stops, type MandateRow, type MandateProposalRow } from '../assistant/deps.js';
export { actionDigest, decide, mandateDigest, mandateOf, type PolicySettings } from '../assistant/policy.js';
