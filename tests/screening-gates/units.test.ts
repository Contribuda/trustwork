import test from 'node:test';
import assert from 'node:assert/strict';
import type { DataPool } from '@trustwork/data';
import {
  COUNTERPARTY_FORBIDDEN_GATE_KEYS, dealSubjects, gateVerdict, SCREENING_GATE_ERROR_CODES, SCREENING_GATE_ERROR_STATUS, SCREENING_GATE_PURPOSES, type GateState, type GateSubject,
} from '../../packages/contracts/src/screening-gates.js';
import { SCREENING_HOLD_REASONS, type ScreeningHoldReason } from '../../packages/contracts/src/sanctions.js';
import { gateRefusal, ScreeningGate } from '../../apps/api/src/modules/screening-gates/gate.js';
import { GATED_AGENT_ACTIONS, ScreenedMandates } from '../../apps/api/src/modules/screening-gates/mandates.js';
import { PayoutGate } from '../../apps/api/src/modules/screening-gates/payout.js';
import { LocalApiError, renderError } from '../../apps/api/src/common/errors.js';
import type { Transaction } from '../../apps/api/src/deps/data.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CO = '33333333-3333-4333-8333-333333333333';
const state = (id: string, kind: 'person' | 'company', reasons: ScreeningHoldReason[] = [], extra: Partial<GateState> = {}): GateState => ({
  subject: { kind, id }, moneyHeld: reasons.length > 0, suspended: reasons.includes('confirmed'), reasons, appealable: reasons.includes('confirmed'), placeHold: false, ...extra,
});
const subjects: GateSubject[] = [{ subject: { kind: 'company', id: CO }, side: 'own' }, { subject: { kind: 'person', id: A }, side: 'own' }, { subject: { kind: 'person', id: B }, side: 'counterparty' }];
const clear = [state(CO, 'company'), state(A, 'person'), state(B, 'person')];
const withState = (s: GateState) => clear.map((x) => (x.subject.id === s.subject.id ? s : x));
/** A pool whose every connection fails: the screening store cannot be reached. */
const deadPool = { connect: async () => { throw new Error('connection refused'); }, query: async () => { throw new Error('connection refused'); } } as unknown as DataPool;

test('gateVerdict: only clear subjects pass, the caller sees its own words, the counterparty nothing', () => {
  assert.deepEqual(gateVerdict(subjects, clear), { ok: true });
  // Fail closed: no subjects, no answer, a subject missing from the answer, lists unavailable.
  assert.equal((gateVerdict([], clear) as { code: string }).code, 'screening.unavailable');
  assert.equal((gateVerdict(subjects, null) as { code: string }).code, 'screening.unavailable');
  assert.equal((gateVerdict(subjects, clear.slice(0, 2)) as { code: string }).code, 'screening.unavailable');
  assert.deepEqual(gateVerdict(subjects, withState(state(B, 'person', ['lists_unavailable']))), { ok: false, code: 'screening.unavailable', details: {} });

  for (const reason of SCREENING_HOLD_REASONS.filter((r) => r !== 'lists_unavailable')) {
    // Each reason on the counterparty: one code, no detail at all.
    const counter = gateVerdict(subjects, withState(state(B, 'person', [reason])));
    assert.deepEqual(counter, { ok: false, code: 'commercial.counterparty_unavailable', details: {} }, reason);
    // The same reason on the caller's own person: its own status words.
    const own = gateVerdict(subjects, withState(state(A, 'person', [reason])));
    assert.equal(own.ok, false);
    assert.equal((own as { code: string }).code, 'screening.review_pending', reason);
    const keys = (own as { details: { messageKeys: string[] } }).details.messageKeys;
    assert.ok(keys.length > 0 && keys.every((k) => k.startsWith('screening.')), keys.join(','));
    // The caller's own company: words that point to the company's compliance page.
    const company = gateVerdict(subjects, withState(state(CO, 'company', [reason])));
    assert.deepEqual((company as { details: { messageKeys: string[] } }).details.messageKeys, ['screening.gate.companyPaused', 'screening.contact']);
  }
  assert.ok(((gateVerdict(subjects, withState(state(A, 'person', ['insufficient_name']))) as { details: { messageKeys: string[] } }).details.messageKeys).includes('screening.status.nameNeeded'));
  assert.ok(((gateVerdict(subjects, withState(state(A, 'person', ['review_pending']))) as { details: { messageKeys: string[] } }).details.messageKeys).includes('screening.status.review'));

  // Holds: the caller's own hold is jurisdiction.restricted; the counterparty's is indistinguishable from a match.
  assert.deepEqual(gateVerdict(subjects, withState(state(A, 'person', [], { placeHold: true }))), { ok: false, code: 'jurisdiction.restricted', details: {} });
  assert.deepEqual(gateVerdict(subjects, withState(state(B, 'person', [], { placeHold: true }))), gateVerdict(subjects, withState(state(B, 'person', ['confirmed']))));
  // The caller's own side comes first, so the caller learns what it can fix, and nothing about the other side.
  const both = gateVerdict(subjects, [state(CO, 'company'), state(A, 'person', ['not_screened']), state(B, 'person', ['confirmed'])]);
  assert.equal((both as { code: string }).code, 'screening.review_pending');
  assert.ok(!JSON.stringify(both).includes(B));
});

