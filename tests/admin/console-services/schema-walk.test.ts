import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FORBIDDEN_CONTROL_WORDS } from '@trustwork/contracts';
import {
  ActiveFlagsQuerySchema, CONSOLE_REF_UUID, CONSOLE_VIEW_VOCABULARY, ConsoleSearchHitSchema, ConsoleSearchQuerySchema, ConsoleSearchResultSchema, ConsoleSavedViewSchema, ConsoleTargetQuerySchema, ConsoleViewConfigurationSchema, ConsoleViewsQuerySchema, ConsoleWorkCountSchema,
  ConsoleWorkItemSchema, ConsoleWorkListSchema, ConsoleWorkQuerySchema, CreateConsoleViewCommandSchema, FLAG_REFUSED_KEY, FLAG_SHARE_PERCENTS, parseConsoleRef, RemoveConsoleViewCommandSchema, SetConsoleNotificationsCommandSchema, SetFlagStageCommandSchema,
  UpdateConsoleViewCommandSchema,
} from '../../../packages/contracts/src/console-services.js';
import { flagBucket, flagInForce } from '../../../apps/api/src/modules/platform-admin/console-services/flag-buckets.js';
import { SetFlagCommandSchema } from '../../../apps/api/src/modules/platform-admin/schemas.js';

type Def = { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; innerType?: z.ZodType; options?: z.ZodType[]; valueType?: z.ZodType; keyType?: z.ZodType; checks?: unknown[]; format?: string };
const defOf = (schema: z.ZodType) => (schema as unknown as { def: Def }).def;
const children = (d: Def): z.ZodType[] => [...Object.values(d.shape ?? {}), ...(d.element ? [d.element] : []), ...(d.innerType ? [d.innerType] : []), ...(d.options ?? []), ...(d.valueType ? [d.valueType] : []), ...(d.keyType ? [d.keyType] : [])];

/** Every field name of a schema, and every leaf with the path that reaches it. */
function walk(schema: z.ZodType, path: string, visit: (path: string, leaf: z.ZodType) => void, names: string[] = []): string[] {
  const d = defOf(schema);
  if (d.type === 'object') for (const [key, value] of Object.entries(d.shape ?? {})) { names.push(key); walk(value, `${path}.${key}`, visit, names); }
  else if (children(d).length) for (const child of children(d)) walk(child, path, visit, names);
  else visit(path, schema);
  return names;
}

/** A string leaf is closed when it is a format or carries a pattern: nothing typed by a person fits it. */
function closed(leaf: z.ZodType): boolean {
  const d = defOf(leaf);
  if (d.type !== 'string') return ['enum', 'literal', 'int', 'number', 'boolean', 'null'].includes(d.type);
  if (d.format) return true;
  return (d.checks ?? []).some((check) => {
    const inner = check as { _zod?: { def?: { check?: string; format?: string } } };
    return inner._zod?.def?.format === 'regex' || inner._zod?.def?.check === 'string_format';
  });
}

const PERSONAL = /(name|email|mail|phone|address|summary|title|reason|purpose|description|note|text|comment|message|subject|requester|holder|appellant|label|detail|query)/i;
/** Reason as the *code* of why a row is the viewer's is the one word this file uses for something else. */
const ALLOWED_NAMES = new Set(['reason', 'requestedBy']);

test('ADM-005 acceptance: no hit or work item can carry free text or a personal field (schema walk)', () => {
  assert.equal(closed(z.string().min(1).max(500)), false, 'the walker tells a free string from a closed one');
  assert.equal(closed(z.string().regex(/^a$/)), true);
  for (const [what, schema] of Object.entries({ ConsoleSearchResultSchema, ConsoleSearchHitSchema, ConsoleWorkListSchema, ConsoleWorkItemSchema, ConsoleWorkCountSchema })) {
    const leaves: string[] = [];
    const names = walk(schema as z.ZodType, what, (path, leaf) => {
      leaves.push(path);
      assert.ok(closed(leaf), `${path} is a free value (${defOf(leaf).type})`);
    });
    assert.ok(leaves.length >= 2, `${what} walked`);
    for (const name of names) assert.ok(ALLOWED_NAMES.has(name) || !PERSONAL.test(name), `${what}: field "${name}"`);
  }
});

