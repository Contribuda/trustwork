import type { AccessInventory } from '../inventory.js';

/**
 * KEYS-001 (packages/data/migrations/providers): provider connections, secret references and ciphertext (never readable
 * by a runtime role), connection tests, caps, routes, the egress matrix, cost records, route kill switches, the spend
 * ledger, cap alerts and the change log. The call gate (authorize, settle, release, call secret) is also granted to the
 * worker role; the grace sweep is the worker's only.
 */
export default {
  package: 'KEYS-001',
  forcedTables: [
    'connection_test', 'egress_rule', 'model_pricing', 'model_route', 'provider_budget', 'provider_budget_alert', 'provider_config_change', 'provider_connection',
    'provider_route_kill_switch', 'provider_usage', 'secret_ref', 'secret_version',
  ],
  apiDefiners: [
    'providers_create_connection', 'providers_update_connection', 'providers_store_secret', 'providers_revoke_secret', 'providers_test_material', 'providers_record_test',
    'providers_enable_connection', 'providers_disable_connection', 'providers_set_egress_rule', 'providers_draft_route', 'providers_activate_route', 'providers_disable_route',
    'providers_create_budget', 'providers_update_budget', 'providers_retire_budget', 'providers_record_pricing', 'providers_engage_kill', 'providers_release_kill',
    'providers_authorize_call', 'providers_settle_call', 'providers_release_call', 'providers_call_secret', 'providers_staff_reader', 'providers_cap_usage', 'providers_connection_facts',
  ],
  workerDefiners: ['providers_destroy_expired_secrets'],
} satisfies AccessInventory;
