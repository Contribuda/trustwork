import { JurisdictionSettingsSchema, type JurisdictionBaseline, type JurisdictionSettings } from '../../../packages/contracts/src/jurisdiction.js';
import { JURISDICTION_SETTING_AREAS } from '../../../packages/contracts/src/hub.js';

/** Entirely synthetic policy values, not country facts, counsel approval or released defaults. */
export const LOCALES = ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn'];
export function syntheticSettings(jurisdiction = 'US'): JurisdictionSettings {
  return JurisdictionSettingsSchema.parse({
    jurisdiction,
    policy: {
      disclosureTextKeys: Object.fromEntries(LOCALES.map((l) => [l, 'synthetic.agentDisclosure'])),
      liabilityAllocationKey: 'synthetic.principalLiability',
      consentRequirements: ['synthetic.electronicRecords'],
      recordKeeping: [{ recordClass: 'synthetic.actionEvidence', minimumDays: 30, maximumDays: 365 }],
      actionLimits: [{ action: 'send_quote', approval: 'pre_authorized', approvalAbove: { minorUnits: '10000', currency: 'USD' } }],
      legalTextKeys: Object.fromEntries(LOCALES.map((l) => [l, ['synthetic.agentTerms']])),
    },
    packDefaults: JURISDICTION_SETTING_AREAS.map((area) => ({ area, fact: { packCode: jurisdiction.slice(0, 2), packVersion: 'synthetic-1', factKey: `synthetic-${area}` } })),
  });
}
export function syntheticBaseline(settings = syntheticSettings()): JurisdictionBaseline {
  return structuredClone({ jurisdiction: settings.jurisdiction, policy: settings.policy, mandatoryAreas: [...JURISDICTION_SETTING_AREAS], packDefaults: settings.packDefaults });
}
export const payloadOf = (...jurisdictions: JurisdictionSettings[]) => ({ addedRestrictedPlaces: [], agentSettings: { schemaVersion: 1, jurisdictions } });
