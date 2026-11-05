import type { ConsolePermission } from '@trustwork/contracts/client';

/**
 * Live commands of HC-100 Providers and HC-102 Egress (HUBC-007 on the KEYS-001 and HUB-001 routes). Pure: no clock of its
 * own, no I/O. What is checked here only words a mistake early; the API and the database repeat every rule.
 *
 * A secret value is not a field of any command here. It goes from the browser straight to the write-only route
 * (`SecretEntry.tsx`), so it never passes the console's server action, its form fields or this file. Only references are
 * handled: a credential names where a secret lives, and a label or endpoint that looks like a key is refused by the API.
 */

export const PROVIDER_COMMANDS = [
  'providers.connection_create', 'providers.connection_test', 'providers.connection_enable', 'providers.connection_disable', 'providers.secret_revoke', 'providers.kill_engage', 'providers.kill_release',
  'providers.credential_register', 'providers.credential_activate', 'providers.credential_retire', 'providers.pricing_record', 'providers.egress_set', 'providers.egress_signoff',
] as const;
export type ProviderCommandId = (typeof PROVIDER_COMMANDS)[number];
export function isProviderCommand(value: unknown): value is ProviderCommandId {
  return typeof value === 'string' && (PROVIDER_COMMANDS as readonly string[]).includes(value);
}

/** The refusal of a provider rule: `detail` holds the reason code, worded by `providers.reasons.*`. */
export const PROVIDER_REJECT_CODES = ['provider_reason'] as const;

export const PROVIDER_COMMAND_PERMISSIONS: Record<ProviderCommandId, readonly ConsolePermission[]> = {
  'providers.connection_create': ['admin.providers.connection.edit'],
  'providers.connection_test': ['admin.providers.test'],
  'providers.connection_enable': ['admin.providers.toggle'],
  'providers.connection_disable': ['admin.providers.toggle'],
  'providers.secret_revoke': ['admin.providers.secret.write'],
  'providers.kill_engage': ['admin.providers.kill'],
  'providers.kill_release': ['admin.providers.kill'],
  'providers.credential_register': ['admin.providers.secret.write'],
  'providers.credential_activate': ['admin.providers.toggle'],
  'providers.credential_retire': ['admin.providers.toggle'],
  'providers.pricing_record': ['admin.providers.connection.edit', 'admin.providers.budget.edit'],
  'providers.egress_set': ['admin.providers.egress.edit'],
  'providers.egress_signoff': ['admin.providers.egress.edit', 'admin.config.edit'],
};

export const CAPABILITIES = [
  'llm', 'embeddings', 'rerank', 'image_generation', 'translation', 'speech_to_text', 'text_to_speech', 'ocr', 'web_search', 'web_fetch', 'email', 'sms', 'messenger', 'payments', 'payouts', 'e_invoicing', 'e_signature',
  'register_lookup', 'sanctions_list', 'maps_geocoding', 'object_storage', 'tax_calculation',
] as const;
export const CONNECTION_MODES = ['fake', 'manual', 'live'] as const;
export const HOSTING_KINDS = ['self_hosted', 'vendor'] as const;
export const SECRET_STORES = ['env', 'file', 'external_kms', 'external_vault'] as const;
export const PRICING_BASES = ['provider_list', 'contract', 'measured'] as const;
export const DATA_CLASSES = ['public', 'person_private', 'company_private', 'project_restricted', 'deal_party_private'] as const;
export const EGRESS_DECISIONS = ['deny', 'allow'] as const;
/** The default and the bound of the grace period of a rotated secret, in hours. */
export const SECRET_GRACE_DEFAULT_HOURS = 24;
export const SECRET_GRACE_MAX_HOURS = 168;

type Fields = Readonly<Record<string, string>>;
export type Invalid = { field: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TOKEN = /^[a-z][a-z0-9_]{1,40}$/;
const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const DECIMAL = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;
const text = (value: string | undefined) => (value ?? '').trim();
const on = (value: string | undefined) => value === 'on';
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[]): T | null => (allowed.includes(value as T) ? (value as T) : null);
const country = (value: string | undefined) => text(value).toUpperCase();

