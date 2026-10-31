import { ResidencySchema, type Residency } from '../../../../_data/schemas.js';
import { HUB_SAMARKAND_ID, HUB_US_ID } from '../../../../_fixtures/ids.js';
import { HUBS } from '../../../../_fixtures/hubs.js';

/** Each example hub's own country, read from its pack binding (codes are data, never literals in code). */
const packOf = (hubId: string) => HUBS.find((h) => h.hub.id === hubId)!.hub.countryPack!.code;
const US = packOf(HUB_US_ID);
const UZ = packOf(HUB_SAMARKAND_ID);
/** A synthetic backup region in another country, to show the residency contradiction warning. */
const ELSEWHERE = 'DE';

/**
 * Section-local fixtures of HC-14. Sub-processors are generic capability descriptions with fake adapters ("Fake model
 * adapter"), never named vendors: no provider is connected anywhere in the demo. The Samarkand example records a
 * backup region outside Uzbekistan to show the contradiction warning.
 */
export const RESIDENCY: readonly Residency[] = [
  ResidencySchema.parse({
    synthetic: true,
    hubId: HUB_US_ID,
    country: US,
    regime: 'us_state_privacy',
    version: 1,
    services: [
      { service: 'database', region: 'us-west (demo)', country: US },
      { service: 'object_storage', region: 'us-west (demo)', country: US },
      { service: 'backups', region: 'us-east (demo)', country: US },
      { service: 'worker', region: 'us-west (demo)', country: US },
    ],
    subProcessors: [
      { name: 'Fake model adapter', capability: 'llm', mode: 'fake', country: US, privateData: false },
      { name: 'Fake e-mail adapter', capability: 'email', mode: 'fake', country: US, privateData: true },
      { name: 'Manual register look-ups', capability: 'register_lookup', mode: 'manual', country: US, privateData: false },
    ],
  }),
  ResidencySchema.parse({
    synthetic: true,
    hubId: HUB_SAMARKAND_ID,
    country: UZ,
    regime: 'uz_personal_data',
    version: 1,
    services: [
      { service: 'database', region: 'uz-central (example)', country: UZ },
      { service: 'object_storage', region: 'uz-central (example)', country: UZ },
      { service: 'backups', region: 'eu-central (example)', country: ELSEWHERE },
    ],
    subProcessors: [{ name: 'Fake e-mail adapter', capability: 'email', mode: 'fake', country: UZ, privateData: true }],
  }),
];
