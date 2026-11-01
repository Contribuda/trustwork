import { z } from 'zod';
import { floorViolations, OUTREACH_CHANNELS, OUTREACH_ENGINE_FLOOR, OutreachJurisdictionPolicySchema, OutreachModeSchema, RECIPIENT_CLASSES } from './policy.js';

/**
 * The outreach section's view of one hub (OUTR-004, HC-170 to HC-177; docs/engine/discovery-and-outreach.md). Synthetic
 * fixtures only. The policy rules are the OUTR-001 contract (`outreach-policy.ts`), so a fixture that would lower the
 * engine floor, address consumers or use a channel the floor forbids does not parse. Counts are cohorts (null when
 * fewer than ten); there is no per-person row, and a suppression entry is found only by exact lookup.
 */
const Cohort = z.int().min(10).nullable();
const Text = z.strictObject({ text: z.string().min(1).max(2000), lang: z.string().min(2).max(35) });
const Scope = z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/);
const At = z.iso.datetime();

export const GATE_IDS = ['engine_floor', 'policy_mode', 'pack_rule', 'hub_rule', 'source_use', 'suppression', 'screening', 'touch_cap', 'quiet_hours', 'sender_checks'] as const;
export const GateSchema = z.strictObject({
  id: z.enum(GATE_IDS),
  state: z.enum(['pass', 'fail', 'wait']),
  /** How many recipients stopped at this gate in the last dry run (a cohort). */
  stopped: Cohort,
});
export type Gate = z.infer<typeof GateSchema>;

export const PolicyVersionSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]{3,60}$/),
    version: z.int().min(1),
    mode: OutreachModeSchema,
    state: z.enum(['active', 'draft', 'superseded']),
    /** The outreachLaw facts this version relies on, as `<pack code>@<schema version>`. */
    packs: z.array(z.string().regex(/^[a-z]{2}(?:-[a-z0-9]{1,3})?@[0-9A-Za-z.-]{1,40}$/)),
    counselApproval: z.strictObject({ reference: z.string().min(1).max(120), jurisdictions: z.array(Scope).min(1), approvedAt: At }).nullable(),
    secondPersonApprovalId: z.string().min(1).nullable(),
    jurisdictions: z.array(OutreachJurisdictionPolicySchema),
    draftedAt: At,
    reason: Text,
  })
  .refine((v) => v.jurisdictions.every((j) => floorViolations(j).length === 0), { message: 'a policy version never lowers the engine floor', path: ['jurisdictions'] })
  .refine((v) => v.mode !== 'strict' || v.jurisdictions.length === 0, { message: 'strict mode carries no jurisdiction rules', path: ['jurisdictions'] })
  .refine((v) => v.state !== 'active' || v.mode === 'strict' || (v.counselApproval !== null && v.secondPersonApprovalId !== null), {
    message: 'only strict activates without a counsel record and a second person',
    path: ['mode'],
  });
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

export const MESSAGE_BLOCKS = ['body', 'identification', 'automated_disclosure', 'data_source', 'page_link', 'unsubscribe'] as const;
/** The blocks the engine writes into every outreach message; staff edit only the body. */
export const LOCKED_BLOCKS = ['identification', 'automated_disclosure', 'data_source', 'unsubscribe'] as const;
export const MessagePreviewSchema = z
  .strictObject({
    lang: z.string().min(2).max(35),
    jurisdiction: Scope,
    subject: z.string().min(1).max(200),
    blocks: z.array(z.strictObject({ kind: z.enum(MESSAGE_BLOCKS), locked: z.boolean(), text: z.string().min(1).max(1200) })).min(1),
  })
  .refine((m) => LOCKED_BLOCKS.every((k) => m.blocks.some((b) => b.kind === k && b.locked)) && m.blocks.every((b) => b.locked === (b.kind !== 'body')), {
    message: 'every message carries the locked identification, disclosure, data source and unsubscribe blocks; only the body is editable',
    path: ['blocks'],
  });
export type MessagePreview = z.infer<typeof MessagePreviewSchema>;

export const PURPOSES = ['claim_invitation', 'correction_request', 'rfq_invitation_notice', 'event_announcement_to_organisations'] as const;
/** Recipient classes and channels a campaign can name: never consumers, never a channel the engine floor forbids or reserves for recorded consent. */
export const CAMPAIGN_CLASSES = RECIPIENT_CLASSES.filter((c) => !OUTREACH_ENGINE_FLOOR.prohibitedClasses.includes(c));
export const CAMPAIGN_CHANNELS = OUTREACH_CHANNELS.filter((c) => !OUTREACH_ENGINE_FLOOR.prohibitedChannels.includes(c) && !OUTREACH_ENGINE_FLOOR.consentOnlyChannels.includes(c));

