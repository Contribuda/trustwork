import { z } from 'zod';
import { MandateActionV2Schema } from './agent-catalog.js';
import { NonNegativeMoneySchema, type Money } from './common/money.js';
import { JurisdictionCodeSchema, JurisdictionSettingAreaSchema, LocaleTagSchema, PackFactRefSchema } from './hub.js';

/** HUB-005: configuration values, never legal defaults or authority supplied by a caller. */
const Key = z.string().regex(/^[a-z][A-Za-z0-9_.-]{1,120}$/);
const TextKeys = z.record(LocaleTagSchema, Key);
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;
export const JurisdictionApprovalSchema = z.enum(['pre_authorized', 'ask_each', 'human_only']);
export const JurisdictionActionLimitSchema = z.strictObject({
  action: MandateActionV2Schema,
  approval: JurisdictionApprovalSchema,
  /** Above this amount a person must approve. Null is explicit, never inferred from a missing fact. */
  approvalAbove: NonNegativeMoneySchema.nullable(),
});
export const JurisdictionRecordRuleSchema = z.strictObject({
  recordClass: Key,
  /** Exact days only. Calendar years must not be silently converted into days. */
  minimumDays: z.int().min(0).max(365250).nullable(),
  maximumDays: z.int().min(0).max(365250).nullable(),
}).refine((r) => r.minimumDays === null || r.maximumDays === null || r.minimumDays <= r.maximumDays, 'empty retention interval');
export const JurisdictionPolicySchema = z.strictObject({
  disclosureTextKeys: TextKeys,
  /** Opaque, sourced allocation identity. Different allocations have no implicit protective ordering. */
  liabilityAllocationKey: Key,
  consentRequirements: z.array(Key).max(100).refine(unique, 'duplicate consent'),
  recordKeeping: z.array(JurisdictionRecordRuleSchema).max(100).refine((v) => unique(v.map((r) => r.recordClass)), 'duplicate record class'),
  actionLimits: z.array(JurisdictionActionLimitSchema).min(1).max(MandateActionV2Schema.options.length).refine((v) => unique(v.map((r) => r.action)), 'duplicate action'),
  legalTextKeys: z.record(LocaleTagSchema, z.array(Key).min(1).max(100).refine(unique, 'duplicate legal text')),
});
export type JurisdictionPolicy = z.infer<typeof JurisdictionPolicySchema>;
export type JurisdictionActionLimit = z.infer<typeof JurisdictionActionLimitSchema>;
export const JurisdictionSettingsSchema = z.strictObject({
  jurisdiction: JurisdictionCodeSchema,
  policy: JurisdictionPolicySchema,
  packDefaults: z.array(z.strictObject({ area: JurisdictionSettingAreaSchema, fact: PackFactRefSchema })).min(1).max(200),
});
export type JurisdictionSettings = z.infer<typeof JurisdictionSettingsSchema>;
export const JurisdictionAgentSettingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jurisdictions: z.array(JurisdictionSettingsSchema).min(1).max(100).refine((v) => unique(v.map((s) => s.jurisdiction)), 'duplicate jurisdiction'),
});
export type JurisdictionAgentSettings = z.infer<typeof JurisdictionAgentSettingsSchema>;

/** Only a trusted pack adapter may supply a baseline; this is not an HTTP input schema. */
export interface JurisdictionBaseline {
  jurisdiction: string;
  policy: JurisdictionPolicy;
  mandatoryAreas: readonly z.infer<typeof JurisdictionSettingAreaSchema>[];
  packDefaults: JurisdictionSettings['packDefaults'];
}
export type JurisdictionBaselineResult =
  | { status: 'known'; baseline: JurisdictionBaseline }
  | { status: 'unknown'; reasons: string[] };
const rank = { pre_authorized: 0, ask_each: 1, human_only: 2 } as const;
const sorted = (values: readonly string[]) => [...new Set(values)].sort();

