import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteResults, inboxView, userView, type NavigationDestination } from '../../../../apps/web/app/admin/_navigation/model.js';
import { DEFAULT_PREFERENCES, PREFERENCE_KEY, loadPreferences, parsePreferences, savePreferences, type PreferenceStorage } from '../../../../apps/web/app/admin/_navigation/preferences.js';
import { inboxCommand, requestInHub } from '../../../../apps/web/app/admin/hubs/[hub]/inbox/authority.js';
import { readAttempt, runAttempt } from '../../../../apps/web/app/admin/hubs/[hub]/inbox/attempt.js';
import { recordReceipt, readReceipt, type FixtureReceipt } from '../../../../apps/web/app/admin/hubs/[hub]/inbox/transaction.js';
import { consolePort } from '../../../../apps/web/app/admin/_data/index.js';
import type { CommandInput } from '../../../../apps/web/app/admin/_data/commands.js';
import { APPROVAL_REQUESTS, APPROVAL_DECISIONS } from '../../../../apps/web/app/admin/hubs/[hub]/approvals/_fixtures.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { HUB_US_ID } from '../../../../apps/web/app/admin/_fixtures/ids.js';

function storage(): PreferenceStorage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
}
const destinations: NavigationDestination[] = [
  { id: 'inbox', label: 'Approvals inbox', href: '/inbox', kind: 'section' },
  { id: 'identity', label: 'Edit hub identity', href: '/hub/identity#change', kind: 'command' },
];
const support: NavigationDestination = { id: 'support-lookup', label: 'Look up in Support', href: '/support', kind: 'section' };
const request = { demo: true as const, persona: 'hub-owner' as const, scenario: 'default' as const };
const legal = APPROVAL_REQUESTS.find((row) => row.id === 'rq-legal-privacy-2')!;
const input = (overrides: Partial<CommandInput> = {}): CommandInput => ({ command: 'approvals.decide', hubSlug: 'us-demo', setupToken: null, expectedRevision: HUBS.find((row) => row.hub.id === HUB_US_ID)!.hub.revision, reason: 'Synthetic review reason', fields: { requestId: legal.id, decision: 'approve', digest: legal.actionDigest.value }, ...overrides });

test('private queries produce only the authorized Support route, with no query interpolation', () => {
  for (const query of ['private@example.invalid', 'Synthetic Participant Name']) {
    assert.deepEqual(paletteResults(query, destinations, support), [support]);
    assert.deepEqual(paletteResults(query, destinations, null), []);
  }
  assert.deepEqual(paletteResults('> edit', destinations, support), [destinations[1]]);
  assert.deepEqual(paletteResults('> approve everything', destinations, support), []);
  assert.deepEqual(paletteResults('#private-object', destinations, support), []);
  assert.equal(inboxView('private@example.invalid'), 'waiting');
  assert.equal(userView('private-name'), 'people');
});

test('preferences strictly allow only enumerated nonpersonal device data and reset on actual scope change', () => {
  const local = storage();
  const first = loadPreferences(local, 'viewer-hub-a');
  assert.ok(savePreferences(local, 'viewer-hub-a', { ...first, views: ['inbox:mine'], singleKeys: false }));
  assert.deepEqual(loadPreferences(local, 'viewer-hub-a').views, ['inbox:mine']);
  for (const extra of [{ email: 'private@example.invalid' }, { query: 'private' }, { name: 'saved private search' }]) assert.equal(parsePreferences({ ...first, ...extra }), null);
  assert.equal(parsePreferences({ ...first, views: ['users:private-name'] }), null);
  assert.equal(parsePreferences({ ...first, views: ['inbox:mine', 'inbox:mine'] }), null);
  assert.deepEqual(loadPreferences(local, 'viewer-hub-b'), DEFAULT_PREFERENCES);
  assert.equal(savePreferences(local, 'viewer-hub-a', first), false, 'the stale identity tab cannot overwrite');
  assert.ok(!local.getItem(PREFERENCE_KEY)!.includes('viewer-hub-a'));
});

test('owning command authority denies self approval, wrong actor, role, hub, digest, revision, reason, expiry and live mode', async () => {
  const port = consolePort(true);
  assert.equal((await inboxCommand(port, request, input(), 'p-hub-owner')).status, 'demo_not_saved');
  assert.equal((await inboxCommand(port, request, input({ fields: { ...input().fields, decision: 'decline' } }), 'p-hub-owner')).status, 'demo_not_saved');
  assert.equal((await inboxCommand(port, { ...request, persona: 'compliance' }, input(), 'p-compliance') as { code: string }).code, 'own_request');
  for (const [req, actor, command] of [
    [request, 'p-compliance', input()],
    [{ ...request, persona: 'staff-none' as const }, 'p-staff-none', input()],
    [request, 'p-hub-owner', input({ hubSlug: 'samarkand' })],
    [{ ...request, scenario: 'elevation-required' as const }, 'p-hub-owner', input()],
  ] as const) assert.equal((await inboxCommand(port, req, command, actor)).status, 'not_found');
  assert.equal((await inboxCommand(port, request, input({ fields: { ...input().fields, digest: 'f'.repeat(64) } }), 'p-hub-owner') as { code: string }).code, 'digest_mismatch');
  assert.equal((await inboxCommand(port, request, input({ expectedRevision: -1 }), 'p-hub-owner') as { code: string }).code, 'stale');
  assert.equal((await inboxCommand(port, request, input({ reason: '' }), 'p-hub-owner') as { code: string }).code, 'reason_required');
  const expired = { ...port, approvals: async () => ({ ...(await port.approvals(HUB_US_ID)), requests: [{ ...legal, expiresAt: '2026-10-01T00:00:00Z' }] }) };
  // The original owning evaluator independently enforces expiry; composition never substitutes its decision.
  const { approvalBlocker } = await import('../../../../apps/web/app/admin/_data/commands.js');
  assert.equal(approvalBlocker((await expired.approvals()).requests[0]!, 'p-hub-owner', await port.access((await port.viewer(request))!, { nodeId: HUBS[0]!.hub.nodeId, hubId: HUB_US_ID }), port.now()), 'request_expired');
  assert.equal((await inboxCommand(consolePort(false), { demo: false }, input(), 'p-hub-owner')).status, 'not_found');
});

