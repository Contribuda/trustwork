import type { ConsolePermission } from '@trustwork/contracts/client';

/**
 * Live commands of HC-91 Prices (HUBC-007 on the BILL-003 and AGT-004 routes). Pure: no clock of its own, no I/O. What is
 * checked here only words a mistake early; the API and the database repeat every rule, and a price stays the operator's
 * setting: nothing here derives one from a cost, and no field names a participant.
 */

export const PRICE_COMMANDS = ['prices.fee_draft', 'prices.sale_draft', 'prices.cost_record', 'prices.usage_draft', 'prices.usage_cancel', 'prices.request_activation', 'prices.activate'] as const;
export type PriceCommandId = (typeof PRICE_COMMANDS)[number];
export function isPriceCommand(value: unknown): value is PriceCommandId {
  return typeof value === 'string' && (PRICE_COMMANDS as readonly string[]).includes(value);
}

/** Refusals only these commands answer. */
export const PRICE_REJECT_CODES = ['drafter_cannot_ask', 'cost_record_missing', 'priced_elsewhere'] as const;

const ACTIVATORS: readonly ConsolePermission[] = ['admin.billing.fees.activate', 'admin.commerce.price.activate'];
/** The permission of each command; which of the two activators applies follows the version, and the API checks it again. */
export const PRICE_COMMAND_PERMISSIONS: Record<PriceCommandId, readonly ConsolePermission[]> = {
  'prices.fee_draft': ['admin.billing.fees.draft'],
  'prices.sale_draft': ['admin.commerce.price.draft'],
  'prices.cost_record': ['admin.commerce.price.draft'],
  'prices.usage_draft': ['admin.commerce.price.draft'],
  'prices.usage_cancel': ['admin.commerce.price.draft'],
  'prices.request_activation': ACTIVATORS,
  'prices.activate': ACTIVATORS,
};

export const FEE_KINDS = ['consultation', 'task', 'ticket', 'course'] as const;
export const FEE_PAYERS = ['buyer', 'seller'] as const;
export const METERS = ['model_tokens', 'agent_actions', 'checks', 'document_pages', 'deliverables', 'translation_characters', 'retrieval_queries', 'external_calls'] as const;
export const SALE_KINDS = ['model', 'capability'] as const;
export const USAGE_SUBJECTS = ['module', 'capability', 'model', 'meter'] as const;
export const COST_SUBJECTS = ['module', 'capability', 'meter'] as const;
export const COST_BASES = ['model_list_price', 'measured_average', 'contract'] as const;
export const PRICE_BASES = ['flat', 'markup'] as const;
export const MODEL_DIRECTIONS = ['input', 'output'] as const;
export const PRICE_TARGETS = ['fee', 'sale', 'usage'] as const;
export type PriceTarget = (typeof PRICE_TARGETS)[number];

type Fields = Readonly<Record<string, string>>;
export type PriceForm = { currency: string; now: Date };
export type Refused = { field: string; code?: 'back_dated' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINOR = /^(0|[1-9][0-9]{0,17})$/;
const DECIMAL = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;
const CATEGORY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MODULE_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const CAPABILITY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const MODEL = /^[a-z0-9][a-z0-9._-]{1,80}$/;
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[]): T | null => (allowed.includes(value as T) ? (value as T) : null);
const text = (value: string | undefined) => (value ?? '').trim();

/** `YYYY-MM-DD` after today (UTC) as the start of that day; a version is never back-dated. */
function effectiveFrom(value: string | undefined, now: Date, field: string): string | Refused {
  const date = text(value);
  const at = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(at)) return { field };
  return at > now.getTime() ? `${date}T00:00:00.000Z` : { field, code: 'back_dated' };
}

/** A percentage with up to two decimals as basis points, in whole numbers: no float touches a rate. */
export function basisPoints(value: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const points = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  return points <= 10_000 ? points : null;
}

/** The body of `POST /v1/admin/billing/fees`, or the field to correct. */
export function feeDraft(f: Fields, { currency, now }: PriceForm) {
  const kind = oneOf(f.feeKind, FEE_KINDS);
  if (!kind) return { field: 'feeKind' };
  const payer = oneOf(f.feePayer, FEE_PAYERS);
  if (!payer) return { field: 'feePayer' };
  const category = text(f.feeCategory);
  if (category && (!CATEGORY.test(category) || category.length < 2 || category.length > 61 || !['consultation', 'task'].includes(kind))) return { field: 'feeCategory' };
  const percent = text(f.feePercent);
  const rate = percent ? basisPoints(percent) : null;
  if (percent && rate === null) return { field: 'feePercent' };
  const fixed = text(f.feeFixedMinor);
  if (fixed && !MINOR.test(fixed)) return { field: 'feeFixedMinor' };
  if (!percent && !fixed) return { field: 'feePercent' };
  const start = effectiveFrom(f.feeEffectiveFrom, now, 'feeEffectiveFrom');
  if (typeof start !== 'string') return start;
  const acceptanceTextVersion = text(f.feeAcceptance);
  if (!acceptanceTextVersion || acceptanceTextVersion.length > 40) return { field: 'feeAcceptance' };
  return { terms: { kind, categoryKey: category || null, currency, basisPoints: rate, fixedMinor: fixed || null, payer, effectiveFrom: start, effectiveTo: null, acceptanceTextVersion } };
}

