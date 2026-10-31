import type { EntitlementRow } from './deps.js';

/**
 * Free basic participation (BIL-F01): granted to every person and every company, buyer and seller alike, with no
 * billing account, entitlement row, plan or payment. A hub may add to it, never remove from it.
 */
export const FREE_BASIC_FEATURES = [
  'read', 'profile', 'publish_under_hub_rules', 'respond_to_rfq', 'respond_to_task', 'company_presence', 'request_consultation', 'agent_free_floor',
] as const;
export type FreeBasicFeature = (typeof FREE_BASIC_FEATURES)[number];

/** What an entitlement check asks for: a free basic feature, a paid agent module, or a paid offer by code. */
export type Feature =
  | { kind: 'participation'; key: FreeBasicFeature }
  | { kind: 'module'; moduleCode: string }
  | { kind: 'offer'; code: string };

export type EntitlementDecision =
  | { allowed: true; basis: 'free_basic' }
  | { allowed: true; basis: 'entitlement'; entitlementId: string; source: EntitlementRow['source'] }
  | { allowed: false; basis: 'none' };

/**
 * Pure decision over the party's currently valid entitlements (already filtered by validity and revocation).
 * Economic rights are separate from roles: no role, permission or administrator status is an input, and nothing
 * here is ever consulted by ranking, matching, recommendation or reputation code.
 */
export function decideEntitlement(feature: Feature, active: readonly (EntitlementRow & { offer_code: string })[]): EntitlementDecision {
  if (feature.kind === 'participation') return FREE_BASIC_FEATURES.includes(feature.key) ? { allowed: true, basis: 'free_basic' } : { allowed: false, basis: 'none' };
  const match = active.find((e) => (feature.kind === 'module' ? e.module_code === feature.moduleCode : e.offer_code === feature.code));
  return match ? { allowed: true, basis: 'entitlement', entitlementId: match.id, source: match.source } : { allowed: false, basis: 'none' };
}

/** Actions that spend money and the budget kind each needs (contract `budgetKindFor`); no other action reserves. */
export const SPENDING_ACTIONS = ['place_order', 'accept_order', 'generate_deliverable', 'subscribe'] as const;
export type SpendingAction = (typeof SPENDING_ACTIONS)[number];
