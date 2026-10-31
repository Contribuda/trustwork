/**
 * Relative re-exports of the connections slice (MCP-002). The module imports its contract and repository files directly
 * so the shared package entries (`packages/contracts/src/index.ts`, `packages/data/src/index.ts`) stay untouched.
 */
export {
  DEFAULT_CONNECTION_SCOPES, DEFAULT_MCP_HUB_POLICY, DEFAULT_TOOLSETS, MCP_ENDPOINT_PATHS, MCP_STAFF_SCOPES, MCP_TOOLSETS, McpHubPolicySchema, McpToolsetSchema,
  type McpHubPolicy, type McpToolset,
} from '../../../../../../packages/contracts/src/mcp.js';
export { ConnectionScopeSchema, PrivateDataClassSchema, type ConnectionScope, type PrivateDataClass } from '../../../../../../packages/contracts/src/agent-catalog.js';
export {
  connectionGrants, oauthClients, oauthTokens, type IntrospectedToken, type OAuthClientRecord, type TokenIssue,
} from '../../../../../../packages/data/src/repositories/connections.js';
export type { ConnectionSurface, MandateBindingRow } from '../../../../../../packages/data/src/schema/connections.js';
