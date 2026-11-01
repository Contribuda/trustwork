import { createHash } from 'node:crypto';
import { packs, type CountryPack } from '../../../country-packs/src/index.js';
import { findAdapter } from '../../../country-packs/src/adapters.js';
import { computeDigest } from '../../../contracts/src/common/digest.js';
import { findListAdapter } from './adapters.js';

/** Maintenance-only catalogue input, derived from installed facts, never from an HTTP request. */
export function registeredListSources(registered: readonly CountryPack[] = packs()) {
  return registered.filter((pack) => pack.enabled).flatMap((pack) => (pack.facets?.sanctions ?? []).flatMap((fact) => {
    const adapter = fact.adapter?.capability === 'sanctions_list' && findAdapter(fact.adapter) ? findListAdapter(fact.adapter.id) : null;
    if (fact.verification !== 'official' || !adapter || !officialListOrigin(fact.url, adapter.officialOrigins) || fact.name.en!.length > 200 || fact.authority.name.en!.length > 200) return [];
    const snapshot = { packCode: pack.code, packVersion: computeDigest(pack).value, fact };
    return [{ packCode: pack.code, packVersion: computeDigest(pack).value, factId: fact.id,
      code: `pack-${pack.code.toLowerCase()}-${createHash('sha256').update(fact.id).digest('hex').slice(0, 24)}`,
      name: fact.name.en!, authority: fact.authority.name.en!, sourceUrl: fact.url, adapter: adapter.id,
      sourceDigest: computeDigest(snapshot).value, snapshot }];
  }));
}

/** Exact registered HTTPS origins only. Credentials, fragments and nonstandard ports are never authority. */
export function officialListOrigin(value: string, origins: readonly string[]): boolean {
  try { const url = new URL(value); return value.length <= 500 && url.protocol === 'https:' && !url.username && !url.password && !url.hash && origins.includes(url.origin); }
  catch { return false; }
}
