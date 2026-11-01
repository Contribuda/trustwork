/**
 * A synthetic shared layer and a synthetic member pack for the layer tests (CTRY-EU). Nothing here is a real fact: the
 * layer uses the code XL, its members use the user-assigned ISO codes XM and XN, every source points at
 * example.invalid, and every name, rate and amount is invented. The real EU layer (packages/country-packs/layers/eu.json)
 * cites real primary sources.
 */
const layerSource = (what: string) => [{ url: 'https://layer.example.invalid/acts/1', what: `Synthetic layer source: ${what}`, accessed: '2026-10-31' }];
const memberSource = (what: string) => [{ url: 'https://example.invalid/xm/law', what: `Synthetic member source: ${what}`, accessed: '2026-10-31' }];
const t = (en: string) => ({ en });

export function syntheticLayer() {
  return {
    layerVersion: 1,
    code: 'XL',
    name: t('Example Union (synthetic)'),
    summary: t('A synthetic layer for tests'),
    officialHosts: ['layer.example.invalid'],
    members: { codes: ['XM', 'XN'], verification: 'official', sources: layerSource('member list') },
    memberVaries: [
      { facet: 'tax', topic: 'vat-rates', summary: t('Members set their own rates'), sources: layerSource('rates are national') },
      { facet: 'calendar', topic: 'public-holidays', summary: t('Holidays are national') },
    ],
    verificationLevel: 'official',
    facets: {
      privacy: [
        { type: 'law', id: 'xl-data-law', name: t('Example Union data law'), consent: 'opt-in', breachNotificationHours: 72, sources: layerSource('data law'), verification: 'official' },
        { type: 'law', id: 'xl-child-consent', name: t('Child consent age'), minorsAge: 16, sources: layerSource('child consent age'), verification: 'official' },
      ],
      payments: [{ type: 'scheme', id: 'xl-credit-transfer', name: t('Example Union credit transfer'), rails: ['credit-transfer'], sources: layerSource('credit transfer'), verification: 'official' }],
      procurement: [{ type: 'portal', id: 'xl-notices', name: t('Example Union notices'), url: 'https://layer.example.invalid/notices', level: 'supranational', openData: true, sources: layerSource('notice portal'), verification: 'official' }],
      agentLaw: [{ id: 'xl-agent-disclosure', topic: 'disclosure', summary: t('Tell people they talk to an agent'), counselReview: 'pending', sources: layerSource('disclosure'), verification: 'secondary' }],
    },
    sources: layerSource('the layer'),
  };
}

export function syntheticMember(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    code: 'XM',
    name: t('Member of Exampleland (synthetic)'),
    enabled: false,
    status: 'draft',
    locales: ['en'],
    defaultLocale: 'en',
    currency: { code: 'XTS', minorUnitDigits: 2, displayFractionDigits: 2, symbol: 'X$' },
    secondaryCurrencies: [],
    formats: { timeZone: 'Europe/Paris', phone: { callingCode: '+999', nationalLength: 9, example: '+999 000 000 000' }, postalCode: { pattern: '^[0-9]{5}$', example: '12345' } },
    timeZones: ['Europe/Paris'],
    verificationLevel: 'pending',
    registrationIdentifier: {
      kind: 'XM-REG',
      label: t('Register number (synthetic)'),
      pattern: '^[0-9]{8}$',
      example: '00000000',
      issuer: { name: t('Example register (synthetic)'), url: 'https://example.invalid/xm/register' },
      verification: 'synthetic fixture',
      verificationLevel: 'pending',
      sources: memberSource('register number format'),
    },
    legalEntityTypes: [{ code: 'ltd', name: t('Limited company (synthetic)') }],
    regions: [{ code: 'XM-01', name: t('First Province'), kind: 'province' }],
    address: { lines: ['street', 'postalCode', 'city'], cityFirst: false },
    legalTemplates: { terms: 'terms', privacy: 'privacy', sanctions: 'sanctions-and-export-controls' },
    dataResidency: { required: false, note: t('Synthetic'), verificationLevel: 'pending', sources: memberSource('data residency') },
    layers: ['XL'],
    facets: {
      tax: [{ type: 'rate', id: 'xm-vat', taxKind: 'vat', name: t('Value added tax (synthetic)'), standardRate: '20', calculation: 'rate', sources: memberSource('VAT rate'), verification: 'pending' }],
    },
    sources: memberSource('the pack'),
    ...overrides,
  };
}
