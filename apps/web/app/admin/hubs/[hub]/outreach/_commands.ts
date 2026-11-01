import type { ConsolePermission } from '@trustwork/contracts/client';
import { guard, NOT_FOUND, oneOf, type SectionCommandContext, type SectionCommandInput, type SectionOutcome } from '../participants/_section-command.js';
import { outreachOf } from './_kit/fixtures.js';
import { activePolicy, CAMPAIGN_CHANNELS, CAMPAIGN_CLASSES, PURPOSES, REPLY_CLASSES, SUPPRESSION_REASONS, SUPPRESSION_SCOPES } from './_kit/schemas.js';

/**
 * Outreach commands (HC-170 to HC-177, OUTR-004; docs/engine/discovery-and-outreach.md, ADR 017). Pure: no clock, no
 * I/O. In demo mode nothing is stored; OUTR-002 wires the same commands to the outreach module, which repeats every
 * check as the authority. What is deliberately missing: no command sets the outreach mode directly, lowers the engine
 * floor, addresses consumers or uses an automated, consent-only or forbidden channel, lists suppressed identifiers or
 * acts on reply text. A mode other than strict activates only through a version with a counsel approval record and a
 * second person; a campaign cannot activate under the strict rule or while the sender checks fail, and its first
 * version always needs a person.
 *
 * The console vocabulary has no outreach permissions yet; until the integrator adds them with the proposed human gates
 * (`PROPOSED_OUTREACH_HUMAN_GATES`), the screens use the nearest existing permissions below.
 */

export const OUTREACH_COMMANDS: Readonly<Record<string, readonly ConsolePermission[]>> = {
  'outreach.kill_switch_engage': ['admin.pipelines.pause'],
  'outreach.policy_draft': ['admin.hub.jurisdiction.edit'],
  'outreach.policy_request_activation': ['admin.hub.jurisdiction.activate'],
  'outreach.campaign_draft': ['admin.notifications.template.edit'],
  'outreach.campaign_dry_run': ['admin.notifications.template.edit'],
  'outreach.campaign_request_activation': ['admin.notifications.broadcast'],
  'outreach.campaign_pause': ['admin.notifications.broadcast', 'admin.pipelines.pause'],
  'outreach.campaign_stop': ['admin.notifications.broadcast', 'admin.pipelines.pause'],
  'outreach.campaign_resume': ['admin.notifications.broadcast'],
  'outreach.template_edit': ['admin.notifications.template.edit'],
  'outreach.template_request_activation': ['admin.notifications.template.edit'],
  'outreach.reply_reclassify': ['admin.notifications.template.edit'],
  'outreach.reply_wrong_recipient': ['admin.notifications.template.edit'],
  'outreach.suppression_add': ['admin.privacy.request.read'],
  'outreach.registry_batch_record': ['admin.privacy.request.read'],
  'outreach.dns_recheck': ['admin.notifications.template.edit'],
  'outreach.journey_edit': ['admin.notifications.template.edit'],
  'outreach.journey_activate': ['admin.notifications.broadcast'],
  'outreach.journey_pause': ['admin.notifications.broadcast'],
};

export const OUTREACH_REJECT_CODES = ['strict_mode', 'counsel_required', 'sender_checks', 'locale_missing', 'not_paused', 'already_engaged', 'invalid'] as const;
export type OutreachRejectCode = (typeof OUTREACH_REJECT_CODES)[number];
export const OUTREACH_KINDS = ['saved', 'version', 'second_person', 'dry_run', 'paused', 'stopped', 'resumed', 'engaged', 'suppressed', 'checked'] as const;
export type OutreachKind = (typeof OUTREACH_KINDS)[number];

export type OutreachOutcome = SectionOutcome | { status: 'demo_not_saved'; kind: OutreachKind; outreach: true } | { status: 'rejected'; code: OutreachRejectCode; field: string | null; outreach: true };

const ok = (kind: OutreachKind): OutreachOutcome => ({ status: 'demo_not_saved', kind, outreach: true });
const no = (code: OutreachRejectCode, field: string | null = null): OutreachOutcome => ({ status: 'rejected', code, field, outreach: true });

