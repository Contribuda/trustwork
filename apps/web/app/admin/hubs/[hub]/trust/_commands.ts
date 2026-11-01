import { HOLD_CLEAR_EVIDENCE, type ConsolePermission } from '@trustwork/contracts/client';
import { holdsAny } from '../../../_data/commands.js';
import { accepted, guard, NOT_FOUND, oneOf, reject, type SectionCommandContext, type SectionCommandInput, type SectionOutcome } from '../participants/_section-command.js';
import { APPEAL_DECISIONS, DISPUTE_DECISIONS, METHOD_PARAMETERS, PACK_LIST_FACTS, trustOf, type MethodParameter } from './_fixtures.js';
import { EVIDENCE_CATEGORIES } from '../participants/_fixtures.js';

/**
 * Trust and safety commands (HC-70 to HC-75, HUBC-004). Guard rails that no command removes: no control sets a score,
 * a rank, a position, "featured" or a badge (reputation changes only through released method versions whose local
 * parameters stay inside engine bounds; anything else is refused); sanction level 4 needs a second person; appeals are
 * decided by someone other than the original decider; screening never loosens matching, never pauses a baseline list
 * and never clears a hold without a reason and an evidence category; agents may request confirmations but never
 * confirm.
 */

export const TRUST_COMMANDS: Readonly<Record<string, readonly ConsolePermission[]>> = {
  'moderation.open_case': ['admin.moderation.case.open'],
  'moderation.decide': ['admin.moderation.decide'],
  'moderation.emergency': ['admin.moderation.emergency.hold', 'admin.moderation.emergency.freeze'],
  'disputes.observation': ['admin.trust.evidence.decide'],
  'disputes.exclude': ['admin.trust.exclude'],
  'disputes.decide': ['admin.trust.evidence.decide'],
  'reputation.draft': ['admin.trust.evidence.decide', 'admin.trust.method.release'],
  'reputation.review': ['admin.trust.evidence.decide'],
  'reputation.release': ['admin.trust.method.release'],
  'reputation.explain': ['admin.trust.evidence.decide', 'admin.trust.method.release'],
  'appeals.decide': ['admin.trust.appeals.decide', 'admin.moderation.appeal.decide'],
  'appeals.request_info': ['admin.trust.appeals.decide', 'admin.moderation.appeal.decide'],
  'screening.add_list': ['admin.claims.policy.edit'],
  'screening.confirm_match': ['admin.claims.policy.edit'],
  'screening.not_same_person': ['admin.claims.policy.edit'],
  'screening.decide_appeal': ['admin.claims.policy.edit'],
  'screening.clear_hold': ['admin.claims.policy.edit'],
  'screening.rescreen': ['admin.claims.policy.edit'],
  'confirmations.policy': ['admin.claims.policy.edit'],
  'confirmations.open_case': ['admin.claims.policy.edit', 'admin.moderation.case.open'],
};

const PARAMETERS = Object.keys(METHOD_PARAMETERS) as MethodParameter[];
const int = (value: string | undefined) => (value !== undefined && /^-?\d{1,6}$/.test(value.trim()) ? Number(value) : null);
const inRange = (value: number | null, min: number, max: number) => value !== null && value >= min && value <= max;

