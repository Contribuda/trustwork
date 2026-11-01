import type { ConsolePermission } from '@trustwork/contracts/client';
import {
  CHECKED_CLAIMS,
  CLAIM_DECISIONS,
  CONSENT_EVIDENCE,
  CONSENT_KINDS,
  CREDENTIAL_REVOCATION_REASONS,
  EVIDENCE_CATEGORIES,
  FLAG_CATEGORIES,
  participantsOf,
  PORTRAIT_SCOPES,
  PROVIDER_MODES,
  RECIPE_STEPS,
  VERIFICATION_REVOCATION_CATEGORIES,
} from './_fixtures.js';
import { accepted, guard, NOT_FOUND, oneOf, reject, type SectionCommandContext, type SectionCommandInput, type SectionOutcome } from './_section-command.js';
import { PACK_LIST_FACTS } from '../trust/_fixtures.js';

/**
 * Participants commands (HC-20 to HC-25, HUBC-004). Guard rails from docs/engine/hub-console/modules.md: an
 * identifier never upgrades a badge (verification goes through the recipe's steps and a decision), staff never edit a
 * person's public profile content (they flag it for moderation), a potential sanctions match blocks approval, a
 * reviewer with a declared conflict cannot decide, appeals go to a different reviewer, live check providers and
 * screening lists need a second person, and a credential type for a checked claim cannot be activated without its
 * verification recipe. There is no command that sets a score, a rank or a badge.
 */