/** The body of `POST .../providers/connections`, or the field to correct. Whether the place is restricted is the API's to refuse. */
export function connectionDraft(f: Fields) {
  const label = text(f.label);
  if (!label || label.length > 200) return { field: 'label' };
  const adapterId = text(f.adapterId);
  if (!ID_TOKEN.test(adapterId)) return { field: 'adapterId' };
  const mode = oneOf(f.mode, CONNECTION_MODES);
  if (!mode) return { field: 'mode' };
  const capabilities = CAPABILITIES.filter((c) => on(f[`cap.${c}`]));
  if (!capabilities.length) return { field: 'capabilities' };
  const kind = oneOf(f.hostingKind, HOSTING_KINDS);
  if (!kind) return { field: 'hostingKind' };
  const hostingCountry = country(f.hostingCountry);
  if (!COUNTRY.test(hostingCountry)) return { field: 'hostingCountry' };
  const hosting = kind === 'vendor' ? { kind, country: hostingCountry, zeroRetention: on(f.zeroRetention), trainsOnInputs: on(f.trainsOnInputs), broker: on(f.broker) } : { kind, country: hostingCountry };
  const endpoint = text(f.endpoint);
  if (endpoint && !/^https?:\/\/\S+$/.test(endpoint)) return { field: 'endpoint' };
  const storage = country(f.storageCountry);
  if (storage && !COUNTRY.test(storage)) return { field: 'storageCountry' };
  const region = text(f.region);
  if (region && !REGION.test(region)) return { field: 'region' };
  const credential = text(f.credentialRefId);
  if (credential && (!UUID.test(credential) || mode === 'fake')) return { field: 'credentialRefId' };
  return { adapterId, mode, label, capabilities, endpoint: endpoint || null, hosting, storageCountry: storage || null, region: region || null, credentialRefId: credential || null };
}

/** The body of `POST .../credentials`: where a secret lives, never the secret. */
export function credentialDraft(f: Fields) {
  const provider = text(f.credProvider);
  if (!ID_TOKEN.test(provider)) return { field: 'credProvider' };
  const adapter = text(f.credAdapter);
  if (!ID_TOKEN.test(adapter)) return { field: 'credAdapter' };
  const mode = oneOf(f.credMode, CONNECTION_MODES);
  if (!mode) return { field: 'credMode' };
  const store = oneOf(f.credStore, SECRET_STORES);
  if (!store) return { field: 'credStore' };
  const ref = text(f.credRef);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(ref)) return { field: 'credRef' };
  return { provider, adapter, mode, secret: { store, ref } };
}

/** The body of `POST .../providers/pricing`, or the field to correct. A cost record never sets a sale price. */
export function pricingDraft(f: Fields, form: { currency: string; now: Date }) {
  if (!UUID.test(f.priceConnection ?? '')) return { field: 'priceConnection' };
  const modelId = text(f.priceModel);
  if (!modelId || modelId.length > 200) return { field: 'priceModel' };
  const input = text(f.priceInput);
  if (input && !DECIMAL.test(input)) return { field: 'priceInput' };
  const output = text(f.priceOutput);
  if (output && !DECIMAL.test(output)) return { field: 'priceOutput' };
  if (!input && !output) return { field: 'priceInput' };
  const basis = oneOf(f.priceBasis, PRICING_BASES);
  if (!basis) return { field: 'priceBasis' };
  const note = text(f.priceNote);
  if (note.length > 280) return { field: 'priceNote' };
  return { connectionId: f.priceConnection as string, modelId, currency: form.currency, inputPerMillionTokens: input || null, outputPerMillionTokens: output || null, perImage: null, perAudioMinute: null, basis, observedAt: form.now.toISOString(), sourceNote: note || null };
}

/** One cell of the egress matrix. Allowing non-public data always carries both requirements. */
export function egressCell(f: Fields) {
  if (!UUID.test(f.egressConnection ?? '')) return { field: 'egressConnection' };
  const dataClass = oneOf(f.egressClass, DATA_CLASSES);
  if (!dataClass) return { field: 'egressClass' };
  const decision = oneOf(f.egressDecision, EGRESS_DECISIONS);
  if (!decision) return { field: 'egressDecision' };
  const nonPublicAllow = decision === 'allow' && dataClass !== 'public';
  return { connectionId: f.egressConnection as string, dataClass, decision, requireInResidency: nonPublicAllow || on(f.egressResidency), requireZeroRetention: nonPublicAllow || on(f.egressZeroRetention) };
}

const failed = (body: object): Invalid | null => ('field' in body ? (body as Invalid) : null);

/** What the shell's evaluation checks for these commands after role, elevation and reason: a well-formed form. */
export function providerFormProblem(command: ProviderCommandId, f: Fields, form: { currency: string; now: Date }): Invalid | null {
  switch (command) {
    case 'providers.connection_create':
      return failed(connectionDraft(f));
    case 'providers.credential_register':
      return failed(credentialDraft(f));
    case 'providers.pricing_record':
      return failed(pricingDraft(f, form));
    case 'providers.egress_set':
      return failed(egressCell(f));
    case 'providers.egress_signoff':
      return null;
    case 'providers.kill_release':
      if (!UUID.test(f.killSwitchId ?? '')) return { field: 'killSwitchId' };
      return text(f.incidentNote) && text(f.incidentNote).length <= 280 ? null : { field: 'incidentNote' };
    case 'providers.credential_activate':
    case 'providers.credential_retire':
      return UUID.test(f.credentialId ?? '') ? null : { field: 'credentialId' };
    case 'providers.connection_test':
    case 'providers.connection_enable':
    case 'providers.connection_disable':
    case 'providers.secret_revoke':
    case 'providers.kill_engage':
      return UUID.test(f.connectionId ?? '') ? null : { field: 'connectionId' };
  }
}