/** The body of `POST /v1/admin/billing/sale-prices` for a model or a capability, or the field to correct. */
export function saleDraft(f: Fields, { currency, now }: PriceForm) {
  const kind = oneOf(f.saleKind, SALE_KINDS);
  if (!kind) return { field: 'saleKind' };
  const code = text(f.saleCode);
  if (!/^[a-z][a-z0-9_]{1,59}$/.test(code)) return { field: 'saleCode' };
  const name = text(f.saleName);
  if (!name || name.length > 200) return { field: 'saleName' };
  const subject = text(f.saleSubject);
  if (kind === 'capability' ? !CAPABILITY.test(subject) || subject.length > 100 : !subject || subject.length > 200) return { field: 'saleSubject' };
  const meter = oneOf(f.saleMeter, METERS);
  if (!meter) return { field: 'saleMeter' };
  const amountMinor = text(f.saleAmountMinor);
  if (!MINOR.test(amountMinor)) return { field: 'saleAmountMinor' };
  const perUnits = text(f.salePerUnits);
  if (!MINOR.test(perUnits) || perUnits === '0') return { field: 'salePerUnits' };
  const start = effectiveFrom(f.saleEffectiveFrom, now, 'saleEffectiveFrom');
  if (typeof start !== 'string') return start;
  const acceptanceTextVersion = text(f.saleAcceptance);
  if (!acceptanceTextVersion || acceptanceTextVersion.length > 40) return { field: 'saleAcceptance' };
  const base = { kind, code, name, currency, amountMinor, meter, perUnits, effectiveFrom: start, effectiveTo: null, acceptanceTextVersion };
  return { terms: kind === 'model' ? { ...base, modelId: subject } : { ...base, capabilityId: subject } };
}

/** A priced subject from the form's kind, key, meter and direction, or the field to correct. */
function usageSubject(kindField: string, keyField: string, meterField: string, f: Fields, kinds: readonly string[]) {
  const kind = oneOf(f[kindField], kinds);
  if (!kind) return { field: kindField };
  const meter = oneOf(f[meterField], METERS);
  if (!meter) return { field: meterField };
  const key = text(f[keyField]);
  if (kind === 'meter') return { kind, key: meter, meter };
  if (kind === 'module' && !MODULE_KEY.test(key)) return { field: keyField };
  if (kind === 'capability' && (!CAPABILITY.test(key) || key.length > 100)) return { field: keyField };
  if (kind !== 'model') return { kind, key, meter };
  if (!MODEL.test(key)) return { field: keyField };
  const direction = oneOf(f.usageDirection, MODEL_DIRECTIONS);
  return direction ? { kind, key, direction, meter: 'model_tokens' } : { field: 'usageDirection' };
}

/** The body of `POST /v1/admin/billing/metered/prices`, or the field to correct. A markup is computed by the engine, never here. */
export function usageDraft(f: Fields, { currency, now }: PriceForm) {
  const subject = usageSubject('usageSubject', 'usageKey', 'usageMeter', f, USAGE_SUBJECTS);
  if ('field' in subject) return subject;
  const kind = oneOf(f.usageBasis, PRICE_BASES);
  if (!kind) return { field: 'usageBasis' };
  const sale = text(f.usageSale);
  if (kind === 'flat' && !DECIMAL.test(sale)) return { field: 'usageSale' };
  const percent = text(f.usagePercent);
  if (kind === 'markup' && (!/^\d{1,4}$/.test(percent) || Number(percent) > 1000)) return { field: 'usagePercent' };
  const start = effectiveFrom(f.usageEffectiveFrom, now, 'usageEffectiveFrom');
  if (typeof start !== 'string') return start;
  const acceptanceTextVersion = text(f.usageAcceptance);
  if (!acceptanceTextVersion || acceptanceTextVersion.length > 40) return { field: 'usageAcceptance' };
  return { terms: { subject, currency, basis: kind === 'flat' ? { kind, salePerUnitMinor: sale } : { kind, percent: Number(percent) }, effectiveFrom: start, effectiveTo: null, acceptanceTextVersion } };
}

/** The body of `POST /v1/admin/billing/metered/costs`, or the field to correct. Model costs stay in the provider records. */
export function costRecord(f: Fields, { currency, now }: PriceForm) {
  const subject = usageSubject('costSubject', 'costKey', 'costMeter', f, COST_SUBJECTS);
  if ('field' in subject) return subject;
  const costPerUnitMinor = text(f.costPerUnit);
  if (!DECIMAL.test(costPerUnitMinor)) return { field: 'costPerUnit' };
  const basis = oneOf(f.costBasis, COST_BASES);
  if (!basis) return { field: 'costBasis' };
  return { cost: { subject, currency, costPerUnitMinor, basis, observedAt: now.toISOString() } };
}

const asProblem = (body: object): Refused | null => ('field' in body ? (body as Refused) : null);

/** What the shell's evaluation checks for these commands after role, elevation and reason: a well-formed form. */
export function priceFormProblem(command: PriceCommandId, f: Fields, form: PriceForm): Refused | null {
  switch (command) {
    case 'prices.fee_draft':
      return asProblem(feeDraft(f, form));
    case 'prices.sale_draft':
      return asProblem(saleDraft(f, form));
    case 'prices.usage_draft':
      return asProblem(usageDraft(f, form));
    case 'prices.cost_record':
      return asProblem(costRecord(f, form));
    case 'prices.usage_cancel':
      return UUID.test(f.id ?? '') ? null : { field: 'id' };
    case 'prices.request_activation':
    case 'prices.activate':
      if (!oneOf(f.target, PRICE_TARGETS)) return { field: 'target' };
      if (!UUID.test(f.id ?? '')) return { field: 'id' };
      return !f.supersedes || UUID.test(f.supersedes) ? null : { field: 'supersedes' };
  }
}
