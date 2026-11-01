import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ACCOUNT_SERVICE_ACTIONS,
  AccountServiceActionSchema,
  CASE_GRANT_MAX_HOURS,
  CONSOLE_SECOND_PERSON_ACTIONS,
  SupportAccountSummarySchema,
  suppressSmallCount,
} from '@trustwork/contracts/client';
import { permissionsFor, rolesFor } from '../../../../apps/web/app/admin/_data/access.js';
import { COMMANDS } from '../../../../apps/web/app/admin/_data/commands.js';
import { SECTIONS } from '../../../../apps/web/app/admin/_data/sections.js';
import { FIXTURE_NOW, HUB_SAMARKAND_ID, HUB_US_ID, NODE_ID } from '../../../../apps/web/app/admin/_fixtures/ids.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { STAFF, STAFF_PERSONAS } from '../../../../apps/web/app/admin/_fixtures/staff.js';
import { evaluateParticipants, PARTICIPANTS_COMMANDS } from '../../../../apps/web/app/admin/hubs/[hub]/participants/_commands.js';
import { COMPANIES, PROFILES, participantsOf } from '../../../../apps/web/app/admin/hubs/[hub]/participants/_fixtures.js';
import { ACCEPTED_KINDS, SECTION_REJECT_CODES, type SectionCommandContext, type SectionCommandInput, type SectionOutcome } from '../../../../apps/web/app/admin/hubs/[hub]/participants/_section-command.js';
import { evaluateSupport, parseObjectIds, SUPPORT_COMMANDS } from '../../../../apps/web/app/admin/hubs/[hub]/support/_commands.js';
import { ACCOUNTS, GRANT_REQUESTS, GRANTS, RECOVERY, SERVICE_ACTIONS } from '../../../../apps/web/app/admin/hubs/[hub]/support/_fixtures.js';
import { lookup, lookupData } from '../../../../apps/web/app/admin/hubs/[hub]/support/_lookup.js';
import { evaluateTrust, TRUST_COMMANDS } from '../../../../apps/web/app/admin/hubs/[hub]/trust/_commands.js';

/**
 * HUBC-004: participants, support and trust and safety screens on fixtures. The acceptance criteria are checked here
 * against the pure command evaluations and the source tree (scans), and in the browser by console-trust.spec.ts:
 * no impersonation route or control, no control that sets a score or badge, the case-grant journey with a second
 * approver, plus negative authorization, the support account card allowlist and cohort suppression.
 */

const now = new Date(FIXTURE_NOW);
const us = HUBS.find((h) => h.hub.id === HUB_US_ID)!;
const samarkand = HUBS.find((h) => h.hub.id === HUB_SAMARKAND_ID)!;
type Persona = keyof typeof STAFF_PERSONAS;

function ctx(persona: Persona, overrides: Partial<SectionCommandContext> = {}, hub = us): SectionCommandContext {
  const person = STAFF.people.find((p) => p.id === STAFF_PERSONAS[persona])!;
  const target = { nodeId: NODE_ID, hubId: hub.hub.id };
  return {
    viewer: { person, elevation: { state: 'elevated', until: '2026-10-31T12:10:00Z' } },
    access: { roles: rolesFor(STAFF, person.id, target, now), permissions: [...permissionsFor(STAFF, person.id, target, now)] },
    hub,
    now,
    offline: false,
    ...overrides,
  };
}
const input = (command: string, fields: Record<string, string> = {}, reason = 'Synthetic test reason'): SectionCommandInput => ({ command, reason, expectedRevision: us.hub.revision, fields });
const code = (outcome: SectionOutcome) => (outcome.status === 'rejected' ? outcome.code : outcome.status);
const kind = (outcome: SectionOutcome) => (outcome.status === 'demo_not_saved' ? outcome.kind : code(outcome));

/* ---------- Fixtures ---------- */