test('foreign request scope is narrowed before dispatch and reconciliation never issues a command', async () => {
  const port = consolePort(true);
  let calls = 0;
  const counting = { ...port, command: async (...args: Parameters<typeof port.command>) => { calls++; return port.command(...args); } };
  assert.equal((await inboxCommand(counting, request, input(), 'p-hub-owner', true)).status, 'demo_not_saved');
  assert.equal(calls, 0);
  const foreign = { ...legal, scope: { kind: 'hub' as const, hubId: 'another-hub' } };
  assert.equal(requestInHub(foreign, HUB_US_ID), false);
  const narrowed = { ...counting, approvals: async () => ({ ...(await port.approvals(HUB_US_ID)), requests: [foreign] }) };
  assert.equal((await inboxCommand(narrowed, request, input(), 'p-hub-owner')).status, 'not_found');
  assert.equal(calls, 0);
});

test('duplicate and lost-response attempts serialize before dispatch; refresh never replays an unknown mutation', async () => {
  const session = storage();
  let sends = 0;
  const id = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(runAttempt(session, 'attempt', id, async () => { sends++; throw new Error('Lost reply'); }));
  assert.deepEqual(readAttempt(session, 'attempt'), { id, state: 'unknown' });
  assert.equal(await runAttempt(session, 'attempt', id, async () => { sends++; }), false);
  assert.equal(sends, 1);
  session.removeItem('attempt');
  const results = await Promise.all([runAttempt(session, 'attempt', id, async () => { sends++; await Promise.resolve(); }), runAttempt(session, 'attempt', id, async () => { sends++; })]);
  assert.deepEqual(results, [true, false]);
  assert.equal(sends, 2);
});

test('synthetic receipts are session-scoped, idempotent for the exact operation and reject competing or foreign decisions', () => {
  const session = storage();
  const decision = APPROVAL_DECISIONS.find((row) => row.approval)!;
  const receipt: FixtureReceipt = { operationId: '00000000-0000-4000-8000-000000000001', digest: decision.approval!.actionDigest.value, decision };
  assert.deepEqual(recordReceipt(session, 'receipt', receipt, decision.decidedBy, decision.hubId, decision.requestId), receipt);
  assert.deepEqual(recordReceipt(session, 'receipt', receipt, decision.decidedBy, decision.hubId, decision.requestId), receipt);
  assert.throws(() => recordReceipt(session, 'receipt', { ...receipt, operationId: '00000000-0000-4000-8000-000000000002' }, decision.decidedBy, decision.hubId, decision.requestId));
  assert.throws(() => recordReceipt(session, 'elsewhere', receipt, decision.requestedBy, decision.hubId, decision.requestId));
  assert.throws(() => recordReceipt(session, 'elsewhere', receipt, decision.decidedBy, 'foreign', decision.requestId));
  assert.equal(readReceipt(storage(), 'receipt'), null);
});

test('stored receipts reject malformed records and preserve decision and approval invariants', () => {
  const decision = APPROVAL_DECISIONS.find((row) => row.approval)!;
  const approval = decision.approval!;
  const receipt: FixtureReceipt = { operationId: '00000000-0000-4000-8000-000000000001', digest: approval.actionDigest.value, decision };
  for (const valid of APPROVAL_DECISIONS) {
    const session = storage();
    const value = { ...receipt, decision: valid };
    assert.deepEqual(recordReceipt(session, 'receipt', value, valid.decidedBy, valid.hubId, valid.requestId), value);
    assert.deepEqual(readReceipt(session, 'receipt'), value);
  }
  const invalid: unknown[] = [
    { ...receipt, extra: true },
    { ...receipt, operationId: 'not-a-uuid' },
    { ...receipt, digest: 'not-a-digest' },
    ...[
      { extra: true }, { synthetic: false }, { requestId: '' }, { action: 'unknown.action' },
      { decidedAt: 'not-a-timestamp' }, { decidedBy: decision.requestedBy },
      { approval: null }, { decision: 'decline' },
      ...[
        { extra: true }, { requestedBy: 'another-requester' }, { approvedBy: 'another-approver' },
        { action: 'sponsored.enable' }, { scope: { kind: 'unknown' } },
        { expiresAt: approval.approvedAt },
      ].map((changes) => ({ approval: { ...approval, ...changes } })),
    ].map((changes) => ({ ...receipt, decision: { ...decision, ...changes } })),
  ];
  for (const value of invalid) {
    const session = storage();
    session.setItem('receipt', JSON.stringify(value));
    assert.throws(() => readReceipt(session, 'receipt'));
    assert.throws(() => recordReceipt(session, 'new-receipt', value as FixtureReceipt, decision.decidedBy, decision.hubId, decision.requestId));
    assert.equal(session.getItem('new-receipt'), null, 'invalid receipts never reach storage');
  }
});
