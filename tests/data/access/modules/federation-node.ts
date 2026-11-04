import type { AccessInventory } from '../inventory.js';

/**
 * FED-001 (packages/data/migrations/federation-node): node identity, key chain and sealed seeds, manifest versions,
 * known peers, peering records and events, admission refusals, replay nonces, per-deal admissions and noticed revocations.
 */
export default {
  package: 'FED-001',
  forcedTables: [
    'admission_refusal', 'federation_nonce', 'federation_peer', 'node_identity', 'node_key', 'node_key_secret', 'node_manifest', 'peer_deal_admission', 'peer_key_revocation',
    'peering_event', 'peering_record',
  ],
  apiDefiners: [
    'federation_init_identity', 'federation_update_identity', 'federation_rotate_key', 'federation_request_peering', 'federation_accept_peering', 'federation_await_second_approver',
    'federation_decline_peering', 'federation_lower_peering', 'federation_suspend_peering', 'federation_lift_suspension', 'federation_end_peering', 'federation_note_refresh',
    'federation_node_signing_material', 'federation_node_record_manifest', 'federation_peer_record', 'federation_peer_equivocation', 'federation_handshake_received',
    'federation_peer_answered', 'federation_refusal_record', 'federation_note_nonce', 'federation_purge_nonces', 'federation_deal_admission', 'federation_revocation_noticed',
    'federation_flow_allowed', 'federation_peer_get', 'federation_records_of_peer', 'federation_record_get', 'federation_peers_due', 'federation_peer_ended',
    'federation_manifest_hubs', 'federation_hub_by_slug',
    'federation_staff_reader', 'federation_peer_reader', 'federation_refusal_reader',
  ],
} satisfies AccessInventory;
