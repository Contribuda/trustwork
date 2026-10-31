import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../common/ids.js';
import { NonNegativeMoneySchema } from '../common/money.js';
import { CategoryCodeSchema } from '../agent-catalog.js';
import { NonNegativeDecimalSchema, RegionCodeSchema } from './common.js';
import { PAYEE_COOLING_OFF_DEFAULT_BUSINESS_DAYS, PAYEE_COOLING_OFF_MINIMUM_BUSINESS_DAYS } from './payments.js';
import { compareDecimal } from '../common/quantity.js';

/**
 * Hub and company settings of the suite, and the opt-in price benchmarks (ADR 012 decision 34). The hub payload is the
 * proposed `procurement` domain of `hub_config_version` (integrator request); a company may be stricter than the hub,
 * never weaker. Every risky option is off by default.
 */

export const BENCHMARK_MIN_BUYERS = 5 as const;
export const BENCHMARK_MIN_SELLERS = 5 as const;
export const BENCHMARK_MAX_DOMINANCE_PERCENT = '30' as const;

export const BenchmarkSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  minBuyers: z.int().min(BENCHMARK_MIN_BUYERS).max(1000),
  minSellers: z.int().min(BENCHMARK_MIN_SELLERS).max(1000),
  /** No single contributor above this share of a cell. */
  dominanceSharePercent: NonNegativeDecimalSchema.refine((v) => compareDecimal(v, BENCHMARK_MAX_DOMINANCE_PERCENT) <= 0 && compareDecimal(v, '0') > 0, 'dominance share above 0 and at most 30 percent'),
  /** Inputs are accepted agreement prices at least this many quarters old. */
  lagQuarters: z.int().min(1).max(8),
  methodVersion: z.int().min(1),
  counselSignoffRef: IdSchema.nullable(),
}).refine((b) => !b.enabled || b.counselSignoffRef !== null, { message: 'benchmarks are enabled only with the hub counsel sign-off', path: ['counselSignoffRef'] });

export const DemandPoolingSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  competitionLawOpinionRef: IdSchema.nullable(),
  maxPoolSharePercent: NonNegativeDecimalSchema.nullable(),
}).refine((p) => !p.enabled || p.competitionLawOpinionRef !== null, { message: 'pooling needs a recorded competition-law opinion', path: ['competitionLawOpinionRef'] });

export const ProcurementHubSettingsSchema = z.strictObject({
  domain: z.literal('procurement'),
  /** ADR 012 decision 34: a supplier's bank-detail change waits three business days by default; a hub may lengthen it. */
  payeeCoolingOffBusinessDays: z.int().min(PAYEE_COOLING_OFF_MINIMUM_BUSINESS_DAYS).max(30),
  callbackRequired: z.literal(true),
  /** Automatic release by an agent without asking: off by default; matched invoices to payees unchanged for `payeeUnchangedDays` only. */
  autoRelease: z.strictObject({ enabled: z.boolean(), payeeUnchangedDays: z.int().min(PAYEE_COOLING_OFF_MINIMUM_BUSINESS_DAYS).max(365), ceiling: NonNegativeMoneySchema.nullable() }),
  /** R46 and ADR 012 decision 34: no bank payment file exports for now. */
  bankPaymentFileExport: z.literal(false),
  /** Feedback bands for not-awarded bidders: the per-event default for buyers, off unless the hub allows the buyer opt-in. */
  feedbackBandsAllowed: z.boolean(),
  benchmarks: BenchmarkSettingsSchema,
  /** Demand pooling only after benchmarks are enabled (ADR 012 decision 34). */
  demandPooling: DemandPoolingSettingsSchema,
  /** Engine default free tier: one active project with the full suite. A hub may be more generous, never less. */
  freeTierActiveProjects: z.int().min(1).max(1000),
  routeActivationSecondPerson: z.boolean(),
  externalOcrAllowed: z.boolean(),
}).refine((s) => !s.demandPooling.enabled || s.benchmarks.enabled, { message: 'demand pooling comes after benchmarks', path: ['demandPooling'] });
export type ProcurementHubSettings = z.infer<typeof ProcurementHubSettingsSchema>;