test('fixtures are synthetic and parse with the frozen contracts (importing them parses them)', () => {
  for (const p of PROFILES) assert.match(p.name.value, /^Synthetic /);
  for (const c of COMPANIES) assert.match(c.name.value, /^Synthetic .*\((demo)\)$/);
  for (const c of COMPANIES) for (const id of c.identifiers) if (id.kind === 'ein') assert.match(id.value, /^00-/, 'EIN-shaped values use the never-issued prefix 00');
  for (const a of ACCOUNTS) assert.match(a.summary.maskedEmail, /\.invalid$/);
  for (const c of COMPANIES) if (c.source) assert.match(c.source.url, /^https:\/\/[a-z.]+\.example\.org\//);
  assert.equal(participantsOf(HUB_SAMARKAND_ID).claims.length, 0, 'the Samarkand example hub shows empty states');
});

test('the support account card is an allowlist: strict schema, masked e-mail, leak probes refused', () => {
  const allowed = Object.keys(SupportAccountSummarySchema.shape).sort();
  for (const a of ACCOUNTS) assert.deepEqual(Object.keys(a.summary).sort(), allowed);
  const sample = ACCOUNTS[0]!.summary;
  for (const leak of [{ sessionToken: 'tok' }, { ipAddress: '192.0.2.1' }, { messageBodies: ['hi'] }, { budget: 100 }, { passwordHash: 'x' }]) {
    assert.equal(SupportAccountSummarySchema.safeParse({ ...sample, ...leak }).success, false, `leak probe ${Object.keys(leak)[0]}`);
  }
  assert.equal(SupportAccountSummarySchema.safeParse({ ...sample, maskedEmail: 'maya@harbor.example.invalid' }).success, false, 'an unmasked e-mail is refused');
});

test('recovery fixtures with an approver satisfy AccountServiceActionSchema: evidence, a different person, at least 72 hours', () => {
  for (const r of RECOVERY.filter((x) => x.approvedBy && x.effectiveAt)) {
    const parsed = AccountServiceActionSchema.safeParse({
      id: r.id, hubId: r.hubId, supportCaseId: r.caseId, subjectPersonId: r.subject.personId, action: r.action, requestedBy: r.requestedBy, approvedBy: r.approvedBy,
      evidenceRefs: r.evidence === 'recorded' ? ['ev-1'] : [], requestedAt: r.requestedAt, effectiveAt: r.effectiveAt, subjectNotified: true,
      state: r.state === 'ready' ? 'cooling_off' : r.state === 'awaiting_approval' ? 'pending' : r.state,
    });
    assert.ok(parsed.success, `${r.id}: ${parsed.success ? '' : parsed.error.message}`);
  }
});

test('case grants in the fixtures: requester differs from approver, at most 72 hours, private field classes excluded', () => {
  for (const g of GRANTS) {
    assert.notEqual(g.requestedBy, g.approvedBy);
    assert.ok(Date.parse(g.expiresAt) - Date.parse(g.approvedAt) <= CASE_GRANT_MAX_HOURS * 3_600_000);
    for (const cls of ['negotiation_private', 'credentials', 'payment_refs']) assert.ok(g.excludedFieldClasses.includes(cls as never));
  }
  for (const r of GRANT_REQUESTS) assert.ok(r.hours <= CASE_GRANT_MAX_HOURS && r.ids.length <= 100);
});

test('cohort counts below ten are suppressed', () => {
  assert.equal(suppressSmallCount(4), null);
  assert.equal(suppressSmallCount(0), null);
  assert.equal(suppressSmallCount(10), 10);
  assert.ok(participantsOf(HUB_US_ID).accountStates!.locked < 10, 'the US fixture has a small cohort the screens must suppress');
});

test('the built sections are exactly the HUBC-004 screens, now with status demo', () => {
  for (const { group, section } of SECTIONS.filter((s) => ['participants', 'support', 'trust'].includes(s.group.id))) assert.equal(section.status, 'demo', `${group.id}.${section.id}`);
});

/* ---------- Negative authorization ---------- */

test('negative authorization on every group: no role, wrong role, other hub, no elevation, offline, no reason, unknown command', () => {
  const cases: Array<[typeof evaluateParticipants, string, Record<string, string>, Persona]> = [
    [evaluateParticipants, 'claims.decide', { claimId: 'cl-201', decision: 'claimed' }, 'trust-reviewer'],
    [evaluateSupport, 'grants.request', { caseId: 'sc-1001', objectType: 'rfq', ids: 'rfq-7781', projectionClass: 'diagnostic', purpose: 'Check delivery', hours: '24' }, 'support-agent'],
    [evaluateTrust, 'moderation.decide', { caseId: 'mc-410', outcome: 'no_action' }, 'trust-reviewer'],
  ];
  for (const [evaluate, command, fields, allowed] of cases) {
    assert.equal(code(evaluate(input(command, fields), ctx('staff-none'))), 'denied', `${command}: staff-none`);
    assert.equal(code(evaluate(input(command, fields), ctx('editor'))), 'denied', `${command}: editor`);
    assert.equal(code(evaluate(input(command, fields), ctx(allowed, {}, samarkand))), 'denied', `${command}: a US role does not act on Samarkand`);
    const notElevated = ctx(allowed);
    notElevated.viewer = { ...notElevated.viewer!, elevation: { state: 'required' } };
    assert.equal(code(evaluate(input(command, fields), notElevated)), 'elevation_required', `${command}: elevation`);
    assert.equal(code(evaluate(input(command, fields), ctx(allowed, { offline: true }))), 'offline', `${command}: offline`);
    assert.equal(code(evaluate(input(command, fields, '  '), ctx(allowed))), 'reason_required', `${command}: reason`);
    assert.equal(code(evaluate(input(command, fields), ctx(allowed, { viewer: null }))), 'not_found', `${command}: anonymous`);
    assert.equal(code(evaluate(input('impersonate.start', fields), ctx(allowed))), 'invalid', 'unknown commands are refused');
    assert.equal(evaluate(input(command, fields), ctx(allowed)).status, 'demo_not_saved', `${command}: the allowed persona`);
  }
});

/* ---------- Acceptance 3: the case-grant journey with a second approver ---------- */

test('case-grant journey: an agent requests, cannot approve; a different lead approves the exact digest; the requester never approves', () => {
  const request = { caseId: 'sc-1001', objectType: 'rfq', ids: 'rfq-7781, inv-7781-2', projectionClass: 'diagnostic', purpose: 'Check whether the invitation was delivered', hours: '24' };
  // 1. The support agent asks for a grant on named objects.
  assert.equal(kind(evaluateSupport(input('grants.request', request), ctx('support-agent'))), 'grant_requested');
  // 2. The agent cannot approve any grant (no approve permission), their own included.
  const agentRequest = GRANT_REQUESTS.find((g) => g.id === 'gr-301')!;
  assert.equal(code(evaluateSupport(input('grants.approve', { requestId: agentRequest.id, digest: agentRequest.digest.value, decision: 'approve' }), ctx('support-agent'))), 'denied');
  // 3. A different person, the support lead, approves and restates the digest.
  assert.equal(evaluateSupport(input('grants.approve', { requestId: agentRequest.id, digest: agentRequest.digest.value, decision: 'approve' }), ctx('support')).status, 'demo_not_saved');
  // A different digest (the request changed) is refused.
  assert.equal(code(evaluateSupport(input('grants.approve', { requestId: agentRequest.id, digest: 'f'.repeat(64), decision: 'approve' }), ctx('support'))), 'digest_mismatch');
  // 4. The lead's own request cannot be approved by the lead.
  const leadRequest = GRANT_REQUESTS.find((g) => g.requestedBy === 'p-support')!;
  assert.equal(code(evaluateSupport(input('grants.approve', { requestId: leadRequest.id, digest: leadRequest.digest.value, decision: 'approve' }), ctx('support'))), 'own_request');
  // 5. A request older than 72 hours expires.
  assert.equal(code(evaluateSupport(input('grants.approve', { requestId: agentRequest.id, digest: agentRequest.digest.value, decision: 'approve' }), ctx('support', { now: new Date(Date.parse(agentRequest.requestedAt) + 73 * 3_600_000) }))), 'request_expired');
});

test('case-grant requests are bounded: at most 72 hours, 1 to 100 ids of one type, a known projection class, an open case', () => {
  const base = { caseId: 'sc-1001', objectType: 'rfq', ids: 'rfq-1', projectionClass: 'diagnostic', purpose: 'Diagnose', hours: '24' };
  const agent = ctx('support-agent');
  assert.equal(code(evaluateSupport(input('grants.request', { ...base, hours: String(CASE_GRANT_MAX_HOURS + 1) }), agent)), 'grant_too_long');
  assert.equal(code(evaluateSupport(input('grants.request', { ...base, ids: Array.from({ length: 101 }, (_, i) => `rfq-${i}`).join(',') }), agent)), 'too_many_objects');
  assert.equal(code(evaluateSupport(input('grants.request', { ...base, ids: '' }), agent)), 'invalid');
  assert.equal(code(evaluateSupport(input('grants.request', { ...base, projectionClass: 'everything' }), agent)), 'invalid');
  assert.equal(code(evaluateSupport(input('grants.request', { ...base, caseId: 'sc-0999' }), agent)), 'case_closed');
  assert.equal(code(evaluateSupport(input('grants.request', { ...base, caseId: 'sc-nope' }), agent)), 'not_found');
  assert.deepEqual(parseObjectIds('a, b\nc  d'), ['a', 'b', 'c', 'd']);
  // An expired or revoked grant cannot be revoked again: its objects are already not found.
  assert.equal(code(evaluateSupport(input('grants.revoke', { grantId: 'g-150' }), agent)), 'request_void');
  assert.equal(code(evaluateSupport(input('grants.revoke', { grantId: 'g-120' }), agent)), 'request_void');
  assert.equal(evaluateSupport(input('grants.revoke', { grantId: 'g-201' }), agent).status, 'demo_not_saved');
});

/* ---------- Servicing without impersonation ---------- */

test('servicing: never one\'s own account, never an erased one, always for an open case about the account', () => {
  const lead = ctx('support');
  assert.equal(code(evaluateSupport(input('accounts.service', { personId: 'p-support', action: 'revoke_all_sessions', caseId: 'sc-1001' }), lead)), 'own_account');
  assert.equal(code(evaluateSupport(input('accounts.service', { personId: 'acct-erased', action: 'revoke_all_sessions', caseId: 'sc-1001' }), lead)), 'account_erased');
  assert.equal(code(evaluateSupport(input('accounts.service', { personId: 'acct-maya', action: 'revoke_all_sessions', caseId: 'sc-1003' }), lead)), 'case_required', 'the case must be about this account');
  assert.equal(code(evaluateSupport(input('accounts.service', { personId: 'acct-jordan', action: 'resend_verification', caseId: 'sc-0999' }), lead)), 'case_required', 'a closed case does not count');
  assert.equal(kind(evaluateSupport(input('accounts.service', { personId: 'acct-maya', action: 'revoke_all_sessions', caseId: 'sc-1001' }), lead)), 'notified');
  assert.equal(code(evaluateSupport(input('accounts.service', { personId: 'acct-maya', action: 'unlock_after_lockout', caseId: 'sc-1001' }), lead)), 'invalid', 'only a locked account is unlocked');
  assert.equal(code(evaluateSupport(input('cases.create', { subjectKind: 'person', subjectId: 'p-support', reason: 'access' }), lead)), 'own_account');
});

test('sign-in factor changes need evidence, a different approver and a 72-hour cooling-off; an objection cancels', () => {
  const agent = ctx('support-agent');
  const lead = ctx('support');
  assert.equal(code(evaluateSupport(input('accounts.service', { personId: 'acct-maya', action: 'rebind_recovery_email', caseId: 'sc-1001' }), agent)), 'evidence_required');
  const requested = evaluateSupport(input('accounts.service', { personId: 'acct-maya', action: 'rebind_recovery_email', caseId: 'sc-1001', evidence: 'on' }), agent);
  assert.deepEqual(requested, { status: 'demo_not_saved', kind: 'second_person', secondPerson: 'support.rebind_recovery_email', date: null });
  assert.equal(code(evaluateSupport(input('accounts.service', { personId: 'acct-maya', action: 'reset_second_factor', caseId: 'sc-1001', evidence: 'on' }), agent)), 'cooling_off_active', 'one request at a time');
  // Approval by a different person starts a 72-hour cooling-off.
  const approved = evaluateSupport(input('recovery.approve', { requestId: 'rr-62' }), lead);
  assert.equal(kind(approved), 'cooling_off');
  assert.equal(approved.status === 'demo_not_saved' ? approved.date : null, new Date(now.getTime() + 72 * 3_600_000).toISOString());
  assert.equal(code(evaluateSupport(input('recovery.approve', { requestId: 'rr-62' }), agent)), 'denied', 'the agent may not approve');
  assert.equal(code(evaluateSupport(input('recovery.approve', { requestId: 'rr-61' }), lead)), 'request_void', 'already approved');
  // Completion only after the cooling-off, never after an objection.
  assert.equal(code(evaluateSupport(input('recovery.complete', { requestId: 'rr-61' }), lead)), 'cooling_off_active');
  assert.equal(kind(evaluateSupport(input('recovery.complete', { requestId: 'rr-58' }), lead)), 'notified');
  assert.equal(code(evaluateSupport(input('recovery.complete', { requestId: 'rr-55' }), lead)), 'objection_received');
});

test('lookups: exact e-mail on the normalised value, never a partial e-mail; names and identifiers; erased accounts not by name', () => {
  const data = lookupData(HUB_US_ID);
  assert.deepEqual(lookup(data, 'email', '  MAYA@harbor.example.invalid ').map((r) => r.id), ['acct-maya']);
  assert.deepEqual(lookup(data, 'email', 'maya@'), []);
  assert.deepEqual(lookup(data, 'name', 'roofer').map((r) => r.id), ['acct-luis']);
  assert.deepEqual(lookup(data, 'name', 'erased'), []);
  assert.deepEqual(lookup(data, 'identifier', '00-0000101').map((r) => r.id), ['co-coastal']);
  assert.deepEqual(lookup(data, 'company', 'mesa'), [], 'sourced pages are not support subjects');
  assert.deepEqual(lookup(lookupData(HUB_SAMARKAND_ID), 'email', 'maya@harbor.example.invalid'), [], 'another hub finds nothing');
});

/* ---------- Participants and trust invariants ---------- */

test('claims: a sanctions match or a declared conflict blocks the decision; verified needs every required step; appeals go elsewhere', () => {
  const reviewer = ctx('trust-reviewer');
  assert.equal(code(evaluateParticipants(input('claims.decide', { claimId: 'cl-202', decision: 'claimed' }), reviewer)), 'sanctions_match');
  assert.equal(kind(evaluateParticipants(input('claims.decide', { claimId: 'cl-202', decision: 'clarify' }), reviewer)), 'notified', 'asking for clarification stays possible');
  assert.equal(code(evaluateParticipants(input('claims.decide', { claimId: 'cl-203', decision: 'verified' }), reviewer)), 'conflict_of_interest');
  assert.equal(code(evaluateParticipants(input('claims.decide', { claimId: 'cl-201', decision: 'verified' }), reviewer)), 'steps_incomplete');
  assert.equal(kind(evaluateParticipants(input('claims.decide', { claimId: 'cl-201', decision: 'claimed' }), reviewer)), 'notified');
  assert.equal(code(evaluateParticipants(input('claims.decide', { claimId: 'cl-204', decision: 'claimed' }), reviewer)), 'original_decider');
  assert.equal(code(evaluateParticipants(input('claims.route_appeal', { claimId: 'cl-204', reviewer: 'p-trust' }), reviewer)), 'original_decider');
  assert.equal(code(evaluateParticipants(input('claims.record_check', { claimId: 'cl-201', step: 'screening', result: 'pass', evidence: 'register_extract' }), reviewer)), 'invalid', 'screening results are never typed in');
  assert.equal(code(evaluateParticipants(input('people.flag', { profileId: 'pr-hidden', category: 'spam' }), reviewer)), 'not_found', 'a private profile is not found');
});

test('verification and credentials: live providers need a second person; checked claims need a recipe; baseline screening stays', () => {
  const compliance = ctx('compliance');
  assert.deepEqual(evaluateParticipants(input('verification.provider_mode', { checkId: 'ck-register', mode: 'live' }), compliance), { status: 'demo_not_saved', kind: 'second_person', secondPerson: 'providers.enable_non_fake', date: null });
  assert.equal(code(evaluateParticipants(input('verification.recipe_version', { recipeId: 'rc-company-claim-us', removeScreening: 'on' }), compliance)), 'baseline_locked');
  const reviewer = ctx('trust-reviewer');
  assert.equal(code(evaluateParticipants(input('credentials.type_version', { typeId: 'ct-licence', recipeId: 'none', activate: 'on' }), reviewer)), 'recipe_missing');
  assert.equal(kind(evaluateParticipants(input('credentials.type_version', { typeId: 'ct-confirmation', recipeId: 'none', activate: 'on' }), reviewer)), 'version', 'counterparty confirmations need no recipe');
  assert.equal(code(evaluateParticipants(input('credentials.revoke', { credentialId: 'vc-1003', category: 'fraud' }), reviewer)), 'already_decided');
  assert.equal(kind(evaluateParticipants(input('credentials.issue', { decisionId: 'dc-coastal-licence' }), reviewer)), 'notified');
});

test('trust: no score edits, bounded method parameters, release by the hub owner, sanction level 4 and screening reversals need a second person', () => {
  const reviewer = ctx('trust-reviewer');
  const ok = { windowMonths: '24', minimumSamples: '5', confirmationDays: '21' };
  assert.equal(kind(evaluateTrust(input('reputation.draft', ok), reviewer)), 'version');
  assert.equal(code(evaluateTrust(input('reputation.draft', { ...ok, windowMonths: '120' }), reviewer)), 'out_of_bounds');
  assert.equal(code(evaluateTrust(input('reputation.draft', { ...ok, minimumSamples: '1' }), reviewer)), 'out_of_bounds');
  for (const field of ['score', 'rank', 'badge', 'featured', 'position']) assert.equal(code(evaluateTrust(input('reputation.draft', { ...ok, [field]: '100' }), reviewer)), 'invalid', `${field} is refused`);
  assert.equal(code(evaluateTrust(input('reputation.release', { methodId: 'rm-4' }), reviewer)), 'denied');
  assert.equal(kind(evaluateTrust(input('reputation.release', { methodId: 'rm-4' }), ctx('hub-owner'))), 'notified');
  assert.deepEqual(evaluateTrust(input('moderation.decide', { caseId: 'mc-410', outcome: 'sanction', level: '4' }), reviewer), { status: 'demo_not_saved', kind: 'second_person', secondPerson: 'moderation.apply_sanction_l4', date: null });
  assert.equal(kind(evaluateTrust(input('moderation.decide', { caseId: 'mc-410', outcome: 'sanction', level: '2' }), reviewer)), 'notified');
  assert.equal(code(evaluateTrust(input('appeals.decide', { appealId: 'ap-91', decision: 'upheld' }), reviewer)), 'original_decider');
  assert.equal(kind(evaluateTrust(input('appeals.decide', { appealId: 'ap-93', decision: 'upheld' }), reviewer)), 'notified');
  const compliance = ctx('compliance');
  assert.equal(kind(evaluateTrust(input('screening.not_same_person', { matchId: 'sm-31' }), compliance)), 'pending_second');
  assert.equal(code(evaluateTrust(input('screening.decide_appeal', { matchId: 'sm-27', decision: 'reverse' }), compliance)), 'original_decider');
  assert.equal(code(evaluateTrust(input('screening.clear_hold', { holdId: 'jh-12' }), compliance)), 'evidence_required');
  assert.equal(code(evaluateTrust(input('confirmations.policy', { maxOpenRequestsPerRequester: '20', maxRequestsPerCounterpartyPerMonth: '3', declineCooldownDays: '30', agentsMayConfirm: 'on' }), compliance)), 'baseline_locked');
  assert.equal(code(evaluateTrust(input('confirmations.policy', { maxOpenRequestsPerRequester: '0', maxRequestsPerCounterpartyPerMonth: '3', declineCooldownDays: '30' }), compliance)), 'out_of_bounds');
});

/* ---------- Scans: acceptance 1 (no impersonation) and 2 (no score or badge control) ---------- */

const ADMIN = resolve('apps/web/app/admin');
const OWN = ['participants', 'support', 'trust'].map((g) => join(ADMIN, 'hubs/[hub]', g));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? [full, ...files(full)] : [full];
  });
}
const IMPERSONATION = /imperson|login[-_ ]?as|log[-_ ]?in[-_ ]?as|sign[-_ ]?in[-_ ]?as|act[-_ ]?as[-_ ]?(user|person|participant)|become[-_ ]?(user|person)|switch[-_ ]?user|sudo|ghost[-_ ]?login|masquerade/i;
const SCORE = /score|rank|badge|featured|rating|position|stars?\b/i;
const ALL_COMMANDS = [...COMMANDS, ...Object.keys(PARTICIPANTS_COMMANDS), ...Object.keys(SUPPORT_COMMANDS), ...Object.keys(TRUST_COMMANDS)];

