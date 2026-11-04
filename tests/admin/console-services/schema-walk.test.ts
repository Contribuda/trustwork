import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FORBIDDEN_CONTROL_WORDS } from '@trustwork/contracts';
import {
  ActiveFlagsQuerySchema, ConsoleSearchHitSchema, ConsoleSearchQuerySchema, ConsoleSearchResultSchema, ConsoleSavedViewSchema, ConsoleTargetQuerySchema, ConsoleViewConfigurationSchema, ConsoleViewsQuerySchema, ConsoleWorkCountSchema,
  ConsoleWorkItemSchema, ConsoleWorkListSchema, ConsoleWorkQuerySchema, CreateConsoleViewCommandSchema, FLAG_SHARE_PERCENTS, parseConsoleRef, RemoveConsoleViewCommandSchema, SetConsoleNotificationsCommandSchema, SetFlagStageCommandSchema,
  UpdateConsoleViewCommandSchema,
} from '../../../packages/contracts/src/console-services.js';
import { flagBucket, flagInForce } from '../../../apps/api/src/modules/platform-admin/console-services/flag-buckets.js';

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

test('a saved view stores no search text, and a filter value cannot be a name, an address or a telephone number', () => {
  const ok = { filters: { state: ['open'], role: ['support-agent'] }, columns: ['id', 'state'], sort: { column: 'at', direction: 'descending' } };
  assert.equal(ConsoleViewConfigurationSchema.safeParse(ok).success, true);
  assert.equal(ConsoleViewConfigurationSchema.safeParse({ ...ok, query: 'maria' }).success, false, 'no search text');
  for (const value of ['maria@example.invalid', 'Maria Petrova', '+15550100123', '15550100123', 'a b', '']) {
    assert.equal(ConsoleViewConfigurationSchema.safeParse({ ...ok, filters: { actor: [value] } }).success, false, value);
  }
  const command = { contractVersion: '1.0.0', idempotencyKey: 'view-key-1', reason: 'Synthetic', scope: { kind: 'platform' }, surface: 'flags', configuration: ok, teamRole: null, isDefault: false };
  assert.equal(CreateConsoleViewCommandSchema.safeParse({ ...command, name: 'Open flags' }).success, true);
  for (const name of ['maria@example.invalid', 'Call 555 0100 123', 'Mine +1 (555) 010-0123', '   ']) assert.equal(CreateConsoleViewCommandSchema.safeParse({ ...command, name }).success, false, name);
  // An identifier may sit in a personal view, never in one shared with a team.
  const pinned = { ...ok, filters: { actor: [randomUUID()] } };
  assert.equal(CreateConsoleViewCommandSchema.safeParse({ ...command, name: 'Pinned', configuration: pinned }).success, true);
  assert.equal(CreateConsoleViewCommandSchema.safeParse({ ...command, name: 'Pinned', configuration: pinned, teamRole: 'moderator' }).success, false);
  assert.ok(!walk(ConsoleSavedViewSchema, 'view', () => undefined).some((name) => /owner|person/i.test(name)), 'who owns a team view is not shown');
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

test('a bucket is deterministic, spread evenly, nested across shares, and does not follow a person from session to session', () => {
  const flag = randomUUID();
  const sessions = Array.from({ length: 20_000 }, () => randomUUID());
  const session = sessions[0] as string;
  assert.equal(flagBucket(flag, session), flagBucket(flag, session), 'stable for a session');
  for (const share of FLAG_SHARE_PERCENTS) {
    const inside = sessions.filter((id) => flagInForce({ id: flag, stage: 'share', sharePercent: share }, { id, staff: false })).length;
    assert.ok(Math.abs(inside / sessions.length - share / 100) < 0.01, `${share} percent gave ${inside}`);
  }
  const small = new Set(sessions.filter((id) => flagBucket(flag, id) < 5));
  const wide = new Set(sessions.filter((id) => flagBucket(flag, id) < 25));
  assert.ok([...small].every((id) => wide.has(id)), 'widening only adds sessions');
  const other = randomUUID();
  assert.ok(sessions.slice(0, 200).some((id) => flagBucket(flag, id) !== flagBucket(other, id)), 'each flag draws its own sessions');
});

test('stages decide what is in force, and being staff matters only for staff only', () => {
  const session = { id: randomUUID(), staff: true };
  const id = randomUUID();
  assert.equal(flagInForce({ id, stage: 'off', sharePercent: null }, session), false);
  assert.equal(flagInForce({ id, stage: 'staff_only', sharePercent: null }, session), true);
  assert.equal(flagInForce({ id, stage: 'staff_only', sharePercent: null }, { ...session, staff: false }), false);
  assert.equal(flagInForce({ id, stage: 'on', sharePercent: null }, { ...session, staff: false }), true);
  const out = Array.from({ length: 2000 }, () => randomUUID()).find((sid) => flagBucket(id, sid) >= 50) as string;
  assert.equal(flagInForce({ id, stage: 'share', sharePercent: 50 }, { id: out, staff: true }), false, 'a share does not widen for staff');
});