/** No natural-language interpretation: changing a mandatory text or liability identity needs a new pack decision. */
export function jurisdictionOverrideProblems(settings: JurisdictionSettings, baseline: JurisdictionBaseline, locales: readonly string[]): string[] {
  const problems: string[] = [];
  const p = settings.policy;
  const b = baseline.policy;
  if (settings.jurisdiction !== baseline.jurisdiction) problems.push('baseline_jurisdiction_mismatch');
  for (const locale of locales) {
    if (!p.disclosureTextKeys[locale as keyof typeof p.disclosureTextKeys]) problems.push(`disclosure_locale_missing:${locale}`);
    if (!p.legalTextKeys[locale as keyof typeof p.legalTextKeys]?.length) problems.push(`legal_locale_missing:${locale}`);
  }
  for (const ref of baseline.packDefaults) {
    if (!settings.packDefaults.some((r) => r.area === ref.area && r.fact.packCode === ref.fact.packCode && r.fact.packVersion === ref.fact.packVersion && r.fact.factKey === ref.fact.factKey)) problems.push(`pack_default_missing:${ref.area}:${ref.fact.factKey}`);
  }
  for (const area of baseline.mandatoryAreas) {
    if (area === 'agent_disclosure') {
      for (const [locale, key] of Object.entries(b.disclosureTextKeys)) if (p.disclosureTextKeys[locale as keyof typeof p.disclosureTextKeys] !== key) problems.push(`mandatory_disclosure_changed:${locale}`);
    }
    if (area === 'liability_allocation' && p.liabilityAllocationKey !== b.liabilityAllocationKey) problems.push('liability_incomparable');
    if (area === 'consent' && b.consentRequirements.some((key) => !p.consentRequirements.includes(key))) problems.push('mandatory_consent_removed');
    if (area === 'legal_texts') for (const [locale, keys] of Object.entries(b.legalTextKeys)) {
      if (keys.some((key) => !p.legalTextKeys[locale as keyof typeof p.legalTextKeys]?.includes(key))) problems.push(`mandatory_legal_text_removed:${locale}`);
    }
    if (area === 'record_keeping') for (const rule of b.recordKeeping) {
      const actual = p.recordKeeping.find((r) => r.recordClass === rule.recordClass);
      if (!actual || (rule.minimumDays !== null && (actual.minimumDays === null || actual.minimumDays < rule.minimumDays)) || (rule.maximumDays !== null && (actual.maximumDays === null || actual.maximumDays > rule.maximumDays))) problems.push(`retention_weakened:${rule.recordClass}`);
    }
    if (area === 'action_limits') for (const rule of b.actionLimits) {
      const actual = p.actionLimits.find((r) => r.action === rule.action);
      if (!actual) { problems.push(`action_missing:${rule.action}`); continue; }
      if (rank[actual.approval] < rank[rule.approval]) problems.push(`approval_weakened:${rule.action}`);
      if (rule.approvalAbove !== null) {
        if (actual.approvalAbove === null) problems.push(`threshold_removed:${rule.action}`);
        else if (actual.approvalAbove.currency !== rule.approvalAbove.currency) problems.push(`threshold_currency_incomparable:${rule.action}`);
        else if (BigInt(actual.approvalAbove.minorUnits) > BigInt(rule.approvalAbove.minorUnits)) problems.push(`threshold_weakened:${rule.action}`);
      }
    }
  }
  return sorted(problems);
}

export interface JurisdictionResolution {
  status: 'resolved' | 'unknown';
  reasons: string[];
  jurisdictions: string[];
  /** Requirements accumulate; choosing one text must never discard another jurisdiction's disclosure. */
  disclosureTextKeys: Record<string, string[]>;
  liabilityAllocationKey: string | null;
  consentRequirements: string[];
  recordKeeping: JurisdictionPolicy['recordKeeping'];
  legalTextKeys: Record<string, string[]>;
  approval: JurisdictionActionLimit['approval'];
  /** Each currency retains its own minimum threshold. There is no FX source here. */
  approvalAbove: Money[];
}

/**
 * Resolves an authoritative list of applicable jurisdictions. The caller must include ancestors and both parties;
 * this function cannot infer the applicable law from a person's preferred country or a client-supplied string.
 */
