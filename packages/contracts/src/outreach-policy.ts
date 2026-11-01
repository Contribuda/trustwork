import { z } from 'zod';

/**
 * Outreach and collection policy (OUTR-001, ADR 017, docs/engine/discovery-and-outreach.md#the-policy). Outreach to
 * people and companies who are not participants is governed by two layers of data and never by engine code that
 * branches on a country: sourced `outreachLaw` country-pack facts, and the hub configuration domain `outreach` (the
 * operator's choices within those facts). The default mode is `strict`: nobody is contacted. The engine floor below
 * holds whatever a pack, a hub, a grant or an extension says.
 */

export const OUTREACH_MODES = ['strict', 'notice_only', 'governed'] as const;
export const OutreachModeSchema = z.enum(OUTREACH_MODES);
export type OutreachMode = z.infer<typeof OutreachModeSchema>;

export const RECIPIENT_CLASSES = ['organisation_generic', 'business_role', 'business_named_contact', 'sole_proprietor', 'public_official', 'consumer'] as const;
export const RecipientClassSchema = z.enum(RECIPIENT_CLASSES);
export type RecipientClass = z.infer<typeof RecipientClassSchema>;

export const OUTREACH_CHANNELS = ['email', 'postal', 'phone_manual', 'phone_automated', 'sms_messenger', 'contact_form', 'social_message'] as const;
export const OutreachChannelSchema = z.enum(OUTREACH_CHANNELS);
export type OutreachChannel = z.infer<typeof OutreachChannelSchema>;

/**
 * Legal bases, ordered from the most protective (index 0) to the least. Where two rules apply to one message the more
 * protective basis wins; `prohibited` always wins.
 */
export const OUTREACH_BASES = [
  'prohibited', 'prior_express_written_consent', 'prior_consent', 'single_consent_request', 'soft_opt_in', 'existing_relationship',
  'legitimate_interest_assessed', 'implied_consent_conspicuous_publication', 'opt_out',
] as const;
export const OutreachBasisSchema = z.enum(OUTREACH_BASES);
export type OutreachBasis = z.infer<typeof OutreachBasisSchema>;

export const NOTICE_TIMINGS = ['before_publication', 'at_first_communication', 'within_days', 'privacy_notice_only'] as const;
export const NoticeTimingSchema = z.enum(NOTICE_TIMINGS);

export const IDENTIFICATION_ITEMS = ['operator_legal_name', 'postal_address', 'hub_name', 'automated_assistant_disclosure', 'data_source_named'] as const;
export const IdentificationItemSchema = z.enum(IDENTIFICATION_ITEMS);

/** Bases that rest on that person's recorded consent: the only ones the engine floor accepts for automated channels. */
export const CONSENT_BASES: readonly OutreachBasis[] = ['prior_express_written_consent', 'prior_consent'];

/**
 * The engine floor (ADR 017 decision 4). These are constants, not settings: the schema below refuses any policy that
 * would express something weaker, and the resolver applies them again to every message.
 */
export const OUTREACH_ENGINE_FLOOR = {
  /** No consumer outreach and no outreach about private individuals. */
  prohibitedClasses: ['consumer'] as readonly RecipientClass[],
  /** Never automated: website and platform terms forbid it. */
  prohibitedChannels: ['contact_form', 'social_message'] as readonly OutreachChannel[],
  /** Automated or prerecorded calls, AI voice, SMS and messenger outreach need that person's recorded prior consent. */
  consentOnlyChannels: ['phone_automated', 'sms_messenger'] as readonly OutreachChannel[],
  requiredIdentification: IDENTIFICATION_ITEMS as readonly (typeof IDENTIFICATION_ITEMS)[number][],
  maxTouchesPerRecipientPerPurpose: 3,
  optOut: { oneClick: true, replyStop: true },
  openTracking: false,
} as const;

/**
 * Human gates this package proposes as additive entries to `HUMAN_GATES` in the frozen hub console contract
 * (`packages/contracts/src/hub.ts`); the integrator adds them there, together with the console that uses them.
 */
export const PROPOSED_OUTREACH_HUMAN_GATES = ['outreach_policy_activation', 'outreach_campaign_activation'] as const;

const Rule = z.strictObject({
  basis: OutreachBasisSchema,
  /** Required for `legitimate_interest_assessed`: the reference of the written assessment. */
  assessmentRef: z.string().min(1).max(120).optional(),
  honourOptOutWithinDays: z.int().min(0).max(30).optional(),
});
export type OutreachRule = z.infer<typeof Rule>;

const ChannelRules = z.strictObject(Object.fromEntries(OUTREACH_CHANNELS.map((c) => [c, Rule.optional()])) as Record<OutreachChannel, z.ZodOptional<typeof Rule>>);
export type OutreachChannelRules = z.infer<typeof ChannelRules>;

const Scope = z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/, 'ISO 3166-1 or 3166-2 code');

