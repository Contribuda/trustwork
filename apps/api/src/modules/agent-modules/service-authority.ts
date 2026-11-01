import type { Principal } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import type { AppContext } from '../identity/context.js';
import { CapabilityAuthority, requireCapability } from './authority.js';
import { servingHub } from './serving-hub.js';

/** Called inside the owning service transaction; its resource authorizer/projection still decides access. */
export async function requireParticipantCapability(
  ctx: AppContext, trx: Transaction, principal: Principal, capabilityId: string, onBehalfCompanyId: string | null = null,
  configuredAuthority: CapabilityAuthority = new CapabilityAuthority({ hubId: null }),
): Promise<void> {
  const binding = await servingHub(trx, ctx.config.publicOrigin);
  const authority = configuredAuthority.forHub(binding.hubId);
  await requireCapability(authority, trx, {
    personId: principal.personId, onBehalfCompanyId, representativeOf: null, connectionId: null,
  }, capabilityId);
  // Binding withdrawal takes the same hub epoch; re-read after acquiring the gate locks.
  await servingHub(trx, ctx.config.publicOrigin);
}
