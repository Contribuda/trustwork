import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_STALE_AFTER_MAX_SECONDS, listFreshnessState, screeningAvailability, ScreeningAvailabilitySchema, type ScreeningListFreshness } from '../../packages/contracts/src/sanctions.js';

const DAY = 86_400;
const checked = new Date('2026-10-01T00:00:00Z');
const at = (days: number) => new Date(checked.getTime() + days * DAY * 1000);
const list = { status: 'active' as const, baseline: true, hasActiveVersion: true, lastCheckedAt: checked, warnAfterSeconds: 3 * DAY, staleAfterSeconds: 7 * DAY };

test('clock: a list moves from fresh to warning to stale as its confirmation ages', () => {
  assert.equal(listFreshnessState(list, at(1)), 'fresh');
  assert.equal(listFreshnessState(list, at(3)), 'fresh', 'exactly the warning age is still fresh');
  assert.equal(listFreshnessState(list, at(3.5)), 'warning');
  assert.equal(listFreshnessState(list, at(7)), 'warning');
  assert.equal(listFreshnessState(list, at(7.01)), 'stale');
  assert.equal(listFreshnessState({ ...list, hasActiveVersion: false }, at(0)), 'missing');
  assert.equal(listFreshnessState({ ...list, lastCheckedAt: null }, at(0)), 'missing');
  assert.equal(listFreshnessState({ ...list, baseline: false, status: 'paused' }, at(0)), 'paused');
  assert.equal(listFreshnessState({ ...list, status: 'paused' }, at(0)), 'fresh', 'a baseline list is never paused');
  assert.equal(listFreshnessState({ ...list, staleAfterSeconds: 30 * DAY, warnAfterSeconds: 20 * DAY }, at(15)), 'stale', 'the engine bound caps a baseline at 14 days');
  assert.equal(BASELINE_STALE_AFTER_MAX_SECONDS, 14 * DAY);
});

const row = (code: string, state: ScreeningListFreshness['state'], baseline = true): ScreeningListFreshness => ({
  listId: `list-${code}`, hubId: baseline ? null : 'hub-1', code, baseline, status: state === 'paused' ? 'paused' : 'active', state,
  activeVersionId: state === 'missing' ? null : `v-${code}`, publishedOn: null, lastCheckedAt: state === 'missing' ? null : checked.toISOString(), ageSeconds: state === 'missing' ? null : 0,
  warnAfterSeconds: 3 * DAY, staleAfterSeconds: 7 * DAY,
});

test('clock: a stale baseline makes screening unavailable; an additional list does not decide availability', () => {
  const fresh = screeningAvailability([row('ofac-sdn', 'fresh'), row('ofac-cons', 'warning'), row('un-sc', 'stale', false)], at(0));
  assert.equal(fresh.available, true);
  assert.ok(ScreeningAvailabilitySchema.safeParse(fresh).success);
  const stale = screeningAvailability([row('ofac-sdn', 'stale'), row('ofac-cons', 'fresh')], at(0));
  assert.equal(stale.available, false);
  assert.deepEqual(stale.reasons, [{ reason: 'baseline_stale', code: 'ofac-sdn' }]);
  assert.deepEqual(screeningAvailability([row('ofac-sdn', 'missing'), row('ofac-cons', 'fresh')], at(0)).reasons, [{ reason: 'baseline_missing', code: 'ofac-sdn' }]);
  assert.deepEqual(screeningAvailability([], at(0)), { available: false, checkedAt: at(0).toISOString(), reasons: [{ reason: 'no_baseline', code: null }], lists: [] });
});