/** Engine defaults: everything risky off, cooling-off three business days, one free active project. */
export const PROCUREMENT_HUB_DEFAULTS: ProcurementHubSettings = {
  domain: 'procurement',
  payeeCoolingOffBusinessDays: PAYEE_COOLING_OFF_DEFAULT_BUSINESS_DAYS,
  callbackRequired: true,
  autoRelease: { enabled: false, payeeUnchangedDays: 90, ceiling: null },
  bankPaymentFileExport: false,
  feedbackBandsAllowed: true,
  benchmarks: { enabled: false, minBuyers: BENCHMARK_MIN_BUYERS, minSellers: BENCHMARK_MIN_SELLERS, dominanceSharePercent: BENCHMARK_MAX_DOMINANCE_PERCENT, lagQuarters: 1, methodVersion: 1, counselSignoffRef: null },
  demandPooling: { enabled: false, competitionLawOpinionRef: null, maxPoolSharePercent: null },
  freeTierActiveProjects: 1,
  routeActivationSecondPerson: false,
  externalOcrAllowed: false,
};

export const CompanyProcurementSettingsVersionSchema = z.strictObject({
  id: IdSchema,
  companyId: IdSchema,
  version: z.int().min(1),
  payload: z.strictObject({
    modules: z.array(z.enum(['requisitions', 'approval_routes', 'supplier_base', 'sourcing', 'intake', 'cost_control', 'receiving', 'stock', 'invoices', 'payments'])).max(10),
    payeeCoolingOffBusinessDays: z.int().min(PAYEE_COOLING_OFF_MINIMUM_BUSINESS_DAYS).max(60),
    intakeConfidenceThreshold: z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/),
    /** Default of the per-event opt-in for not-awarded feedback bands: off (ADR 012 decision 34). */
    feedbackBandsDefault: z.boolean(),
    benchmarkContribution: z.boolean(),
  }),
  createdAt: TimestampSchema,
});

/** A company setting may be stricter than the hub, never weaker. */
export function companySettingsViolations(company: z.infer<typeof CompanyProcurementSettingsVersionSchema>['payload'], hub: ProcurementHubSettings): string[] {
  const out: string[] = [];
  if (company.payeeCoolingOffBusinessDays < hub.payeeCoolingOffBusinessDays) out.push('cooling-off shorter than the hub minimum');
  if (company.feedbackBandsDefault && !hub.feedbackBandsAllowed) out.push('feedback bands are not allowed in this hub');
  if (company.benchmarkContribution && !hub.benchmarks.enabled) out.push('benchmarks are off in this hub');
  return out;
}

/* ---------- Benchmarks ---------- */

export const BenchmarkContributionConsentSchema = z.strictObject({
  id: IdSchema,
  companyId: IdSchema,
  hubId: IdSchema,
  grantedByPersonId: IdSchema,
  scope: z.strictObject({ categories: z.array(CategoryCodeSchema).min(1).max(50), regions: z.array(RegionCodeSchema).min(1).max(50) }),
  grantedAt: TimestampSchema,
  withdrawnAt: TimestampSchema.nullable(),
});

/** A published cell: no identities, no project, no current bids. Suppressed cells carry no figures at all. */
export const PriceBenchmarkSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  methodVersion: z.int().min(1),
  materialClass: z.string().regex(/^[a-z]+(?:\.[a-z0-9_]+)*$/),
  unit: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/),
  region: RegionCodeSchema,
  period: z.string().regex(/^\d{4}-Q[1-4]$/),
  nBuyers: z.int().min(0),
  nSellers: z.int().min(0),
  suppressed: z.boolean(),
  p25: NonNegativeMoneySchema.nullable(),
  p50: NonNegativeMoneySchema.nullable(),
  p75: NonNegativeMoneySchema.nullable(),
}).refine((b) => b.suppressed === (b.p25 === null) && b.suppressed === (b.p50 === null) && b.suppressed === (b.p75 === null), { message: 'suppressed cells carry no figures', path: ['suppressed'] });

/** Quarter label `YYYY-Qn` → index for lag arithmetic. */
const quarterIndex = (q: string) => Number(q.slice(0, 4)) * 4 + Number(q.slice(6)) - 1;

/**
 * Whether a cell must be suppressed: fewer distinct buyers or sellers than the minimum, one contributor above the
 * dominance share, benchmarks disabled, or inputs younger than the lag.
 */
export function benchmarkCellSuppressed(cell: { nBuyers: number; nSellers: number; largestContributorSharePercent: string; period: string }, settings: z.infer<typeof BenchmarkSettingsSchema>, currentQuarter: string): boolean {
  if (!settings.enabled) return true;
  if (cell.nBuyers < settings.minBuyers || cell.nSellers < settings.minSellers) return true;
  if (compareDecimal(cell.largestContributorSharePercent, settings.dominanceSharePercent) > 0) return true;
  return quarterIndex(currentQuarter) - quarterIndex(cell.period) < settings.lagQuarters;
}
