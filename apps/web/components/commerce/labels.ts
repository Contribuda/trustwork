import type { Party } from '@trustwork/contracts/client';
import type { AuthenticatedPrincipal } from '@/app/_lib/data/types';
import { commerce } from './data';
import { partyName } from './parts';

/** Public names of the parties on a page (one read each, cached per request); a party without a public page gets a generic label. */
export async function partyLabels(principal: AuthenticatedPrincipal, parties: readonly Party[]): Promise<(party: Party) => string> {
  const unique = [...new Map(parties.map((p) => [`${p.kind}:${p.id}`, p])).values()];
  const resolved = await Promise.all(unique.map(async (p) => [`${p.kind}:${p.id}`, await commerce.partyLabel(principal, p)] as const));
  const map = new Map(resolved);
  return (party) => partyName(map.get(`${party.kind}:${party.id}`) ?? null, party);
}