export const PARTICIPANTS_COMMANDS: Readonly<Record<string, readonly ConsolePermission[]>> = {
  'people.flag': ['admin.people.flag', 'admin.moderation.case.open'],
  'companies.revoke_verification': ['admin.claims.revoke'],
  'companies.recheck': ['admin.claims.decide'],
  'companies.suspend_representative': ['admin.claims.decide'],
  'claims.record_check': ['admin.claims.decide'],
  'claims.decide': ['admin.claims.decide'],
  'claims.route_appeal': ['admin.claims.decide', 'admin.trust.appeals.decide'],
  'verification.recipe_version': ['admin.claims.policy.edit'],
  'verification.provider_mode': ['admin.claims.policy.edit', 'admin.providers.toggle'],
  'verification.add_list': ['admin.claims.policy.edit'],
  'credentials.type_version': ['admin.credentials.types.edit'],
  'credentials.issue': ['admin.credentials.issue'],
  'credentials.revoke': ['admin.credentials.revoke'],
  'credentials.suspend': ['admin.credentials.revoke'],
  'consents.record': ['admin.people.consent.record'],
  'consents.portrait': ['admin.people.portrait.licence'],
  'consents.withdrawal': ['admin.people.consent.record'],
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function evaluateParticipants(input: SectionCommandInput, ctx: SectionCommandContext): SectionOutcome {
  const permissions = PARTICIPANTS_COMMANDS[input.command];
  if (!permissions) return reject('invalid');
  const blocked = guard(input, ctx, permissions);
  if (blocked) return blocked;
  const data = participantsOf(ctx.hub!.hub.id);
  const me = ctx.viewer!.person.id;
  const f = input.fields;

  switch (input.command) {
    case 'people.flag': {
      // Only public profiles can be flagged; a private profile is "not found" to staff.
      if (!data.profiles.some((p) => p.id === f.profileId)) return NOT_FOUND;
      return oneOf(f.category, FLAG_CATEGORIES) ? accepted('case_opened') : reject('invalid', 'category');
    }
    case 'companies.revoke_verification': {
      const company = data.companies.find((c) => c.id === f.companyId);
      if (!company) return NOT_FOUND;
      if (company.state !== 'verified') return reject('not_verified', 'companyId');
      return oneOf(f.category, VERIFICATION_REVOCATION_CATEGORIES) ? accepted('notified') : reject('invalid', 'category');
    }
    case 'companies.recheck': {
      const company = data.companies.find((c) => c.id === f.companyId);
      if (!company) return NOT_FOUND;
      return company.state === 'sourced' ? reject('invalid', 'companyId') : accepted();
    }
    case 'companies.suspend_representative': {
      const company = data.companies.find((c) => c.id === f.companyId);
      if (!company) return NOT_FOUND;
      if (company.representative.state !== 'active' && company.representative.state !== 'accountable_missing') return reject('no_representative', 'companyId');
      return accepted('notified');
    }
    case 'claims.record_check': {
      const claim = data.claims.find((c) => c.id === f.claimId);
      if (!claim) return NOT_FOUND;
      if (claim.conflicts.includes(me)) return reject('conflict_of_interest');
      const s = oneOf(f.step, RECIPE_STEPS);
      if (!s || !claim.steps.some((x) => x.step === s)) return reject('invalid', 'step');
      if (s === 'screening') return reject('invalid', 'step'); // screening results come from the screening engine, never typed in
      if (!oneOf(f.result, ['pass', 'fail'] as const)) return reject('invalid', 'result');
      return oneOf(f.evidence, EVIDENCE_CATEGORIES) ? accepted() : reject('evidence_required', 'evidence');
    }
    case 'claims.decide': {
      const claim = data.claims.find((c) => c.id === f.claimId);
      if (!claim) return NOT_FOUND;
      if (claim.state === 'decided') return reject('already_decided');
      if (claim.conflicts.includes(me)) return reject('conflict_of_interest');
      if (claim.appeal && claim.appeal.originalDecider === me) return reject('original_decider');
      const decision = oneOf(f.decision, CLAIM_DECISIONS);
      if (!decision) return reject('invalid', 'decision');
      if (decision === 'claimed' || decision === 'verified') {
        if (claim.steps.some((s) => s.result === 'potential_match')) return reject('sanctions_match');
        const open = claim.steps.filter((s) => s.required && s.result !== 'pass');
        // Claimed needs the register match and the signatory tie; verified needs every required step of the recipe.
        const needed = decision === 'verified' ? open : open.filter((s) => s.step === 'register_match' || s.step === 'signatory_tie');
        if (needed.length) return reject('steps_incomplete');
      }
      return accepted('notified');
    }
    case 'claims.route_appeal': {
      const claim = data.claims.find((c) => c.id === f.claimId);
      if (!claim || !claim.appeal) return NOT_FOUND;
      const reviewer = f.reviewer ?? '';
      if (!ID.test(reviewer)) return reject('invalid', 'reviewer');
      if (reviewer === claim.appeal.originalDecider) return reject('original_decider', 'reviewer');
      if (claim.conflicts.includes(reviewer)) return reject('conflict_of_interest', 'reviewer');
      return accepted();
    }
    case 'verification.recipe_version': {
      const recipe = data.recipes.find((r) => r.id === f.recipeId);
      if (!recipe) return NOT_FOUND;
      // Baseline sanctions screening stays in every recipe; it has no switch.
      if (f.removeScreening === 'on') return reject('baseline_locked');
      return accepted('version');
    }
    case 'verification.provider_mode': {
      const check = data.checks.find((c) => c.id === f.checkId);
      if (!check) return NOT_FOUND;
      const mode = oneOf(f.mode, PROVIDER_MODES);
      if (!mode) return reject('invalid', 'mode');
      return mode === 'live' && check.mode !== 'live' ? accepted('second_person', { secondPerson: 'providers.enable_non_fake' }) : accepted('version');
    }
    case 'verification.add_list': {
      if (!oneOf(f.list, PACK_LIST_FACTS)) return reject('invalid', 'list');
      const mode = oneOf(f.mode, PROVIDER_MODES);
      if (!mode) return reject('invalid', 'mode');
      return mode === 'live' ? accepted('second_person', { secondPerson: 'providers.enable_non_fake' }) : accepted('version');
    }
    case 'credentials.type_version': {
      const type = data.credentialTypes.find((t) => t.id === f.typeId);
      if (!type) return NOT_FOUND;
      const recipe = f.recipeId ?? '';
      if (recipe !== 'none' && !data.recipes.some((r) => r.id === recipe)) return reject('invalid', 'recipeId');
      if (f.activate === 'on' && recipe === 'none' && CHECKED_CLAIMS.includes(type.claim)) return reject('recipe_missing', 'recipeId');
      return accepted('version');
    }
    case 'credentials.issue': {
      const decision = data.issuable.find((d) => d.id === f.decisionId);
      if (!decision) return NOT_FOUND;
      const type = data.credentialTypes.find((t) => t.id === decision.typeId);
      if (!type || type.status !== 'active') return reject('type_inactive');
      if (decision.evidence < 1) return reject('evidence_required');
      return accepted('notified');
    }
    case 'credentials.revoke':
    case 'credentials.suspend': {
      const credential = data.issued.find((c) => c.id === (f.credentialId ?? '').trim());
      if (!credential) return NOT_FOUND;
      if (credential.status === 'revoked') return reject('already_decided', 'credentialId');
      if (input.command === 'credentials.suspend' && credential.status === 'suspended') return reject('already_decided', 'credentialId');
      return oneOf(f.category, CREDENTIAL_REVOCATION_REASONS) ? accepted('notified') : reject('invalid', 'category');
    }
    case 'consents.record': {
      if (!ID.test((f.subjectId ?? '').trim())) return reject('invalid', 'subjectId');
      if (!oneOf(f.kind, CONSENT_KINDS)) return reject('invalid', 'kind');
      return oneOf(f.evidence, CONSENT_EVIDENCE) ? accepted() : reject('evidence_required', 'evidence');
    }
    case 'consents.portrait': {
      if (!ID.test((f.subjectId ?? '').trim())) return reject('invalid', 'subjectId');
      if (!oneOf(f.scope, PORTRAIT_SCOPES)) return reject('invalid', 'scope');
      return oneOf(f.evidence, CONSENT_EVIDENCE) ? accepted() : reject('evidence_required', 'evidence');
    }
    case 'consents.withdrawal':
      return data.withdrawals.some((w) => w.id === f.withdrawalId) ? accepted('notified') : NOT_FOUND;
  }
  return reject('invalid');
}