export const CampaignSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]{3,60}$/),
    name: Text,
    purpose: z.enum(PURPOSES),
    recipientClass: z.enum(CAMPAIGN_CLASSES as [string, ...string[]]),
    channel: z.enum(CAMPAIGN_CHANNELS as [string, ...string[]]),
    jurisdiction: Scope,
    state: z.enum(['draft', 'dry_run_done', 'awaiting_activation', 'running', 'paused', 'stopped']),
    /** Whether the first version was activated by a person; the first version always needs one. */
    activatedBefore: z.boolean(),
    audience: Cohort,
    gates: z.array(GateSchema).min(1),
    sequence: z.array(z.strictObject({ step: z.int().min(1).max(OUTREACH_ENGINE_FLOOR.maxTouchesPerRecipientPerPurpose), afterDays: z.int().min(0).max(90) })).min(1).max(OUTREACH_ENGINE_FLOOR.maxTouchesPerRecipientPerPurpose),
    dailyCap: z.int().min(0).max(100_000),
    autonomy: z.enum(['manual', 'assisted']),
    previews: z.array(MessagePreviewSchema).min(1),
    lastDryRun: At.nullable(),
  })
  .refine((c) => c.previews.every((p) => p.jurisdiction === c.jurisdiction), { message: 'previews are rendered for the campaign jurisdiction', path: ['previews'] });
export type Campaign = z.infer<typeof CampaignSchema>;

export const TemplateSchema = z.strictObject({
  key: z.string().regex(/^[a-z_]{3,60}$/),
  purpose: z.enum(PURPOSES),
  version: z.int().min(1),
  state: z.enum(['draft', 'active', 'paused']),
  locales: z.array(z.string().min(2)).min(1),
  /** Hub languages without this template; any one blocks activation (COMMS-001 rule). */
  missingLocales: z.array(z.string().min(2)),
  preview: MessagePreviewSchema,
});
export type Template = z.infer<typeof TemplateSchema>;

export const REPLY_CLASSES = ['objection', 'question', 'wrong_recipient', 'automatic_reply', 'claim_request'] as const;
export const ReplySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  class: z.enum(REPLY_CLASSES),
  /** Untrusted text from outside: rendered as text, never acted on. */
  text: Text,
  receivedAt: At,
  handled: z.enum(['objection_applied', 'waiting', 'answered', 'rescheduled', 'pointed_to_claim_form']),
  campaignId: z.string().min(1),
});
export type Reply = z.infer<typeof ReplySchema>;

export const SUPPRESSION_REASONS = ['objection', 'unsubscribe', 'complaint', 'hard_bounce', 'wrong_recipient', 'registry'] as const;
export const SUPPRESSION_SCOPES = ['hub', 'entity', 'purpose'] as const;
export const SuppressionEntrySchema = z.strictObject({ identifier: z.string().min(3).max(320), reason: z.enum(SUPPRESSION_REASONS), scope: z.enum(SUPPRESSION_SCOPES), since: At });
export type SuppressionEntry = z.infer<typeof SuppressionEntrySchema>;

const Check = z.enum(['pass', 'fail', 'pending']);
export const OutreachViewSchema = z
  .strictObject({
    killSwitch: z.enum(['released', 'engaged']),
    policyVersions: z.array(PolicyVersionSchema).min(1),
    campaigns: z.array(CampaignSchema),
    templates: z.array(TemplateSchema),
    /** Replies come from a staff rehearsal with synthetic inboxes: no real recipient was contacted. */
    rehearsal: z.boolean(),
    replies: z.array(ReplySchema),
    suppressionCounts: z.array(z.strictObject({ reason: z.enum(SUPPRESSION_REASONS), scope: z.enum(SUPPRESSION_SCOPES), count: Cohort })),
    doNotCollect: Cohort,
    /** The fixture ledger behind the exact lookup; never rendered as a list. */
    suppressionLedger: z.array(SuppressionEntrySchema),
    registryPolls: z.array(z.strictObject({ registry: Text, jurisdiction: Scope, lastPolledAt: At.nullable(), cadenceDays: z.int().min(1).max(365) })),
    sender: z.strictObject({ domain: z.string().regex(/\.(?:example|invalid)$/), spf: Check, dkim: Check, dmarc: Check, rampStage: z.enum(['not_started', 'warming', 'steady']), dailyCap: z.int().min(0), checkedAt: At.nullable() }),
    rates: z.strictObject({ sent: Cohort, bouncePercent: z.string().nullable(), complaintPercent: z.string().nullable() }),
    autoPauses: z.array(z.strictObject({ campaignId: z.string().min(1), rule: z.enum(['bounce_rate', 'complaint_rate']), at: At })),
    journeys: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9-]{3,60}$/), name: Text, audience: z.enum(['participants', 'partners']), steps: z.int().min(1).max(10), capPerMonth: z.int().min(0).max(8), version: z.int().min(1), enrolled: Cohort, state: z.enum(['draft', 'active', 'paused']) })),
  })
  .refine((v) => v.policyVersions.filter((p) => p.state === 'active').length === 1, { message: 'exactly one active policy version', path: ['policyVersions'] })
  .refine((v) => !v.policyVersions.some((p) => p.state === 'active' && p.mode === 'strict') || v.campaigns.every((c) => c.state !== 'running'), {
    message: 'nothing runs under the strict rule',
    path: ['campaigns'],
  })
  .refine((v) => v.replies.length === 0 || v.rehearsal || v.campaigns.some((c) => c.activatedBefore), { message: 'replies need a campaign that was sent, or a labelled rehearsal', path: ['replies'] });
export type OutreachView = z.infer<typeof OutreachViewSchema>;

/** Bounce and complaint thresholds of the engine (docs/engine/discovery-and-outreach.md, "Deliverability"). */
export const THRESHOLDS = { complaintWarnPercent: '0.1', complaintPausePercent: '0.3', hardBouncePausePercent: '2' } as const;

export function activePolicy(view: OutreachView): PolicyVersion {
  return view.policyVersions.find((p) => p.state === 'active')!;
}
