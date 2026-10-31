/**
 * A synthetic federal country for the pack v2 schema tests (CTRY-002). Nothing here is a real fact: the country uses
 * the user-assigned ISO code XF, every source points at example.invalid, and names, rates, identifiers and holidays
 * are invented to exercise the shape (states, a district, a territory, a county inside a state, several time zones,
 * several identifier kinds, per-state sales tax, privacy law and holidays). Real packs (INTL-US and others) cite real
 * primary sources.
 */
const src = (what: string) => [{ url: 'https://example.invalid/xf/source', what: `Synthetic test source: ${what}`, accessed: '2026-10-30' }];
const t = (en: string) => ({ en });

export function federalFixture() {
  return {
    schemaVersion: 2,
    code: 'XF',
    name: t('Federation of Exampleland (synthetic)'),
    enabled: false,
    status: 'draft',
    locales: ['en'],
    defaultLocale: 'en',
    currency: { code: 'XTS', minorUnitDigits: 2, displayFractionDigits: 2, symbol: 'X$' },
    secondaryCurrencies: [],
    formats: {
      timeZone: 'America/Chicago',
      phone: { callingCode: '+999', nationalLength: 10, example: '+999 555 000 0000' },
      postalCode: { pattern: '^[0-9]{5}(-[0-9]{4})?$', example: '12345-6789' },
    },
    timeZones: ['America/New_York', 'America/Chicago', 'America/Denver', 'Pacific/Honolulu'],
    verificationLevel: 'pending',
    registrationIdentifier: {
      kind: 'XF-FTIN',
      label: t('Federal taxpayer number (synthetic)'),
      pattern: '^[0-9]{2}-[0-9]{7}$',
      example: '00-0000000',
      issuer: { name: t('Federal Revenue Office (synthetic)'), url: 'https://example.invalid/xf/revenue' },
      verification: 'synthetic fixture',
      verificationLevel: 'pending',
      sources: src('federal taxpayer number format'),
    },
    legalEntityTypes: [{ code: 'llc', name: t('Limited company (synthetic)') }],
    regions: [
      { code: 'XF-NO', name: t('North State'), kind: 'state', timeZones: ['America/New_York', 'America/Chicago'], facets: {
        identifiers: [{
          id: 'xf-no-contractor-licence', kind: 'XF-NO-CLN', role: 'licence', label: t('North State contractor licence'), pattern: '^[0-9]{6}$', example: '000123',
          issuer: { name: t('North State Contractors Board'), url: 'https://example.invalid/xf/no/board' }, register: 'xf-no-licence-board',
          sources: src('state licence number format'), verification: 'secondary',
        }],
        registers: [{ id: 'xf-no-licence-board', name: t('North State licence register'), url: 'https://example.invalid/xf/no/register', query: 'manual', covers: ['XF-NO-CLN'], sources: src('state licence register'), verification: 'candidate' }],
        licensing: [{
          type: 'activity', id: 'xf-no-general-contractor', name: t('General building contractor'), authority: { name: t('North State Contractors Board'), url: 'https://example.invalid/xf/no/board' },
          required: true, register: 'xf-no-licence-board', identifierKind: 'XF-NO-CLN', categories: [{ code: 'B', name: t('General building') }],
          sources: src('licence requirement'), verification: 'pending',
        }],
        tax: [{
          type: 'rate', id: 'xf-state-sales-tax', taxKind: 'sales', name: t('North State sales tax'), standardRate: '6.25', reducedRates: [{ rate: '0', appliesTo: t('Unprepared food') }],
          localRates: 'additive', registrationThreshold: { minorUnits: '10000000', currency: 'XTS' }, calculation: 'adapter', candidateAdapters: ['a tax-calculation provider (candidate)'],
          sources: src('state sales tax rate'), verification: 'secondary', effectiveFrom: '2020-01-01',
        }],
        privacy: [{ type: 'law', id: 'xf-no-consumer-privacy', name: t('North State Consumer Privacy Act'), consent: 'opt-out', subjectRequestDays: 45, appliesWhen: t('Businesses above a revenue threshold'), sources: src('state privacy law'), verification: 'pending' }],
        calendar: [{ type: 'holiday', id: 'founders-day', name: t('Founders Day'), holiday: 'state', nonWorking: true, rule: { kind: 'fixed', month: 3, day: 2 }, observed: 'none', sources: src('state holiday'), verification: 'pending' }],
      } },
      { code: 'XF-NOA', name: t('Alder County'), kind: 'municipality', parent: 'XF-NO', facets: {
        tax: [{ type: 'rate', id: 'xf-noa-local-sales-tax', taxKind: 'sales', name: t('Alder County local sales tax'), standardRate: '1.5', calculation: 'rate', sources: src('county sales tax'), verification: 'candidate' }],
      } },
      { code: 'XF-SO', name: t('South State'), kind: 'state', timeZones: ['America/Chicago', 'America/Denver'], facets: {
        tax: [{ type: 'rate', id: 'xf-state-sales-tax', taxKind: 'sales', name: t('South State has no general sales tax'), standardRate: null, calculation: 'rate', sources: src('no state sales tax'), verification: 'secondary' }],
        calendar: [{ type: 'working-week', id: 'working-week', days: ['mon', 'tue', 'wed', 'thu'], sources: src('state four-day public working week'), verification: 'pending' }],
      } },
      { code: 'XF-CD', name: t('Capital District'), kind: 'district' },
      { code: 'XF-IS', name: t('Island Territory'), kind: 'territory', timeZones: ['Pacific/Honolulu'], facets: {
        privacy: [{ type: 'data-residency', id: 'xf-is-residency', required: true, note: t('Territory records stay on the island (synthetic)'), sources: src('territory residency rule'), verification: 'pending' }],
      } },
    ],
    address: { lines: ['street', 'street2', 'city', 'region', 'postalCode'], cityFirst: false },
    legalTemplates: { terms: 'terms', privacy: 'privacy', sanctions: 'sanctions-and-export-controls' },
    dataResidency: { required: false, note: t('No federal residency rule (synthetic)'), verificationLevel: 'pending', sources: src('federal residency') },
    facets: {
      identifiers: [{
        id: 'xf-procurement-id', kind: 'XF-UEI', role: 'procurement', label: t('Procurement entity identifier'), pattern: '^[A-Z0-9]{12}$', example: 'ABCDEF123456',
        issuer: { name: t('Federal procurement office'), url: 'https://example.invalid/xf/procurement' }, register: 'xf-procurement-register', appliesTo: ['legal-entity', 'sole-proprietor'],
        sources: src('procurement identifier format'), verification: 'secondary',
      }],
      registers: [
        { id: 'xf-business-register', name: t('Federal business register'), url: 'https://example.invalid/xf/business', query: 'open_data', dataLicence: 'synthetic open licence', covers: ['XF-FTIN'], sources: src('business register'), verification: 'secondary' },
        { id: 'xf-procurement-register', name: t('Federal procurement register'), url: 'https://example.invalid/xf/procurement', query: 'api', covers: ['XF-UEI'], candidateAdapters: ['procurement register lookup'], sources: src('procurement register'), verification: 'candidate' },
      ],
      standards: [{ id: 'xf-building-code', system: t('Model building code'), body: { name: t('Code council'), url: 'https://example.invalid/xf/codes' }, textLicence: 'read-only', sources: src('building code'), verification: 'pending' }],
      procurement: [
        { type: 'portal', id: 'xf-federal-portal', name: t('Federal tenders portal'), url: 'https://example.invalid/xf/tenders', level: 'federal', openData: true, sources: src('tenders portal'), verification: 'candidate' },
        { type: 'threshold', id: 'xf-simplified-threshold', summary: t('Simplified acquisition threshold'), amount: { minorUnits: '25000000', currency: 'XTS' }, sources: src('threshold'), verification: 'pending' },
      ],
      tax: [{ type: 'rate', id: 'xf-federal-vat', taxKind: 'vat', name: t('No federal value-added tax'), standardRate: null, calculation: 'rate', sources: src('no federal VAT'), verification: 'secondary' }],
      eSignature: [{ id: 'xf-electronic-records-act', kind: 'signature', name: t('Electronic records act'), strength: 'simple', legalBasis: t('Electronic assent is valid for most commercial records'), sources: src('e-signature law'), verification: 'secondary' }],
      payments: [
        { type: 'scheme', id: 'xf-cards', name: t('Payment cards'), rails: ['card'], sources: src('card payments'), verification: 'secondary' },
        { type: 'scheme', id: 'xf-bank-network', name: t('Automated bank network'), rails: ['credit-transfer', 'direct-debit'], sources: src('bank transfers and debits'), verification: 'secondary' },
      ],
      calendar: [
        { type: 'working-week', id: 'working-week', days: ['mon', 'tue', 'wed', 'thu', 'fri'], sources: src('working week'), verification: 'pending' },
        { type: 'fiscal-year', id: 'federal-fiscal-year', startMonth: 10, startDay: 1, sources: src('fiscal year'), verification: 'pending' },
        { type: 'holiday', id: 'new-year', name: t('New Year'), holiday: 'federal', nonWorking: true, rule: { kind: 'fixed', month: 1, day: 1 }, observed: 'nearest-weekday', sources: src('holiday'), verification: 'pending' },
        { type: 'holiday', id: 'remembrance-day', name: t('Remembrance Day'), holiday: 'federal', nonWorking: true, rule: { kind: 'nth-weekday', month: 5, weekday: 'mon', nth: -1 }, sources: src('holiday'), verification: 'pending' },
        { type: 'holiday', id: 'labour-day', name: t('Labour Day'), holiday: 'federal', nonWorking: true, rule: { kind: 'nth-weekday', month: 9, weekday: 'mon', nth: 1 }, sources: src('holiday'), verification: 'pending' },
        { type: 'holiday', id: 'harvest-day', name: t('Harvest Day'), holiday: 'federal', nonWorking: true, rule: { kind: 'nth-weekday', month: 11, weekday: 'thu', nth: 4 }, sources: src('holiday'), verification: 'pending' },
        { type: 'holiday', id: 'moon-festival', name: t('Moon Festival'), holiday: 'observance', nonWorking: false, rule: { kind: 'dates', dates: ['2027-09-15', '2028-10-03'] }, sources: src('movable observance'), verification: 'candidate' },
      ],
      units: [
        { type: 'system', id: 'units-system', system: 'us-customary', common: ['ft', 'ft2', 'yd3', 'lb', 'bdft', 'sq'], sources: src('units in trade'), verification: 'pending' },
        { type: 'local-name', id: 'roofing-square', unit: 'sq', name: t('Roofing square'), sources: src('roofing unit'), verification: 'pending' },
      ],
      scripts: [{ id: 'english-latin', language: 'en', scripts: ['Latn'], direction: 'ltr', sources: src('script'), verification: 'pending' }],
      privacy: [{ type: 'retention', id: 'xf-tax-records', record: t('Tax and accounting records'), years: 7, sources: src('retention'), verification: 'pending' }],
      contentLaw: [{ id: 'xf-review-rules', topic: 'reviews', summary: t('Fake reviews are prohibited'), sources: src('review rules'), verification: 'pending' }],
      sanctions: [{
        id: 'xf-screening-list', name: t('Federal consolidated screening list'), authority: { name: t('Trade office'), url: 'https://example.invalid/xf/trade' }, url: 'https://example.invalid/xf/list',
        updateCadence: 'daily', adapter: { capability: 'sanctions_list', id: 'us-consolidated-screening-list' }, sources: src('screening list'), verification: 'pending',
      }],
      agentLaw: [{ id: 'xf-agent-disclosure', topic: 'disclosure', summary: t('Automated agents disclose that they are automated'), counselReview: 'pending', sources: src('agent disclosure'), verification: 'pending' }],
    },
    sources: [{ url: 'https://example.invalid/xf/subdivisions', what: 'Synthetic subdivision list', accessed: '2026-10-30' }],
  };
}

export type FederalFixture = ReturnType<typeof federalFixture>;