test('dealSubjects: both parties and the acting person, each once, on the right side', () => {
  assert.deepEqual(dealSubjects({ kind: 'person', id: A }, { kind: 'person', id: B }, A), [{ subject: { kind: 'person', id: A }, side: 'own' }, { subject: { kind: 'person', id: B }, side: 'counterparty' }]);
  assert.deepEqual(dealSubjects({ kind: 'company', id: CO }, { kind: 'person', id: B }, A), subjects);
  // An acting person who is also the counterparty (never in practice) stays on the own side.
  assert.deepEqual(dealSubjects({ kind: 'company', id: CO }, { kind: 'person', id: A }, A).map((s) => s.side), ['own', 'own']);
});

test('refusals render with fixed statuses; a counterparty refusal has no details and says nothing about screening', () => {
  assert.deepEqual([...SCREENING_GATE_ERROR_CODES].sort(), ['commercial.counterparty_unavailable', 'jurisdiction.restricted', 'screening.review_pending', 'screening.unavailable']);
  for (const code of SCREENING_GATE_ERROR_CODES) assert.ok(SCREENING_GATE_ERROR_STATUS[code] < 500, `${code} is a definite refusal, never an unknown outcome`);
  for (const purpose of SCREENING_GATE_PURPOSES) {
    const counter = renderError(gateRefusal({ ok: false, code: 'commercial.counterparty_unavailable', details: {} }, purpose), 'req-1');
    assert.equal(counter.status, 409);
    assert.deepEqual(Object.keys(counter.body).sort(), ['code', 'message', 'requestId']);
    const json = JSON.stringify(counter.body).toLowerCase();
    for (const word of ['screen', 'sanction', 'match', 'hold', 'list', 'review', 'compliance', purpose]) assert.ok(!json.includes(word), `${word} leaked: ${json}`);
    for (const key of COUNTERPARTY_FORBIDDEN_GATE_KEYS) assert.ok(!json.includes(`"${key.toLowerCase()}"`), key);
  }
  const own = renderError(gateRefusal({ ok: false, code: 'screening.review_pending', details: { subject: { kind: 'person', id: A }, messageKeys: ['screening.status.review'] } }, 'quote_send'), 'req-2');
  assert.equal(own.status, 403);
  assert.deepEqual((own.body as { details?: unknown }).details, { purpose: 'quote_send', subject: { kind: 'person', id: A }, messageKeys: ['screening.status.review'] });
  assert.equal(renderError(gateRefusal({ ok: false, code: 'screening.unavailable', details: {} }, 'payout'), 'r').status, 409);
  assert.equal(renderError(gateRefusal({ ok: false, code: 'jurisdiction.restricted', details: {} }, 'payout'), 'r').status, 451);
});

test('ScreeningGate refuses when the screening store cannot be read', async () => {
  const failing = { executeQuery: async () => { throw new Error('the screening store is unavailable'); } };
  const trx = { getExecutor: () => ({ ...failing }) } as unknown as Transaction;
  await assert.rejects(new ScreeningGate().requireTransactable(trx, subjects, 'order_place'), (e: unknown) => e instanceof LocalApiError && e.code === 'screening.unavailable');
  await assert.rejects(new ScreeningGate().requireTransactable(trx, [], 'order_place'), (e: unknown) => e instanceof LocalApiError && e.code === 'screening.unavailable');
});

test('ScreenedMandates: a commit action never reaches the mandate store while the principal cannot be checked; other actions pass', async () => {
  const seen: string[] = [];
  const inner = { allows: async (c: { personId: string; action: string }) => { seen.push(c.action); return true; } };
  const port = new ScreenedMandates(inner, deadPool);
  for (const action of GATED_AGENT_ACTIONS) {
    await assert.rejects(port.allows({ personId: A, action }), (e: unknown) => e instanceof LocalApiError && e.code === 'screening.unavailable');
  }
  assert.deepEqual(seen, []);
  assert.equal(await port.allows({ personId: A, action: 'negotiate' }), true);
  assert.equal(await port.allows({ personId: A, action: 'prepare' }), true);
  assert.deepEqual(seen, ['negotiate', 'prepare']);
});

test('PayoutGate: the provider is never called when the payout country or the payee cannot be checked', async () => {
  let calls = 0;
  const provider = async () => { calls += 1; return 'acct'; };
  const gate = new PayoutGate(deadPool);
  const trx = { getExecutor: () => ({ executeQuery: async () => { throw new Error('down'); } }) } as unknown as Transaction;
  const payee = { subject: { kind: 'person' as const, id: A }, payoutCountry: 'US', declaredBy: A };
  await assert.rejects(gate.guardPayout({ declarer: { personId: A, authzEpoch: 1 }, trx, payee, purpose: 'payout_account' }, provider), (e: unknown) => e instanceof LocalApiError && e.code === 'screening.unavailable');
  await assert.rejects(gate.guardPayout({ declarer: { personId: A, authzEpoch: 1 }, trx, payee: { ...payee, payoutCountry: 'cuba' }, purpose: 'payout' }, provider), /payout country/);
  await assert.rejects(gate.guardPayout({ declarer: { personId: B, authzEpoch: 1 }, trx, payee, purpose: 'payout' }, provider), /declaring person/);
  assert.equal(calls, 0);
});