test('ADM-005 acceptance: a work item\'s `reason` is a code and `requestedBy` an identifier, never text', () => {
  assert.equal(ConsoleWorkItemSchema.safeParse({ kind: 'approval', id: randomUUID(), scope: { kind: 'platform' }, state: 'pending', action: null, severity: null, role: null, requestedBy: 'Maria Petrova', at: new Date().toISOString(), expiresAt: null, reason: { code: 'assigned_to_you' } }).success, false);
  assert.equal(ConsoleWorkItemSchema.safeParse({ kind: 'approval', id: randomUUID(), scope: { kind: 'platform' }, state: 'pending', action: null, severity: null, role: null, requestedBy: null, at: new Date().toISOString(), expiresAt: null, reason: 'because Maria asked' }).success, false);
  assert.equal(ConsoleSearchHitSchema.safeParse({ kind: 'incident', id: randomUUID(), scope: { kind: 'platform' }, incidentKind: 'content', severity: 'sev1', status: 'open', title: 'Synthetic' }).success, false, 'strict: an extra title is refused');
  assert.equal(ConsoleSearchHitSchema.safeParse({ kind: 'staff', id: randomUUID(), scope: { kind: 'platform' }, displayName: 'Synthetic' }).success, false, 'a staff hit is an identifier');
});

test('ADM-005 acceptance: a search request has one field that can hold text, and it only admits identifiers', () => {
  const names = walk(ConsoleSearchQuerySchema, 'query', () => undefined);
  assert.deepEqual(names.sort(), ['hubId', 'nodeId', 'ref']);
  for (const refused of ['maria@example.invalid', 'Maria', 'Maria Petrova', 'maria petrova', '+15550100123', '555-0100', '(555) 0100', 'a', '0123', '', ' ', 'SELECT 1', `${randomUUID()} `, randomUUID().toUpperCase(), '1234567890123456', `${'x'.repeat(82)}`]) {
    assert.equal(ConsoleSearchQuerySchema.safeParse({ ref: refused }).success, false, refused);
    assert.equal(parseConsoleRef(refused), null, refused);
  }
  const id = randomUUID();
  assert.deepEqual(parseConsoleRef(id), { kind: 'id', id });
  assert.deepEqual(parseConsoleRef('42'), { kind: 'number', number: '42' });
  assert.deepEqual(parseConsoleRef('ui.dense_tables'), { kind: 'key', key: 'ui.dense_tables' });
  assert.equal(ConsoleSearchQuerySchema.safeParse({ ref: id, email: 'x' }).success, false, 'strict');
});

test('no request schema of this module carries a ranking word (ADM-001 guard rail)', () => {
  const requests = { ConsoleSearchQuerySchema, ConsoleTargetQuerySchema, ConsoleViewsQuerySchema, ConsoleWorkQuerySchema, CreateConsoleViewCommandSchema, UpdateConsoleViewCommandSchema, RemoveConsoleViewCommandSchema, SetConsoleNotificationsCommandSchema, SetFlagStageCommandSchema, ActiveFlagsQuerySchema };
  for (const [what, schema] of Object.entries(requests)) {
    for (const name of walk(schema as z.ZodType, what, () => undefined)) assert.ok(!FORBIDDEN_CONTROL_WORDS.test(name), `${what}.${name}`);
  }
});

