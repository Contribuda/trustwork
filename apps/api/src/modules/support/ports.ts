import type { Transaction } from '../../deps/data.js';

/**
 * Entitlements on the account card are economic rights (offer codes and validity) owned by billing. Payment neutrality
 * means no module outside billing reads billing tables (tests/billing/policy.test.ts), so the card asks billing through
 * this port, inside the staff transaction. Billing has no staff read of entitlements yet (`admin.commerce.entitlement.read`
 * is a BILL follow-up): until the composition root wires one, the default adapter answers `null` ("not available")
 * and the card shows an empty list, which the console must label as not available rather than "none".
 */
export interface SupportEntitlementsPort {
  /** The person's valid entitlements, or null when this deployment cannot tell. */
  entitlementsOf(trx: Transaction, personId: string, at: Date): Promise<Array<{ offerCode: string; validUntil: string | null }> | null>;
}

export class UnavailableEntitlements implements SupportEntitlementsPort {
  async entitlementsOf(): Promise<null> {
    return null;
  }
}
