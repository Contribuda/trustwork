import test from 'node:test';
import assert from 'node:assert/strict';
import { orderCandidates, overall, regionResult, screeningResult, type RuleResult } from '../../apps/api/src/modules/sourcing/eligibility.js';
import { columnState } from '../../apps/api/src/modules/sourcing/levelling.js';
import type { QuoteVersionRow } from '../../apps/api/src/modules/sourcing/deps.js';

const now = new Date('2026-11-03T12:00:00Z');
const version = (over: Partial<QuoteVersionRow>) => ({ status: 'sent', stale_reason: null, rfq_version_id: 'current', valid_until: new Date('2027-01-01T00:00:00Z'), ...over }) as QuoteVersionRow;
const candidate = (supplierRecordId: string, eligibility: RuleResult, status: 'preferred' | 'approved' | 'prospect' | 'on_hold', createdAt = '2026-10-01T00:00:00.000Z') => ({ supplierRecordId, eligibility, status, createdAt });

test('a version is comparable only when sent, current, unflagged and valid', () => {
  assert.deepEqual(columnState(version({}), 'current', now), { comparable: true, staleReason: null });
  assert.deepEqual(columnState(version({ status: 'accepted' }), 'current', now), { comparable: true, staleReason: null });
  assert.deepEqual(columnState(version({ stale_reason: 'rfq_closed' }), 'current', now), { comparable: false, staleReason: 'rfq_closed' });
  assert.deepEqual(columnState(version({ rfq_version_id: 'older' }), 'current', now), { comparable: false, staleReason: 'rfq_amended' });
  assert.deepEqual(columnState(version({ status: 'superseded' }), 'current', now), { comparable: false, staleReason: null });
  assert.deepEqual(columnState(version({ status: 'withdrawn' }), 'current', now), { comparable: false, staleReason: null });
  assert.deepEqual(columnState(version({ valid_until: new Date('2026-11-01T00:00:00Z') }), 'current', now), { comparable: false, staleReason: null });
});

test('unknown is not failure: a region or a screening state nobody can read stays unknown', () => {
  const rule = { kind: 'region' as const, regions: ['US-CA'] };
  assert.equal(regionResult(rule, { regions: [] }), 'unknown');
  assert.equal(regionResult(rule, { regions: ['US-CA', 'US-NV'] }), 'pass');
  assert.equal(regionResult(rule, { regions: ['US-TX'] }), 'fail');
  assert.deepEqual((['clear', 'cannot_transact_now', 'not_screenable', 'unavailable'] as const).map(screeningResult), ['pass', 'fail', 'unknown', 'unknown']);
  assert.equal(overall([]), 'pass');
  assert.equal(overall(['pass', 'unknown']), 'unknown');
  assert.equal(overall(['unknown', 'fail', 'pass']), 'fail');
});

test('candidates: a failed rule goes last, then the buyer status, the oldest record and the id; unknown ranks with pass', () => {
  const items = [candidate('e', 'fail', 'preferred'), candidate('d', 'unknown', 'prospect'), candidate('c', 'pass', 'approved', '2026-10-02T00:00:00.000Z'), candidate('b', 'pass', 'approved'), candidate('a', 'unknown', 'approved')];
  assert.deepEqual(orderCandidates(items).map((i) => i.supplierRecordId), ['a', 'b', 'c', 'd', 'e']);
});

test('payment fields on a candidate change nothing: the order reads no plan, entitlement or sponsorship', () => {
  const free = [candidate('a', 'pass', 'approved'), candidate('b', 'pass', 'approved'), candidate('c', 'unknown', 'prospect')];
  const paid = free.map((c, i) => ({ ...c, sponsored: i === 2, subscriptionTier: i === 2 ? 'pro' : 'free', entitlementCount: i * 10 }));
  assert.deepEqual(orderCandidates(paid).map((c) => c.supplierRecordId), orderCandidates(free).map((c) => c.supplierRecordId));
});
