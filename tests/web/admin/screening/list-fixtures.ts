import { getPack, validatePack } from '../../../../packages/country-packs/src/index.js';
import { registeredListSources } from '../../../../packages/compliance/src/lists/catalog.js';
import { syncScreeningListSources } from '../../../../packages/data/src/repositories/screening-list-authority.js';
import { withMaintenance, type DataPool } from '@trustwork/data';

/** Configured synthetic fact only in tests. Never installed in a product pack or production catalogue. */
export function syntheticListSources() {
  const pack = getPack('US')!;
  return registeredListSources([validatePack({ ...pack, facets: { ...pack.facets, sanctions: [{
    id: 'synthetic-official-export', name: {en:'Synthetic local export'},
    authority: {name:{en:'Synthetic test authority'},url:'https://ofac.treasury.gov/'},
    url:'https://ofac.treasury.gov/synthetic-test-only', verification:'official',
    sources:[{url:'https://ofac.treasury.gov/synthetic-test-only',what:'Synthetic fixture; no source was fetched or reviewed',accessed:'2026-10-31'}],
    adapter:{capability:'sanctions_list',id:'ofac-sls-xml'},
  }] } })]);
}
export async function installSyntheticListSources(pool: DataPool) {
  await withMaintenance(pool,(trx)=>syncScreeningListSources(trx,syntheticListSources()));
}