export const OutreachJurisdictionPolicySchema = z.strictObject({
  scope: Scope,
  recipientClasses: z.strictObject(Object.fromEntries(RECIPIENT_CLASSES.map((r) => [r, ChannelRules.optional()])) as Record<RecipientClass, z.ZodOptional<typeof ChannelRules>>),
  notice: z.strictObject({ required: z.boolean(), timing: NoticeTimingSchema, maxDays: z.int().min(0).max(90).optional() }),
  identification: z.array(IdentificationItemSchema).min(1),
  optOut: z.strictObject({ oneClick: z.boolean(), replyStop: z.boolean(), honourWithinHours: z.int().min(0).max(24 * 30) }),
  volume: z.strictObject({
    perHubPerDay: z.int().min(0).max(100_000),
    perRecipientDomainPerWeek: z.int().min(0).max(100),
    touchesPerRecipientPerPurpose: z.int().min(0),
    minDaysBetweenTouches: z.int().min(0).max(365),
  }),
  quietHours: z.strictObject({ timeZone: z.literal('recipient'), allowed: z.string().min(1).max(120), holidays: z.literal('pack_calendar') }),
  openTracking: z.boolean().default(false),
});
export type OutreachJurisdictionPolicy = z.infer<typeof OutreachJurisdictionPolicySchema>;

/** Every way a jurisdiction policy would lower the engine floor; empty when it does not. */
export function floorViolations(policy: OutreachJurisdictionPolicy): string[] {
  const problems: string[] = [];
  for (const recipient of RECIPIENT_CLASSES) {
    const rules = policy.recipientClasses[recipient];
    if (!rules) continue;
    for (const channel of OUTREACH_CHANNELS) {
      const rule = rules[channel];
      if (!rule || rule.basis === 'prohibited') continue;
      const at = `${policy.scope}.${recipient}.${channel}`;
      if (OUTREACH_ENGINE_FLOOR.prohibitedClasses.includes(recipient)) problems.push(`${at}: consumer outreach is never allowed`);
      if (OUTREACH_ENGINE_FLOOR.prohibitedChannels.includes(channel)) problems.push(`${at}: this channel is never automated`);
      if (OUTREACH_ENGINE_FLOOR.consentOnlyChannels.includes(channel) && !CONSENT_BASES.includes(rule.basis)) problems.push(`${at}: needs the person's recorded prior consent`);
      if (rule.basis === 'legitimate_interest_assessed' && !rule.assessmentRef) problems.push(`${at}: a legitimate interest needs its assessment reference`);
    }
  }
  for (const item of OUTREACH_ENGINE_FLOOR.requiredIdentification) if (!policy.identification.includes(item)) problems.push(`${policy.scope}: identification must include ${item}`);
  if (!policy.optOut.oneClick || !policy.optOut.replyStop) problems.push(`${policy.scope}: one-click unsubscribe and "stop" replies are required`);
  if (policy.volume.touchesPerRecipientPerPurpose > OUTREACH_ENGINE_FLOOR.maxTouchesPerRecipientPerPurpose) problems.push(`${policy.scope}: at most ${OUTREACH_ENGINE_FLOOR.maxTouchesPerRecipientPerPurpose} touches per recipient per purpose`);
  if (policy.openTracking) problems.push(`${policy.scope}: open tracking is never allowed`);
  return problems;
}

/**
 * The hub configuration domain `outreach`. A mode other than `strict` needs a counsel approval record and a second
 * person (proposed gate `outreach_policy_activation`); no version may lower the engine floor.
 */
export const OutreachPolicySchema = z.strictObject({
  mode: OutreachModeSchema,
  /** The outreachLaw facts this version relies on, as `<pack code>@<version>` (lower-case code). */
  packs: z.array(z.string().regex(/^[a-z]{2}(?:-[a-z0-9]{1,3})?@[0-9A-Za-z.-]{1,40}$/)).max(64).default([]),
  counselApproval: z.strictObject({ reference: z.string().min(1).max(120), jurisdictions: z.array(Scope).min(1), approvedAt: z.iso.datetime() }).nullable(),
  secondPersonApprovalId: z.uuid().nullable(),
  jurisdictions: z.array(OutreachJurisdictionPolicySchema).max(64),
}).superRefine((policy, ctx) => {
  if (policy.mode === 'strict') {
    if (policy.jurisdictions.length > 0) ctx.addIssue({ code: 'custom', message: 'strict mode contacts nobody: it carries no jurisdiction rules' });
    return;
  }
  if (!policy.counselApproval) ctx.addIssue({ code: 'custom', message: `mode ${policy.mode} needs a counsel approval record` });
  if (!policy.secondPersonApprovalId) ctx.addIssue({ code: 'custom', message: `mode ${policy.mode} needs a second person's approval` });
  if (policy.packs.length === 0) ctx.addIssue({ code: 'custom', message: `mode ${policy.mode} must name the outreachLaw facts it relies on` });
  const scopes = policy.jurisdictions.map((j) => j.scope);
  if (new Set(scopes).size !== scopes.length) ctx.addIssue({ code: 'custom', message: 'one rule set per jurisdiction' });
  for (const scope of scopes) if (policy.counselApproval && !policy.counselApproval.jurisdictions.includes(scope)) ctx.addIssue({ code: 'custom', message: `${scope} is not covered by the counsel approval` });
  for (const jurisdiction of policy.jurisdictions) for (const message of floorViolations(jurisdiction)) ctx.addIssue({ code: 'custom', message });
});
export type OutreachPolicy = z.infer<typeof OutreachPolicySchema>;

