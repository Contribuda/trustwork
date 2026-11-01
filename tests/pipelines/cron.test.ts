import test from 'node:test';
import assert from 'node:assert/strict';
import { dueBetween, inWindow, nextRuns, parseCron } from '../../apps/worker/src/pipelines/cron.js';

test('cron fields: numbers, stars, ranges, lists and steps; invalid fields refuse', () => {
  const s = parseCron('*/15 2,14 1-5 * 1-5');
  assert.deepEqual([...s.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...s.hours], [2, 14]);
  assert.equal(s.daysRestricted && s.weekdaysRestricted, true);
  assert.ok(parseCron('0 0 * * 7').weekdays.has(0), 'Sunday is 0 or 7');
  for (const bad of ['60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '5-1 * * * *', '*/0 * * * *', '* * * *']) assert.throws(() => parseCron(bad), /./, bad);
});

test('due times are evaluated in the schedule time zone ("15 2 * * 1-5" in Chicago)', () => {
  // Monday 2026-11-02, 02:15 Central (CST, UTC-6) = 08:15 UTC.
  const due = dueBetween('15 2 * * 1-5', 'America/Chicago', new Date('2026-11-01T00:00:00Z'), new Date('2026-11-08T00:00:00Z'));
  assert.deepEqual(due.map((d) => d.toISOString()), ['2026-11-02T08:15:00.000Z', '2026-11-03T08:15:00.000Z', '2026-11-04T08:15:00.000Z', '2026-11-05T08:15:00.000Z', '2026-11-06T08:15:00.000Z']);
  // The same expression in Samarkand (UTC+5).
  assert.equal(nextRuns('0 6 * * *', 'Asia/Samarkand', new Date('2026-11-02T00:00:00Z'), 1)[0]!.toISOString(), '2026-11-02T01:00:00.000Z');
});

test('daylight saving: a skipped local time never runs, a repeated local hour runs once', () => {
  // US spring forward 2026-03-08: 02:30 local does not exist in New York.
  assert.deepEqual(dueBetween('30 2 * * *', 'America/New_York', new Date('2026-03-08T00:00:00Z'), new Date('2026-03-08T12:00:00Z')), []);
  // US fall back 2026-11-01: 01:30 local happens twice; it runs once, at the first occurrence (EDT, UTC-4).
  const fallBack = dueBetween('30 1 * * *', 'America/New_York', new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T12:00:00Z'));
  assert.deepEqual(fallBack.map((d) => d.toISOString()), ['2026-11-01T05:30:00.000Z']);
});

test('day-of-month and day-of-week: either matches when both are restricted', () => {
  const due = dueBetween('0 9 1 * 1', 'UTC', new Date('2026-06-01T00:00:00Z'), new Date('2026-06-16T00:00:00Z'));
  // 1 June 2026 is a Monday; Mondays 8 and 15 June also match.
  assert.deepEqual(due.map((d) => d.toISOString().slice(0, 10)), ['2026-06-01', '2026-06-08', '2026-06-15']);
});

test('windows: local days and spans, crossing midnight; no windows allows every time', () => {
  const windows = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '01:00', to: '05:00' }];
  assert.equal(inWindow(windows, 'America/Chicago', new Date('2026-11-02T08:15:00Z')), true, 'Monday 02:15 Central');
  assert.equal(inWindow(windows, 'America/Chicago', new Date('2026-11-02T20:15:00Z')), false, 'Monday 14:15 Central');
  assert.equal(inWindow(windows, 'America/Chicago', new Date('2026-11-01T08:15:00Z')), false, 'Sunday');
  const overnight = [{ days: ['fri'], from: '22:00', to: '02:00' }];
  assert.equal(inWindow(overnight, 'UTC', new Date('2026-11-06T23:00:00Z')), true, 'Friday 23:00');
  assert.equal(inWindow(overnight, 'UTC', new Date('2026-11-07T01:00:00Z')), true, 'Saturday 01:00 belongs to Friday night');
  assert.equal(inWindow(overnight, 'UTC', new Date('2026-11-07T23:00:00Z')), false, 'Saturday 23:00');
  assert.equal(inWindow([], 'UTC', new Date()), true);
});