/** Control surfaces in the source: command ids, form field names and link targets of the console code. */
function controls(source: string): string[] {
  return [
    ...[...source.matchAll(/command="([^"]+)"/g)].map((m) => `command ${m[1]}`),
    ...[...source.matchAll(/\bname="([^"]+)"/g)].map((m) => `field ${m[1]}`),
    ...[...source.matchAll(/href=\{ctx\.href\(`?'?([^`')]+)/g)].map((m) => `link ${m[1]}`),
    ...[...source.matchAll(/f\.([A-Za-z]+)/g)].map((m) => `input ${m[1]}`),
  ];
}

test('the scans see the controls and would catch an offending one', () => {
  const own = OWN.flatMap(files).filter((f) => /\.tsx$/.test(f)).flatMap((f) => controls(readFileSync(f, 'utf8')));
  assert.ok(own.filter((c) => c.startsWith('command ')).length >= 40, 'command props are found');
  assert.ok(own.filter((c) => c.startsWith('field ')).length >= 40, 'field names are found');
  for (const bad of ['link support/impersonate', 'command support.login_as', 'field signInAs', 'link admin/masquerade']) assert.ok(IMPERSONATION.test(bad), bad);
  for (const bad of ['field score', 'input rank', 'command trust.set_badge', 'field featured']) assert.ok(SCORE.test(bad.split(' ')[1]!), bad);
});

test('acceptance 1 (scan): no impersonation route, command, control or link anywhere in the console', () => {
  const routes = files(resolve('apps/web/app')).filter((f) => statSync(f).isDirectory()).map((f) => f.slice(resolve('apps/web/app').length));
  assert.deepEqual(routes.filter((r) => IMPERSONATION.test(r)), [], 'no route segment');
  assert.deepEqual(ALL_COMMANDS.filter((c) => IMPERSONATION.test(c) || /session\.(create|start)|as_user/.test(c)), [], 'no command');
  const sources = files(ADMIN).filter((f) => /\.tsx?$/.test(f));
  const found = sources.flatMap((f) => controls(readFileSync(f, 'utf8')).filter((c) => IMPERSONATION.test(c)).map((c) => `${f.slice(ADMIN.length)}: ${c}`));
  assert.deepEqual(found, [], 'no control, field or link');
  assert.deepEqual([...SERVICE_ACTIONS].sort(), [...ACCOUNT_SERVICE_ACTIONS].sort(), 'servicing actions are exactly the contract list: none acts as the person');
  assert.ok(!CONSOLE_SECOND_PERSON_ACTIONS.some((a) => IMPERSONATION.test(a)));
  // English control labels of the console namespaces: buttons and links never offer to become someone.
  const en = JSON.parse(readFileSync(resolve('apps/web/locales/en/admin-participants.json'), 'utf8')) as Record<string, unknown>;
  const labels: string[] = [];
  (function walk(node: unknown, path: string) {
    if (typeof node === 'string') labels.push(`${path}=${node}`);
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  })(en, '');
  const offers = labels.filter((l) => /^[^=]*\.(submit|open|button|action|link)[^=]*=/.test(l) && IMPERSONATION.test(l));
  assert.deepEqual(offers, []);
});

test('acceptance 1 (scan): staff never manage a participant\'s own agent, mandates, settings, goals or connections', () => {
  const people = [...Object.keys(PARTICIPANTS_COMMANDS), ...Object.keys(SUPPORT_COMMANDS)];
  assert.deepEqual(people.filter((c) => /agent|mandate|goal|connection|settings/i.test(c)), []);
  const sources = OWN.slice(0, 2).flatMap(files).filter((f) => /\.tsx?$/.test(f));
  const fields = sources.flatMap((f) => controls(readFileSync(f, 'utf8')).filter((c) => /^(field|input|command) .*(agent|mandate|goal|connection)/i.test(c)).map((c) => `${f}: ${c}`));
  assert.deepEqual(fields, []);
});

test('acceptance 2 (scan): no command, field or input of these screens sets a score, a rank, a position, "featured" or a badge', () => {
  assert.deepEqual(ALL_COMMANDS.filter((c) => SCORE.test(c)), [], 'no command');
  const sources = OWN.flatMap(files).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('_fixtures.ts'));
  const found = sources.flatMap((f) => controls(readFileSync(f, 'utf8')).filter((c) => SCORE.test(c.split(' ')[1] ?? '')).map((c) => `${f.slice(ADMIN.length)}: ${c}`));
  assert.deepEqual(found, []);
});

test('every reject code and accepted kind has an English message', () => {
  const en = JSON.parse(readFileSync(resolve('apps/web/locales/en/admin-participants.json'), 'utf8')) as { adminParticipants: { errors: Record<string, string>; outcomes: Record<string, string> } };
  const admin = JSON.parse(readFileSync(resolve('apps/web/locales/en/admin.json'), 'utf8')) as { admin: { errors: Record<string, string> } };
  assert.deepEqual(SECTION_REJECT_CODES.filter((c) => !en.adminParticipants.errors[c] && !admin.admin.errors[c]), []);
  assert.deepEqual(ACCEPTED_KINDS.filter((k) => !en.adminParticipants.outcomes[k]), []);
});

/* ---------- The admin-participants locale namespace ---------- */

const LOCALES = resolve('apps/web/locales');
function flat(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(node: unknown, path: string) {
    if (typeof node === 'string') out.set(path, node);
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  })(JSON.parse(readFileSync(join(LOCALES, tag, 'admin-participants.json'), 'utf8')), '');
  return out;
}
const ENGINE_LANGUAGES = ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn', 'es'];
/** Tokens that stay Latin in every script: list codes, identifiers, abbreviations. */
const LATIN = /\b(EIN|SMS|Trustwork|US|ID|plural|one|few|many|other)\b/g;
/** Words spelled the same as in English in a Latin-script language. */
const SAME = new Set(['Spam', 'No', 'Manual', 'Moderator', 'Hub', 'Status']);

test('every engine language has the namespace with exactly the English keys and placeholders, and plural forms', () => {
  const en = flat('en');
  for (const tag of ENGINE_LANGUAGES) {
    const dict = flat(tag);
    assert.deepEqual([...en.keys()].filter((k) => !dict.has(k)), [], `${tag}: missing keys`);
    assert.deepEqual([...dict.keys()].filter((k) => !en.has(k)), [], `${tag}: extra keys`);
    for (const [key, value] of dict) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();
      assert.deepEqual(names(value), names(en.get(key)!), `${tag}: ${key} placeholders`);
      assert.ok(value.trim(), `${tag}: ${key} empty`);
      if (/, plural,/.test(en.get(key)!)) assert.match(value, /other \{/, `${tag}: ${key} plural needs other`);
    }
  }
  for (const [key, value] of flat('ru')) if (/, plural,/.test(value)) for (const form of ['one', 'few', 'many', 'other']) assert.match(value, new RegExp(`${form} \\{`), `ru: ${key} ${form}`);
});

test('no English copy is left in the other languages, and scripts match the language', () => {
  const en = flat('en');
  for (const tag of ENGINE_LANGUAGES.filter((t) => t !== 'en')) {
    const dict = flat(tag);
    const same = [...dict].filter(([key, value]) => value === en.get(key) && !SAME.has(value) && /[A-Za-z]{3}/.test(value.replace(/\{[^}]*\}/g, '').replace(LATIN, '')));
    assert.deepEqual(same.map(([k]) => k), [], `${tag}: identical to English`);
    if (tag.endsWith('-Latn') || tag === 'es') assert.deepEqual([...dict].filter(([, v]) => /[Ѐ-ӿ]/.test(v)).map(([k]) => k), [], `${tag}: Cyrillic`);
    if (tag === 'ru' || tag === 'ka' || tag === 'hy') {
      const latin = [...dict].filter(([, v]) => /[A-Za-z]{3,}/.test(v.replace(/\{[^}]*\}/g, '').replace(LATIN, '')));
      assert.deepEqual(latin.map(([k, v]) => `${k}: ${v}`), [], `${tag}: Latin words`);
    }
  }
});
