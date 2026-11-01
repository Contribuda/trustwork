/**
 * The live setup wizard's form values as the API's step answers (HUB-004, `packages/contracts/src/hub-setup.ts`). Pure
 * and browser-safe: the server validates every answer against the contract again and refuses restricted places; this
 * only shapes what a person typed. Field names start with `f.` like every console form.
 */
export type FormValues = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };

export const SETUP_PROVIDER_FIELDS = ['llm', 'email', 'sms', 'payments', 'maps_geocoding', 'register_lookup', 'e_signature', 'tax_calculation'] as const;

const text = (form: FormValues, name: string): string => {
  const value = form.get(`f.${name}`);
  return typeof value === 'string' ? value.trim() : '';
};
const upper = (form: FormValues, name: string): string => text(form, name).toUpperCase();
const optional = (value: string): string | null => (value === '' ? null : value);
const list = (value: string): string[] => value.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);

/** `US`, `US-CA` or `US-CA:san-diego` as a territory; the level follows from the code's shape. */
export function territoryOf(code: string): { level: 'country' | 'region' | 'place'; code: string } {
  const [area = '', key] = code.split(':');
  const normalized = key === undefined ? area.toUpperCase() : `${area.toUpperCase()}:${key.toLowerCase()}`;
  return { level: key !== undefined ? 'place' : area.includes('-') ? 'region' : 'country', code: normalized };
}

/** The answer of one saved step, from the form. */
export function answerFor(step: string, form: FormValues, now: Date = new Date()): Record<string, unknown> {
  switch (step) {
    case 'install_check':
      return { clientTime: now.toISOString() };
    case 'node_identity':
      return { nodeName: text(form, 'nodeName'), domain: text(form, 'domain').toLowerCase(), jurisdiction: upper(form, 'jurisdiction') };
    case 'hub_identity': {
      const locales = list(text(form, 'languages'));
      const name = text(form, 'name');
      const slug = text(form, 'slug').toLowerCase();
      return {
        country: upper(form, 'country'),
        startingPoint: text(form, 'startingPoint') === 'pack' ? 'pack' : 'generic',
        territories: list(text(form, 'territories')).map(territoryOf),
        ...(slug ? { slug } : {}),
        name: Object.fromEntries(locales.map((l) => [l, name])),
        locales,
        defaultLocale: locales[0] ?? '',
        currency: upper(form, 'currency'),
        timeZone: text(form, 'timeZone'),
      };
    }
    case 'operator':
      return {
        legalName: text(form, 'legalName'), form: text(form, 'form'), identifier: text(form, 'identifier'), address: text(form, 'address'),
        legalContact: text(form, 'legalContact'), abuseContact: text(form, 'abuseContact'), ownershipDeclared: form.get('f.ownership') === 'on',
        entityCountry: upper(form, 'entityCountry'), entityRegion: optional(upper(form, 'entityRegion')),
        hostingCountry: upper(form, 'hostingCountry'), hostingRegion: optional(upper(form, 'hostingRegion')), gateMode: text(form, 'gateMode'),
      };
    case 'storage_residency': {
      const note = text(form, 'note');
      return { personalDataCountry: upper(form, 'personalDataCountry'), privacyRegime: text(form, 'privacyRegime'), ...(note ? { note } : {}) };
    }
    case 'providers': {
      const models = text(form, 'models') || 'undecided';
      return {
        capabilities: Object.fromEntries(SETUP_PROVIDER_FIELDS.map((c) => [c, text(form, `provider.${c}`) || 'fake'])),
        models,
        directModelAdapter: models === 'direct' ? optional(text(form, 'directModelAdapter')) : null,
      };
    }
    case 'modes':
      return { dataMode: text(form, 'dataMode') === 'live' ? 'live' : 'demo', moderation: text(form, 'moderation') || 'pre_moderate_new_authors' };
    default:
      return {};
  }
}
