import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUMAN_ONLY_ACTIONS, parityGaps } from '../../packages/contracts/src/agent-catalog.js';
import {
  buildLimitation, classifyTimeliness, confirmationStatus, CONTRIBUTION_SOURCES, credentialStatus, FORBIDDEN_REPUTATION_INPUTS, LIMITATION_REASON_CODES, LIMITATION_REASONS,
  REPUTATION_BUILDER_MANIFEST, REPUTATION_DERIVATION_SOURCES, summarizeTimeliness,
} from '../../packages/contracts/src/reputation-builder.js';
import { boundedLookup, FakeCredentialRegister } from '../../apps/api/src/modules/reputation/register.js';

/**
 * REP-001 rules without a database: derived credential and confirmation statuses, fair timeliness classification,
 * the limitation registry (every code has an explanation key and an appeal link and matches the database), the
 * capability registry, and static guarantees: derivation reads canonical records only (no activity tracking, no
 * per-employee metrics) and the module never reads billing, entitlements or staff input.
 */
const MIGRATION = readFileSync('packages/data/migrations/reputation/20261102160000_reputation_builder.sql', 'utf8');
const functionBody = (name: string): string => {
  const start = MIGRATION.indexOf(`CREATE FUNCTION trustwork.${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = MIGRATION.indexOf('END $$;', start);
  return MIGRATION.slice(start, end);
};

test('credential status: a revoked or suspended register answer wins, expiry next, checked only with a passing check', () => {
  const today = '2026-11-02';
  assert.equal(credentialStatus({ validUntil: null, lastCheck: null }, today), 'self_declared');
  assert.equal(credentialStatus({ validUntil: '2030-01-01', lastCheck: { outcome: 'match', registerValidUntil: '2030-01-01' } }, today), 'checked');
  assert.equal(credentialStatus({ validUntil: '2030-01-01', lastCheck: { outcome: 'match', registerValidUntil: '2026-10-01' } }, today), 'expired', 'the register\'s expiry counts');
  assert.equal(credentialStatus({ validUntil: '2026-01-01', lastCheck: null }, today), 'expired');
  assert.equal(credentialStatus({ validUntil: null, lastCheck: { outcome: 'unavailable', registerValidUntil: null } }, today), 'self_declared', 'an unknown outcome never becomes checked');
  assert.equal(credentialStatus({ validUntil: null, lastCheck: { outcome: 'not_found', registerValidUntil: null } }, today), 'self_declared');
  assert.equal(credentialStatus({ validUntil: null, lastCheck: { outcome: 'suspended', registerValidUntil: null } }, today), 'suspended');
  assert.equal(credentialStatus({ validUntil: '2020-01-01', lastCheck: { outcome: 'revoked', registerValidUntil: null } }, today), 'revoked');
});

test('confirmation status: an answer wins; a declined answer reads "not confirmed"; no answer past the deadline is expired, never a failure', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const base = { withdrawnAt: null, dueAt: '2026-12-01T00:00:00.000Z' };
  assert.equal(confirmationStatus({ ...base, decision: null }, now), 'requested');
  assert.equal(confirmationStatus({ ...base, decision: 'confirmed' }, now), 'confirmed');
  assert.equal(confirmationStatus({ ...base, decision: 'partially' }, now), 'partially_confirmed');
  assert.equal(confirmationStatus({ ...base, decision: 'declined' }, now), 'not_confirmed');
  assert.equal(confirmationStatus({ ...base, withdrawnAt: '2026-11-01T00:00:00.000Z', decision: null }, now), 'withdrawn');
  assert.equal(confirmationStatus({ withdrawnAt: null, dueAt: '2026-11-01T00:00:00.000Z', decision: null }, now), 'expired');
});

test('client-caused delay is excluded from timeliness, with a reason code, the plan change as evidence and an appeal link', () => {
  const base = { id: 't1', agreementId: 'a1', sourceObservationId: 'o1', planChangeIds: [] as string[], appealStatus: null };
  const excused = classifyTimeliness({ ...base, deltaSeconds: 4 * 86_400, excludedReason: 'client_caused_change', planChangeIds: ['c1'] });
  assert.deepEqual([excused.outcome, excused.counted, excused.limitation?.reasonCode], ['excused', false, 'excluded_client_caused_change']);
  assert.deepEqual(excused.limitation?.evidence.map((e) => e.kind), ['agreement', 'performance_observation', 'plan_change']);
  assert.deepEqual(excused.limitation?.appeal.subject, { kind: 'timeliness_observation', id: 't1' });
  const late = classifyTimeliness({ ...base, deltaSeconds: 3600, excludedReason: null });
  assert.deepEqual([late.outcome, late.counted, late.limitation], ['late', true, null]);
  assert.equal(classifyTimeliness({ ...base, deltaSeconds: -60, excludedReason: null }).outcome, 'on_time');
  assert.deepEqual(classifyTimeliness({ ...base, deltaSeconds: null, excludedReason: 'no_due_date' }).outcome, 'unknown', 'a missing date is unknown, never late');
  assert.equal(classifyTimeliness({ ...base, deltaSeconds: 3600, excludedReason: null, appealStatus: 'in_review' }).limitation?.reasonCode, 'excluded_appeal_pending');
  assert.equal(classifyTimeliness({ ...base, deltaSeconds: 3600, excludedReason: null, appealStatus: 'upheld' }).counted, true, 'an upheld appeal leaves the observation counted');
  const summary = summarizeTimeliness([{ kind: 'delivery', ...late }, { kind: 'delivery', ...excused }, { kind: 'payment', ...classifyTimeliness({ ...base, deltaSeconds: 0, excludedReason: null }) }]);
  assert.deepEqual(summary, { counted: 2, onTime: 1, late: 1, excluded: { excluded_client_caused_change: 1 }, byKind: { delivery: { counted: 1, onTime: 0, late: 1 }, payment: { counted: 1, onTime: 1, late: 0 } } });
});

test('every automated limitation carries a reason code, an explanation key and an appeal link; the registry matches the database', () => {
  const ref = { scope: 'confirmation_request' as const, requester: { kind: 'company' as const, id: 'c1' }, addressedTo: { kind: 'person' as const, id: 'p1' }, context: { kind: 'agreement' as const, id: 'a1' }, statementKind: 'delivered' as const };
  for (const code of LIMITATION_REASON_CODES) {
    const byRef = buildLimitation(code, { evidence: [{ kind: 'agreement', id: 'a1' }], limitation: { ...ref, reasonCode: code } });
    const bySubject = buildLimitation(code, { evidence: [], subject: { kind: 'timeliness_observation', id: 't1' } });
    for (const l of [byRef, bySubject]) {
      assert.equal(l.reasonCode, code);
      assert.equal(l.explanationKey, `reputation.limitation.${code}`);
      assert.equal(l.appeal.method, 'POST');
      assert.ok(l.appeal.href.startsWith('/v1/reputation-builder/'), `${code} has an appeal path`);
      assert.ok((LIMITATION_REASONS[code].scopes as readonly string[]).includes(l.scope) || l.scope === 'confirmation_request');
    }
  }
  const check = /reason_code text NOT NULL CHECK \(reason_code IN \(([^)]*)\)\)/.exec(MIGRATION)?.[1] ?? '';
  assert.deepEqual([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(), [...LIMITATION_REASON_CODES].sort());
  // The refusals the database raises are exactly the request and response limitations plus state conflicts.
  const raised = new Set([...functionBody('reputation_request_refusal').matchAll(/RETURN '([a-z_]+)'/g)].map((m) => m[1]!));
  for (const code of raised) assert.ok(code === 'not_authorised' || LIMITATION_REASON_CODES.includes(code as never), `${code} is a registered limitation`);
});

test('no input from activity tracking or per-employee metrics: derivation reads canonical records only', () => {
  const derive = functionBody('reputation_derive');
  const tables = new Set([...derive.matchAll(/(?:FROM|JOIN)\s+trustwork\.([a-z_]+)(?!\()/g)].map((m) => m[1]!));
  const written = new Set([...derive.matchAll(/INSERT INTO trustwork\.([a-z_]+)/g)].map((m) => m[1]!));
  assert.deepEqual([...written].sort(), ['contribution_record', 'timeliness_observation']);
  for (const table of tables) assert.ok((REPUTATION_DERIVATION_SOURCES as readonly string[]).includes(table), `${table} is a canonical source`);
  for (const forbidden of FORBIDDEN_REPUTATION_INPUTS) assert.ok(!new RegExp(`trustwork\\.${forbidden}\\b`).test(derive), `${forbidden} is never an input`);
  assert.doesNotMatch(derive, /membership|current_company_id/, 'the subject is the party, never an employee resolved through a membership');
  for (const [kind, source] of Object.entries(CONTRIBUTION_SOURCES)) {
    if (source.status === 'live') assert.match(derive, new RegExp(`'${kind}'`), `${kind} is derived`);
    else assert.doesNotMatch(derive, new RegExp(`'${kind}'`), `${kind} waits for its source module`);
  }
});

test('payment and staff blindness by construction: the module reads no billing, entitlement or staff table and has no score', () => {
  const dir = 'apps/api/src/modules/reputation';
  const sources = [...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(dir, f), 'utf8')), readFileSync('packages/data/src/repositories/reputation.ts', 'utf8'),
    readFileSync('packages/contracts/src/reputation-builder.ts', 'utf8'), MIGRATION.replace(/--.*$/gm, '')].join('\n');
  assert.doesNotMatch(sources, /\b(billing|entitlement|subscription|sponsor|credit_grant|staff_role_assignment|feature_flag)\w*['".]/i);
  assert.doesNotMatch(sources, /modules\/billing|repositories\/billing|repositories\/admin/);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /\bscore\b/i, 'no score column or computation');
});

test('capability registry: every operation for the interface and the agent; answers and appeals are human-only', () => {
  const caps = REPUTATION_BUILDER_MANIFEST.capabilities;
  assert.deepEqual(parityGaps(caps), []);
  const answer = caps.find((c) => c.id === 'reputation_builder.answer_confirmation_request')!;
  assert.ok(HUMAN_ONLY_ACTIONS.includes(answer.mandateAction!));
  assert.equal(answer.confirmation, 'person_each');
  assert.ok(!answer.surfaces.includes('mcp'), 'connections never confirm work');
  for (const c of caps.filter((x) => x.kind === 'commit')) assert.equal(c.confirmation, 'person_each', `${c.id} is confirmed by the person in this slice`);
  for (const c of caps) assert.equal(c.budgetKind, null, 'nothing here spends money or can be bought');
});

test('the fake register is deterministic, and an unanswered lookup is unavailable, never a failure', async () => {
  const register = new FakeCredentialRegister();
  const q = (number: string | null) => ({ jurisdiction: 'US-CA', credentialType: 'US-CA-CSLB-B', issuer: 'Synthetic board', number });
  assert.deepEqual(await register.lookup(q('SYN-OK-2030-01-31-9')), { outcome: 'match', validUntil: '2030-01-31', sourceRef: 'synthetic:US-CA:US-CA-CSLB-B' });
  assert.equal((await register.lookup(q('SYN-REV-1'))).outcome, 'revoked');
  assert.equal((await register.lookup(q('SYN-SUSP-1'))).outcome, 'suspended');
  assert.equal((await register.lookup(q('SYN-WRONG-1'))).outcome, 'mismatch');
  assert.equal((await register.lookup(q(null))).outcome, 'not_found');
  const hanging = { code: 'fake.hanging', lookup: () => new Promise<never>(() => undefined) };
  assert.equal((await boundedLookup(hanging, q('x'), 20)).outcome, 'unavailable');
  const failing = { code: 'fake.failing', lookup: () => Promise.reject(new Error('down')) };
  assert.equal((await boundedLookup(failing, q('x'), 20)).outcome, 'unavailable');
});
