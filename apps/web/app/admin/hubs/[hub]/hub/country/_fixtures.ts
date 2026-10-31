import { LocalAdditionSchema, type LocalAddition } from '../../../../_data/schemas.js';
import { HUB_SAMARKAND_ID, HUB_US_ID } from '../../../../_fixtures/ids.js';

/**
 * Section-local fixtures of HC-15: local additions on top of the bound country pack. Labels are data in the hub's
 * languages; every addition is a `candidate` until the compliance officer confirms it, and links point at the issuer.
 */
export const LOCAL_ADDITIONS: Readonly<Record<string, readonly LocalAddition[]>> = {
  [HUB_US_ID]: [
    LocalAdditionSchema.parse({ synthetic: true, kind: 'register', key: 'US-CA:cslb', label: { en: 'California contractor licence look-up', es: 'Consulta de licencias de contratistas de California' }, verification: 'candidate', source: 'https://www.cslb.ca.gov/' }),
    LocalAdditionSchema.parse({ synthetic: true, kind: 'licence_category', key: 'US-CA:cslb-b', label: { en: 'General building contractor (B)', es: 'Contratista general de edificación (B)' }, verification: 'candidate', source: 'https://www.cslb.ca.gov/' }),
    LocalAdditionSchema.parse({ synthetic: true, kind: 'holiday', key: 'US-CA:cesar-chavez-day', label: { en: 'Cesar Chavez Day', es: 'Día de César Chávez' }, verification: 'candidate', source: null }),
  ],
  [HUB_SAMARKAND_ID]: [],
};