export function resolveJurisdictionPolicies(input: {
  applicableJurisdictions: readonly string[];
  settings: readonly JurisdictionSettings[];
  baselines: ReadonlyMap<string, JurisdictionBaselineResult>;
  action: JurisdictionActionLimit['action'];
  hubLocales: readonly string[];
  isRestricted: (code: string) => boolean;
}): JurisdictionResolution {
  const result: JurisdictionResolution = { status: 'resolved', reasons: [], jurisdictions: sorted(input.applicableJurisdictions), disclosureTextKeys: {}, liabilityAllocationKey: null, consentRequirements: [], recordKeeping: [], legalTextKeys: {}, approval: 'pre_authorized', approvalAbove: [] };
  if (!result.jurisdictions.length || !input.hubLocales.length) result.reasons.push('applicability_unknown');
  const records = new Map<string, JurisdictionPolicy['recordKeeping'][number]>();
  const money = new Map<string, Money>();
  const liabilities = new Set<string>();
  for (const jurisdiction of result.jurisdictions) {
    const parsedCode = JurisdictionCodeSchema.safeParse(jurisdiction);
    if (!parsedCode.success || [jurisdiction.slice(0, 2), jurisdiction.split(':')[0]!, jurisdiction].some(input.isRestricted)) { result.reasons.push(`jurisdiction_refused:${jurisdiction}`); continue; }
    const matches = input.settings.filter((s) => s.jurisdiction === jurisdiction);
    const source = input.baselines.get(jurisdiction);
    if (matches.length !== 1 || !source || source.status === 'unknown') { result.reasons.push(`baseline_or_settings_unknown:${jurisdiction}`); continue; }
    const settings = JurisdictionSettingsSchema.safeParse(matches[0]);
    if (!settings.success) { result.reasons.push(`settings_invalid:${jurisdiction}`); continue; }
    const problems = jurisdictionOverrideProblems(settings.data, source.baseline, input.hubLocales);
    if (problems.length) { result.reasons.push(...problems.map((p) => `${jurisdiction}:${p}`)); continue; }
    const policy = settings.data.policy;
    liabilities.add(policy.liabilityAllocationKey);
    for (const [locale, key] of Object.entries(policy.disclosureTextKeys)) result.disclosureTextKeys[locale] = sorted([...(result.disclosureTextKeys[locale] ?? []), key]);
    for (const [locale, keys] of Object.entries(policy.legalTextKeys)) result.legalTextKeys[locale] = sorted([...(result.legalTextKeys[locale] ?? []), ...keys]);
    result.consentRequirements.push(...policy.consentRequirements);
    for (const rule of policy.recordKeeping) {
      const previous = records.get(rule.recordClass);
      const minimumDays = Math.max(previous?.minimumDays ?? 0, rule.minimumDays ?? 0);
      const maximumDays = Math.min(previous?.maximumDays ?? Infinity, rule.maximumDays ?? Infinity);
      if (minimumDays > maximumDays) result.reasons.push(`retention_conflict:${rule.recordClass}`);
      records.set(rule.recordClass, { recordClass: rule.recordClass, minimumDays: previous?.minimumDays == null && rule.minimumDays === null ? null : minimumDays, maximumDays: maximumDays === Infinity ? null : maximumDays });
    }
    const limit = policy.actionLimits.find((l) => l.action === input.action);
    if (!limit) { result.reasons.push(`action_unknown:${jurisdiction}`); continue; }
    if (rank[limit.approval] > rank[result.approval]) result.approval = limit.approval;
    if (limit.approvalAbove) {
      const prior = money.get(limit.approvalAbove.currency);
      if (!prior || BigInt(limit.approvalAbove.minorUnits) < BigInt(prior.minorUnits)) money.set(limit.approvalAbove.currency, { ...limit.approvalAbove });
    }
  }
  if (liabilities.size > 1) result.reasons.push('liability_incomparable');
  result.liabilityAllocationKey = liabilities.size === 1 ? [...liabilities][0]! : null;
  result.consentRequirements = sorted(result.consentRequirements);
  result.recordKeeping = [...records.values()].sort((a, b) => a.recordClass.localeCompare(b.recordClass, 'en'));
  result.approvalAbove = [...money.values()].sort((a, b) => a.currency.localeCompare(b.currency, 'en'));
  result.reasons = sorted(result.reasons);
  if (result.reasons.length) result.status = 'unknown';
  return result;
}

/** Restriction only: this result never substitutes for mandate, budget, consent or current-authority checks. */
export function evaluateJurisdictionAction(resolution: JurisdictionResolution, amount: Money | null): { effect: 'allow' | 'ask' | 'deny'; reasons: string[] } {
  if (resolution.status !== 'resolved') return { effect: 'deny', reasons: ['jurisdiction_unknown'] };
  if (amount !== null && !NonNegativeMoneySchema.safeParse(amount).success) return { effect: 'deny', reasons: ['amount_invalid'] };
  if (resolution.approvalAbove.length && (!amount || resolution.approvalAbove.some((m) => m.currency !== amount.currency))) return { effect: 'deny', reasons: [amount ? 'currency_comparison_unknown' : 'amount_unknown'] };
  if (resolution.approval !== 'pre_authorized') return { effect: 'ask', reasons: [resolution.approval === 'human_only' ? 'jurisdiction_human_only' : 'jurisdiction_approval_required'] };
  if (amount && resolution.approvalAbove.some((m) => BigInt(amount.minorUnits) > BigInt(m.minorUnits))) return { effect: 'ask', reasons: ['jurisdiction_limit_exceeded'] };
  return { effect: 'allow', reasons: [] };
}