export function evaluateTrust(input: SectionCommandInput, ctx: SectionCommandContext): SectionOutcome {
  const permissions = TRUST_COMMANDS[input.command];
  if (!permissions) return reject('invalid');
  const blocked = guard(input, ctx, permissions);
  if (blocked) return blocked;
  const data = trustOf(ctx.hub!.hub.id);
  const me = ctx.viewer!.person.id;
  const f = input.fields;

  switch (input.command) {
    case 'moderation.open_case': {
      const report = data.reports.find((r) => r.id === f.reportId);
      if (!report) return NOT_FOUND;
      return report.state === 'new' ? accepted('case_opened') : reject('already_decided');
    }
    case 'moderation.decide': {
      const c = data.cases.find((x) => x.id === f.caseId);
      if (!c) return NOT_FOUND;
      if (c.decision !== 'pending') return reject('already_decided');
      const outcome = oneOf(f.outcome, ['no_action', 'sanction'] as const);
      if (!outcome) return reject('invalid', 'outcome');
      if (outcome === 'no_action') return accepted('notified');
      const level = int(f.level);
      if (!inRange(level, 1, 4)) return reject('invalid', 'level');
      return level === 4 ? accepted('second_person', { secondPerson: 'moderation.apply_sanction_l4' }) : accepted('notified');
    }
    case 'moderation.emergency': {
      const kind = oneOf(f.kind, ['hold', 'freeze'] as const);
      if (!kind) return reject('invalid', 'kind');
      if (!holdsAny(ctx.access, [kind === 'hold' ? 'admin.moderation.emergency.hold' : 'admin.moderation.emergency.freeze'])) return reject('denied');
      return data.reports.some((r) => r.id === f.target) || data.cases.some((c) => c.id === f.target) ? accepted('notified') : NOT_FOUND;
    }
    case 'disputes.observation':
    case 'disputes.exclude':
    case 'disputes.decide': {
      const dispute = data.disputes.find((d) => d.id === f.disputeId);
      if (!dispute) return NOT_FOUND;
      if (dispute.state === 'decided') return reject('already_decided');
      if (input.command === 'disputes.observation') {
        if (!oneOf(f.stance, ['confirm', 'dispute'] as const)) return reject('invalid', 'stance');
        return oneOf(f.evidence, EVIDENCE_CATEGORIES) ? accepted() : reject('evidence_required', 'evidence');
      }
      if (input.command === 'disputes.exclude') return dispute.state === 'excluded_pending' ? reject('already_decided') : accepted('notified');
      return oneOf(f.decision, DISPUTE_DECISIONS) ? accepted('notified') : reject('invalid', 'decision');
    }
    case 'reputation.draft': {
      // A method version has exactly the bounded local parameters; any other field (a score, a rank, a badge) is refused.
      const extra = Object.keys(f).filter((k) => !(PARAMETERS as string[]).includes(k));
      if (extra.length) return reject('invalid', extra[0]!);
      for (const p of PARAMETERS) {
        const value = int(f[p]);
        if (value === null) return reject('invalid', p);
        if (!inRange(value, METHOD_PARAMETERS[p].min, METHOD_PARAMETERS[p].max)) return reject('out_of_bounds', p);
      }
      return accepted('version');
    }
    case 'reputation.review':
    case 'reputation.release':
    case 'reputation.explain': {
      const method = data.methods.find((m) => m.id === f.methodId);
      if (!method) return NOT_FOUND;
      if (input.command === 'reputation.review') return method.state === 'draft' || method.state === 'in_review' ? accepted() : reject('already_decided');
      if (input.command === 'reputation.release') return method.state === 'in_review' ? accepted('notified') : reject('invalid', 'methodId');
      return ctx.hub!.hub.locales.includes(f.locale ?? '') ? accepted() : reject('invalid', 'locale');
    }
    case 'appeals.decide':
    case 'appeals.request_info': {
      const appeal = data.appeals.find((a) => a.id === f.appealId);
      if (!appeal) return NOT_FOUND;
      if (appeal.originalDecider === me) return reject('original_decider');
      const needed: ConsolePermission = appeal.against === 'moderation' ? 'admin.moderation.appeal.decide' : 'admin.trust.appeals.decide';
      if (!holdsAny(ctx.access, [needed, 'admin.trust.appeals.decide'])) return reject('denied');
      if (input.command === 'appeals.request_info') return accepted('notified');
      return oneOf(f.decision, APPEAL_DECISIONS) ? accepted('notified') : reject('invalid', 'decision');
    }
    case 'screening.add_list': {
      const list = oneOf(f.list, PACK_LIST_FACTS);
      if (!list) return reject('invalid', 'list');
      if (data.lists.some((l) => l.code === list)) return reject('invalid', 'list');
      const mode = oneOf(f.mode, ['fake', 'file', 'live'] as const);
      if (!mode) return reject('invalid', 'mode');
      return mode === 'live' ? accepted('second_person', { secondPerson: 'providers.enable_non_fake' }) : accepted('version');
    }
    case 'screening.confirm_match':
    case 'screening.not_same_person': {
      const match = data.matches.find((m) => m.id === f.matchId);
      if (!match) return NOT_FOUND;
      if (match.state !== 'open') return reject('already_decided');
      return input.command === 'screening.not_same_person' ? accepted('pending_second') : accepted('notified');
    }
    case 'screening.decide_appeal': {
      const match = data.matches.find((m) => m.id === f.matchId);
      if (!match) return NOT_FOUND;
      if (match.state !== 'appeal') return reject('invalid', 'matchId');
      if (match.originalDecider === me) return reject('original_decider');
      const decision = oneOf(f.decision, ['uphold', 'reverse'] as const);
      if (!decision) return reject('invalid', 'decision');
      return decision === 'reverse' ? accepted('pending_second') : accepted('notified');
    }
    case 'screening.clear_hold': {
      if (!data.holds.some((h) => h.id === f.holdId)) return NOT_FOUND;
      return oneOf(f.evidence, HOLD_CLEAR_EVIDENCE) ? accepted('notified') : reject('evidence_required', 'evidence');
    }
    case 'screening.rescreen':
      return accepted();
    case 'confirmations.policy': {
      if (f.agentsMayConfirm !== undefined) return reject('baseline_locked', 'agentsMayConfirm');
      if (f.requireTransactionOrProjectLink !== undefined && f.requireTransactionOrProjectLink !== 'on') return reject('baseline_locked', 'requireTransactionOrProjectLink');
      if (!inRange(int(f.maxOpenRequestsPerRequester), 1, 200)) return reject('out_of_bounds', 'maxOpenRequestsPerRequester');
      if (!inRange(int(f.maxRequestsPerCounterpartyPerMonth), 1, 20)) return reject('out_of_bounds', 'maxRequestsPerCounterpartyPerMonth');
      if (!inRange(int(f.declineCooldownDays), 0, 365)) return reject('out_of_bounds', 'declineCooldownDays');
      return accepted('version');
    }
    case 'confirmations.open_case':
      return data.patterns.some((p) => p.id === f.patternId) ? accepted('case_opened') : NOT_FOUND;
  }
  return reject('invalid');
}
