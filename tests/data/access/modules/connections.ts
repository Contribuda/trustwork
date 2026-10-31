import type { AccessInventory } from '../inventory.js';

/** MCP-002 (packages/data/migrations/connections): the hub authorization server for the MCP surfaces. */
export default {
  package: 'MCP-002',
  forcedTables: ['connection', 'connection_call', 'connection_confirmation_challenge', 'connection_consent', 'connection_token', 'connection_token_family', 'oauth_authorization_code', 'oauth_client'],
  apiDefiners: ['oauth_client_get', 'oauth_client_store_metadata', 'oauth_client_register_dynamic', 'oauth_code_redeem', 'oauth_refresh_rotate', 'oauth_token_revoke',
    'connection_token_introspect', 'connection_consent_grant', 'oauth_code_issue', 'connection_revoke', 'connection_revoke_all'],
  internalDefiners: ['connections_revoke_on_credential_change'],
} satisfies AccessInventory;