test('a saved view holds only what its surface lists: nothing typed, no identifier, however it is dressed up', () => {
  const ok = { filters: { state: ['open'] }, columns: ['number', 'state'], sort: { column: 'openedAt', direction: 'descending' } };
  const command = { contractVersion: '1.0.0', idempotencyKey: 'view-key-1', reason: 'Synthetic', scope: { kind: 'platform' }, surface: 'support:cases', configuration: ok, teamRole: null, isDefault: false };
  const accepted = (configuration: unknown, extra: object = {}) => CreateConsoleViewCommandSchema.safeParse({ ...command, name: 'Open cases', configuration, ...extra }).success;
  assert.equal(accepted(ok), true);
  assert.equal(accepted({ ...ok, query: 'maria' }), false, 'no search text');
  const hexId = randomUUID().replaceAll('-', '');
  for (const value of ['Maria.Petrova', 'maria.petrova', 'maria-petrova', '1555-0100-123', 'maria:example.invalid', 'maria@example.invalid', 'Maria Petrova', '+15550100123', '15550100123', hexId, randomUUID(), 'a b', '']) {
    for (const teamRole of [null, 'moderator']) {
      assert.equal(accepted({ ...ok, filters: { state: [value] } }, { teamRole }), false, `value ${value}`);
      assert.equal(accepted({ ...ok, filters: { actor: [value] } }, { teamRole }), false, `actor ${value}`);
    }
  }
  assert.equal(accepted({ ...ok, filters: { mariaPetrova: ['open'] } }), false, 'a filter this surface does not have');
  assert.equal(accepted({ ...ok, filters: { constructor: ['open'] } }), false, 'not a property of every object');
  assert.equal(accepted({ ...ok, filters: { stage: ['off'] } }), false, 'a filter of another surface');
  assert.equal(accepted({ ...ok, columns: ['mariaPetrova'] }), false, 'a column cannot carry a word');
  assert.equal(accepted({ ...ok, sort: { column: 'mariaPetrova', direction: 'ascending' } }), false, 'nor can a sort');
  for (const name of ['maria@example.invalid', 'Call 555 0100 123', 'Mine +1 (555) 010-0123', '   ']) assert.equal(CreateConsoleViewCommandSchema.safeParse({ ...command, name }).success, false, name);
  assert.ok(!walk(ConsoleSavedViewSchema, 'view', () => undefined).some((name) => /owner|person/i.test(name)), 'who owns a team view is not shown');
  for (const [surface, { filters, columns }] of Object.entries(CONSOLE_VIEW_VOCABULARY)) {
    const values = [...Object.keys(filters), ...Object.values(filters).flat(), ...columns] as string[];
    assert.ok(columns.length > 0, surface);
    assert.ok(values.every((value) => !/@|\s/.test(value) && !CONSOLE_REF_UUID.test(value)), surface);
    assert.ok(Object.entries(filters).every(([key, list]) => ConsoleViewConfigurationSchema.safeParse({ filters: { [key]: [...(list as readonly string[])] }, columns: [...columns], sort: null }).success), `${surface}: its own list fits the shape`);
  }
});

test('ADM-005: a flag key cannot be about ranking, matching, reputation or payment', () => {
  const flag = { contractVersion: '1.0.0', idempotencyKey: 'flag-key-1', reason: 'Synthetic', scope: { kind: 'hub', hubId: randomUUID() }, value: true, description: 'Synthetic', declaredEffect: 'ui', expiresAt: new Date().toISOString() };
  for (const key of ['matching.v2', 'ranking.boost_off', 'payment.new_form', 'payments.v2', 'reputation.decay', 'ui.payment_form', 'ui.matching_panel', 'directory.rank_b', 'payout.batch_b', 'sponsored.slots', 'recommendations.rule_b']) {
    assert.ok(FLAG_REFUSED_KEY.test(key), key);
    assert.equal(SetFlagCommandSchema.safeParse({ ...flag, key }).success, false, key);
  }
  for (const key of ['ui.dense_tables', 'ops.dispatch_batching', 'ops.payload_size', 'retrieval.rerank_model_b']) {
    assert.ok(!FLAG_REFUSED_KEY.test(key), key);
    assert.equal(SetFlagCommandSchema.safeParse({ ...flag, key }).success, true, key);
  }
  assert.equal(SetFlagCommandSchema.safeParse({ ...flag, key: 'ui.variant', value: 'matching_b' }).success, false, 'nor its value');
});

