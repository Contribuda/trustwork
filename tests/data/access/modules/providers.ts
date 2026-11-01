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
  // Preserved owning implementations are callable only behind the callback-order wrappers.
  internalDefiners: [
    'callback_unfenced_admin_engage_kill_switch',
    'callback_unfenced_admin_release_kill_switch',
    'callback_unfenced_hubs_activate_config',
    'callback_unfenced_hubs_cancel_config',
    'callback_unfenced_hubs_create',
    'callback_unfenced_hubs_draft_config',
    'callback_unfenced_hubs_update_profile',
    'callback_unfenced_models_admit',
    'callback_unfenced_models_begin',
    'callback_unfenced_models_fallback',
    'callback_unfenced_models_finish',
    'callback_unfenced_models_recover',
    'callback_unfenced_providers_activate_route',
    'callback_unfenced_providers_authorize_call',
    'callback_unfenced_providers_create_budget',
    'callback_unfenced_providers_create_connection',
    'callback_unfenced_providers_destroy_expired_secrets',
    'callback_unfenced_providers_disable_connection',
    'callback_unfenced_providers_disable_route',
    'callback_unfenced_providers_draft_route',
    'callback_unfenced_providers_enable_connection',
    'callback_unfenced_providers_engage_kill',
    'callback_unfenced_providers_record_pricing',
    'callback_unfenced_providers_record_test',
    'callback_unfenced_providers_release_call',
    'callback_unfenced_providers_release_kill',
    'callback_unfenced_providers_retire_budget',
    'callback_unfenced_providers_revoke_secret',
    'callback_unfenced_providers_set_egress_rule',
    'callback_unfenced_providers_settle_call',
    'callback_unfenced_providers_store_secret',
    'callback_unfenced_providers_update_budget',
    'callback_unfenced_providers_update_connection',
  ],
} satisfies AccessInventory;