export function evaluateOutreach(input: SectionCommandInput, ctx: SectionCommandContext): OutreachOutcome {
  const permissions = OUTREACH_COMMANDS[input.command];
  if (!permissions) return no('invalid');
  const blocked = guard(input, ctx, permissions);
  if (blocked) return blocked;
  const view = outreachOf(ctx.hub!.hub.id);
  if (!view) return NOT_FOUND;
  const f = input.fields;
  const strict = activePolicy(view).mode === 'strict';
  const campaign = () => view.campaigns.find((c) => c.id === f.campaign) ?? null;
  switch (input.command) {
    case 'outreach.kill_switch_engage':
      return view.killSwitch === 'engaged' ? no('already_engaged') : ok('engaged');
    case 'outreach.policy_draft':
      return ok('version');
    case 'outreach.policy_request_activation': {
      const version = view.policyVersions.find((p) => p.id === f.version && p.state === 'draft');
      if (!version) return NOT_FOUND;
      if (version.mode !== 'strict' && !version.counselApproval) return no('counsel_required', 'version');
      return ok('second_person');
    }
    case 'outreach.campaign_draft':
      if (!oneOf(f.purpose, PURPOSES)) return no('invalid', 'purpose');
      if (!oneOf(f.recipientClass, CAMPAIGN_CLASSES)) return no('invalid', 'recipientClass');
      if (!oneOf(f.channel, CAMPAIGN_CHANNELS)) return no('invalid', 'channel');
      return ok('version');
    case 'outreach.campaign_dry_run':
      return campaign() ? ok('dry_run') : NOT_FOUND;
    case 'outreach.campaign_request_activation': {
      if (!campaign()) return NOT_FOUND;
      if (strict) return no('strict_mode');
      const s = view.sender;
      if (s.spf !== 'pass' || s.dkim !== 'pass' || s.dmarc !== 'pass') return no('sender_checks');
      return ok('second_person');
    }
    case 'outreach.campaign_pause':
      return campaign() ? ok('paused') : NOT_FOUND;
    case 'outreach.campaign_stop':
      return campaign() ? ok('stopped') : NOT_FOUND;
    case 'outreach.campaign_resume': {
      const found = campaign();
      if (!found) return NOT_FOUND;
      return found.state === 'paused' ? ok('resumed') : no('not_paused');
    }
    case 'outreach.template_edit':
    case 'outreach.template_request_activation': {
      const template = view.templates.find((x) => x.key === f.template);
      if (!template) return NOT_FOUND;
      if (input.command === 'outreach.template_edit') return ok('version');
      return template.missingLocales.length ? no('locale_missing', 'template') : ok('second_person');
    }
    case 'outreach.reply_reclassify':
      if (!view.replies.some((r) => r.id === f.reply)) return NOT_FOUND;
      return oneOf(f.class, REPLY_CLASSES) ? ok('saved') : no('invalid', 'class');
    case 'outreach.reply_wrong_recipient':
      return view.replies.some((r) => r.id === f.reply) ? ok('suppressed') : NOT_FOUND;
    case 'outreach.suppression_add': {
      const identifier = (f.identifier ?? '').trim();
      if (identifier.length < 3 || identifier.length > 320) return no('invalid', 'identifier');
      if (!oneOf(f.reason, SUPPRESSION_REASONS) || !oneOf(f.scope, SUPPRESSION_SCOPES)) return no('invalid', 'reason');
      return ok('suppressed');
    }
    case 'outreach.registry_batch_record':
      return view.registryPolls.length ? ok('saved') : NOT_FOUND;
    case 'outreach.dns_recheck':
      return ok('checked');
    case 'outreach.journey_edit':
    case 'outreach.journey_activate':
    case 'outreach.journey_pause': {
      const journey = view.journeys.find((j) => j.id === f.journey);
      if (!journey) return NOT_FOUND;
      if (input.command === 'outreach.journey_edit') return ok('version');
      return input.command === 'outreach.journey_pause' ? ok('paused') : ok('second_person');
    }
    default:
      return no('invalid');
  }
}