test('ADM-005 acceptance: a flag stage cannot name a person, a company, a session or a list of them', () => {
  const names = walk(SetFlagStageCommandSchema, 'stage', () => undefined);
  assert.deepEqual(names.filter((n) => !['contractVersion', 'idempotencyKey', 'reason'].includes(n)).sort(), ['expectedRevision', 'sharePercent', 'stage']);
  const base = { contractVersion: '1.0.0', idempotencyKey: 'stage-key-1', reason: 'Synthetic', expectedRevision: 1 };
  assert.equal(SetFlagStageCommandSchema.safeParse({ ...base, stage: 'share', sharePercent: 5 }).success, true);
  for (const extra of [{ personId: randomUUID() }, { personIds: [randomUUID()] }, { companyId: randomUUID() }, { sessionId: randomUUID() }, { segment: 'beta' }, { targets: [] }, { allow: [] }]) {
    assert.equal(SetFlagStageCommandSchema.safeParse({ ...base, stage: 'on', sharePercent: null, ...extra }).success, false, JSON.stringify(extra));
  }
  for (const share of [0, 2, 10, 33, 51, 100, 0.5]) assert.equal(SetFlagStageCommandSchema.safeParse({ ...base, stage: 'share', sharePercent: share }).success, false, String(share));
  assert.equal(SetFlagStageCommandSchema.safeParse({ ...base, stage: 'share', sharePercent: null }).success, false, 'a share names its percent');
  assert.equal(SetFlagStageCommandSchema.safeParse({ ...base, stage: 'on', sharePercent: 5 }).success, false, 'only a share has one');
});

test('a bucket is deterministic, spread evenly and nested across shares, and each flag draws its own people', () => {
  const flag = randomUUID();
  const people = Array.from({ length: 20_000 }, () => randomUUID());
  const person = people[0] as string;
  assert.equal(flagBucket(flag, person), flagBucket(flag, person), 'stable for a person');
  for (const share of FLAG_SHARE_PERCENTS) {
    const inside = people.filter((personId) => flagInForce({ id: flag, stage: 'share', sharePercent: share }, { personId, staff: false })).length;
    assert.ok(Math.abs(inside / people.length - share / 100) < 0.01, `${share} percent gave ${inside}`);
  }
  const small = new Set(people.filter((id) => flagBucket(flag, id) < 5));
  const wide = new Set(people.filter((id) => flagBucket(flag, id) < 25));
  assert.ok([...small].every((id) => wide.has(id)), 'widening only adds people');
  const other = randomUUID();
  assert.ok(people.slice(0, 200).some((id) => flagBucket(flag, id) !== flagBucket(other, id)), 'each flag draws its own people');
});

test('stages decide what is in force, and being staff matters only for staff only', () => {
  const reader = { personId: randomUUID(), staff: true };
  const id = randomUUID();
  assert.equal(flagInForce({ id, stage: 'off', sharePercent: null }, reader), false);
  assert.equal(flagInForce({ id, stage: 'staff_only', sharePercent: null }, reader), true);
  assert.equal(flagInForce({ id, stage: 'staff_only', sharePercent: null }, { ...reader, staff: false }), false);
  assert.equal(flagInForce({ id, stage: 'on', sharePercent: null }, { ...reader, staff: false }), true);
  const out = Array.from({ length: 2000 }, () => randomUUID()).find((personId) => flagBucket(id, personId) >= 50) as string;
  assert.equal(flagInForce({ id, stage: 'share', sharePercent: 50 }, { personId: out, staff: true }), false, 'a share does not widen for staff');
});
