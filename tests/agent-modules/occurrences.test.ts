import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OccurrenceReferenceSchema, OccurrenceSourceSchema, occurrenceKey, pendingDeadlines } from '../../apps/api/src/modules/agent-modules/occurrences.js';

test('source identities distinguish same-instant events and requests while replay retains the same key', () => {
  const subscription = randomUUID();
  const id = randomUUID();
  const event = { kind: 'event', eventId: id } as const;
  assert.equal(occurrenceKey(subscription, event), occurrenceKey(subscription, event));
  assert.notEqual(occurrenceKey(subscription, event), occurrenceKey(subscription, { ...event, eventId: randomUUID() }));
  assert.notEqual(occurrenceKey(subscription, event), occurrenceKey(subscription, { kind: 'request', operationId: id }));
  assert.notEqual(occurrenceKey(subscription, event), occurrenceKey(randomUUID(), event));
});

test('schedule identity uses the normalized instant and exact subscription revision', () => {
  const subscription = randomUUID();
  const source = { kind: 'schedule', subscriptionRevision: 1, scheduledAt: '2026-11-01T01:30:00-04:00' } as const;
  assert.equal(occurrenceKey(subscription, source), occurrenceKey(subscription, { ...source, scheduledAt: '2026-11-01T05:30:00.000Z' }));
  assert.notEqual(occurrenceKey(subscription, source), occurrenceKey(subscription, { ...source, scheduledAt: '2026-11-01T01:30:00-05:00' }));
  assert.notEqual(occurrenceKey(subscription, source), occurrenceKey(subscription, { ...source, subscriptionRevision: 2 }));
});

test('references reject forged principal, hub, mandate, action and untrusted text', () => {
  for (const key of ['personId', 'hubId', 'mandateId', 'action', 'prompt', 'note']) {
    assert.equal(OccurrenceReferenceSchema.safeParse({ occurrenceId: randomUUID(), [key]: randomUUID() }).success, false);
    assert.equal(OccurrenceSourceSchema.safeParse({ kind: 'event', eventId: randomUUID(), [key]: randomUUID() }).success, false);
  }
  assert.equal(OccurrenceSourceSchema.safeParse({ kind: 'event', eventId: 'free text' }).success, false);
});

test('deadline offsets are complete and deduplicated, survive restart, and never alias a replacement revision', () => {
  const subscription = randomUUID();
  const projection = { contextKind: 'goal' as const, contextId: randomUUID(), deadlineKey: 'horizon', revision: 1, calendarVersionId: randomUUID(), deadline: new Date('2026-11-02T17:00:00Z'), timeZone: 'America/New_York' };
  const trigger = { kind: 'deadline' as const, contextKind: 'goal' as const, offsetsDays: [0, 7, 1, 7] };
  const first = pendingDeadlines(subscription, trigger, projection);
  assert.deepEqual(first.map((x) => x.source.offsetDays), [7, 1, 0]);
  assert.deepEqual(first.map((x) => x.dueAt.toISOString()), ['2026-10-26T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z']);
  assert.deepEqual(pendingDeadlines(subscription, trigger, projection), first);
  const replacement = pendingDeadlines(subscription, trigger, { ...projection, revision: 2 });
  assert.ok(replacement.every((x) => first.every((old) => old.key !== x.key)));
  assert.notEqual(pendingDeadlines(subscription, trigger, { ...projection, calendarVersionId: randomUUID() })[0]!.key, first[0]!.key);
});

test('deadline offsets preserve local 09:00 across spring DST without subtracting 24-hour days', () => {
  const items = pendingDeadlines(randomUUID(), { kind: 'deadline', contextKind: 'project', offsetsDays: [0, 1, 2] }, {
    contextKind: 'project', contextId: randomUUID(), deadlineKey: 'completion', revision: 3, calendarVersionId: randomUUID(),
    deadline: new Date('2027-03-15T17:00:00Z'), timeZone: 'America/New_York',
  });
  assert.deepEqual(items.map((x) => x.dueAt.toISOString()), ['2027-03-13T14:00:00.000Z', '2027-03-14T13:00:00.000Z', '2027-03-15T13:00:00.000Z']);
});