/** The configuration of a hub that never chose anything: strict, nobody contacted. */
export const DEFAULT_OUTREACH_POLICY: OutreachPolicy = { mode: 'strict', packs: [], counselApproval: null, secondPersonApprovalId: null, jurisdictions: [] };

/** One jurisdiction's pack rule for a recipient class and channel, derived from sourced outreachLaw facts. */
export interface OutreachPackRule { scope: string; recipientClass: RecipientClass; channel: OutreachChannel; basis: OutreachBasis; factIds: readonly string[] }

export interface OutreachRequest {
  recipientClass: RecipientClass | null;
  channel: OutreachChannel;
  /** The recipient's jurisdiction (ISO 3166-1 or 3166-2), or null when unknown. */
  recipientJurisdiction: string | null;
  hubJurisdiction: string;
  policy: OutreachPolicy | null;
  /** Pack rules for every applicable scope (country and subdivision of the recipient and of the hub). */
  packRules: readonly OutreachPackRule[];
  /** What the source of the contact data allows; outreach must be listed. */
  sourceAllowsOutreach: boolean;
  suppressed: boolean;
  /** Whether the recipient's recorded consent exists for this channel and purpose. */
  recordedConsent: boolean;
}

export type OutreachDecision =
  | { contact: false; reason: 'strict_mode' | 'unknown_jurisdiction' | 'unknown_recipient_class' | 'engine_floor' | 'no_rule' | 'prohibited' | 'consent_missing' | 'source_disallows' | 'suppressed' }
  | { contact: true; basis: OutreachBasis; rule: OutreachJurisdictionPolicy; packFacts: readonly string[] };

const protection = (basis: OutreachBasis) => OUTREACH_BASES.indexOf(basis);
/** The more protective of two bases (lower index in OUTREACH_BASES). */
export function moreProtective(a: OutreachBasis, b: OutreachBasis): OutreachBasis {
  return protection(a) <= protection(b) ? a : b;
}

/** Whether a scope applies to a jurisdiction: the country itself, or the subdivision exactly. */
const applies = (scope: string, jurisdiction: string) => scope === jurisdiction || scope === jurisdiction.slice(0, 2);

/**
 * The effective rule for one message: the intersection of the engine floor, the pack rules of the recipient's and the
 * hub's jurisdictions, the hub policy, the source's allowed uses and the recipient's suppression. The most protective
 * basis wins; an unknown recipient jurisdiction or class, or any missing rule, means no contact.
 */
export function resolveOutreach(request: OutreachRequest): OutreachDecision {
  const policy = request.policy ?? DEFAULT_OUTREACH_POLICY;
  if (policy.mode === 'strict') return { contact: false, reason: 'strict_mode' };
  if (!request.recipientJurisdiction) return { contact: false, reason: 'unknown_jurisdiction' };
  if (!request.recipientClass) return { contact: false, reason: 'unknown_recipient_class' };
  const { recipientClass, channel, recipientJurisdiction, hubJurisdiction } = request;
  if (OUTREACH_ENGINE_FLOOR.prohibitedClasses.includes(recipientClass) || OUTREACH_ENGINE_FLOOR.prohibitedChannels.includes(channel)) return { contact: false, reason: 'engine_floor' };
  if (request.suppressed) return { contact: false, reason: 'suppressed' };
  if (!request.sourceAllowsOutreach) return { contact: false, reason: 'source_disallows' };
  // The hub's rule for the recipient's jurisdiction: the most specific scope it declares.
  const hubRules = policy.jurisdictions.filter((j) => applies(j.scope, recipientJurisdiction)).sort((a, b) => b.scope.length - a.scope.length);
  const rule = hubRules[0];
  const hubBasis = rule?.recipientClasses[recipientClass]?.[channel]?.basis;
  if (!rule || !hubBasis) return { contact: false, reason: 'no_rule' };
  // Pack rules: both the recipient's and the hub's jurisdictions must say something for this class and channel.
  const forJurisdiction = (j: string) => request.packRules.filter((r) => applies(r.scope, j) && r.recipientClass === recipientClass && r.channel === channel);
  const recipientPack = forJurisdiction(recipientJurisdiction);
  const hubPack = forJurisdiction(hubJurisdiction);
  if (recipientPack.length === 0 || hubPack.length === 0) return { contact: false, reason: 'no_rule' };
  const applicable = [...recipientPack, ...hubPack];
  const basis = applicable.reduce<OutreachBasis>((acc, r) => moreProtective(acc, r.basis), hubBasis);
  if (basis === 'prohibited') return { contact: false, reason: 'prohibited' };
  const consentNeeded = CONSENT_BASES.includes(basis) || OUTREACH_ENGINE_FLOOR.consentOnlyChannels.includes(channel);
  if (consentNeeded && !request.recordedConsent) return { contact: false, reason: 'consent_missing' };
  return { contact: true, basis, rule, packFacts: [...new Set(applicable.flatMap((r) => r.factIds))] };
}
