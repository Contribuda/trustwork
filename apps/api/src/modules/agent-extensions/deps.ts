/** Relative re-exports of the AGT-023 slice; the module imports its own repository and schema files directly. */
export { agentExtensions } from '../../../../../packages/data/src/repositories/agent-extensions.js';
export type { AgentExtensionSafetyRunRow, AgentExtensionVersionRow } from '../../../../../packages/data/src/schema/agent-extensions.js';
export { configActivationDigestInput, type CommandContext, type HubConfigVersionRow } from '../hubs/deps.js';
