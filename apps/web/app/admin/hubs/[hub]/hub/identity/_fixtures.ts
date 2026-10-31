import { BrandCheckSchema } from '../../../../_data/schemas.js';
import { HUB_US_ID } from '../../../../_fixtures/ids.js';

/** Section-local fixtures of HC-10: brand overlay contrast per hub language (synthetic results of the engine's check). */
export const BRAND_CHECKS: Readonly<Record<string, ReadonlyArray<ReturnType<typeof BrandCheckSchema.parse>>>> = {
  [HUB_US_ID]: [
    BrandCheckSchema.parse({ locale: 'en', ratio: '12.6', passes: true, synthetic: true }),
    BrandCheckSchema.parse({ locale: 'es', ratio: '12.6', passes: true, synthetic: true }),
  ],
};
