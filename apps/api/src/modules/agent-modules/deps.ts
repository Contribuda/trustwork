/**
 * Relative re-exports of the agent-modules slice (AGT-003). The module imports its own repository and schema files
 * directly so the shared package entries stay untouched (integrator bookkeeping). The HUB-001 configuration commands and
 * the AST-001 proposal store are reused through their modules' own re-exports.
 */
export {
  agentAuthority, agentJobs, agentJobWorker, agentKillSwitches, agentPolicies, type DispatchRefusal, type DueJobRow, type JobRequestInput, type PreviewCountsRow,
} from '../../../../../packages/data/src/repositories/agent-modules.js';
export type { AgentJobRequestRow, AgentJobScheduleRow, AgentPolicyCurrentRow, AgentPolicyVersionRow } from '../../../../../packages/data/src/schema/agent-modules.js';
export type { KillSwitchRow } from '../../../../../packages/data/src/schema/admin.js';
export { approvals, configActivationDigestInput, hubConfig, type CommandContext, type HubConfigVersionRow } from '../hubs/deps.js';
export { adminDigests } from '../../../../../packages/data/src/repositories/admin.js';
export { mandateProposals, type MandateProposalRow } from '../assistant/deps.js';
export { mandateDigest } from '../assistant/policy.js';
