import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/contracts/src/index.js';

test('error envelope: stable English codes, namespaces, status mapping and disclosure rule', () => {
  const envelope = c.errorEnvelope('commercial.stale_version', 'req-1', 'quote answers a superseded RFQ version', { quoteVersionId: 'q-v1', currentRfqVersionId: 'rfq-v2' });
  assert.ok(c.ErrorEnvelopeSchema.safeParse(envelope).success);
  assert.equal(c.ErrorEnvelopeSchema.safeParse({ ...envelope, messageKey: 'x' }).success, false, 'legacy messageKey field rejected');
  assert.equal(c.ErrorEnvelopeSchema.safeParse({ code: 'commercial.unknown', message: 'x', requestId: 'r' }).success, false);
  for (const code of c.ERROR_CODES) {
    assert.match(code, /^(auth|access|commercial|membership|validation)\.[a-z_.]+$/);
    assert.ok(Number.isInteger(c.httpStatusFor(code)));
  }
  assert.equal(c.httpStatusFor('access.not_found'), 404);
  assert.equal(c.httpStatusFor('validation.revision_conflict'), 409);
  assert.equal(c.httpStatusFor('auth.recovery.on_hold'), 409, 'a held recovery is never a success status');
  assert.equal(c.disclosureCode(false), 'access.not_found');
  assert.equal(c.disclosureCode(true), 'access.forbidden');
});
test('idempotency scope is (principal, action, context, key) and replays only the same payload', () => {
  const { scope, storageKey } = c.buildIdempotencyScope({ principalId: 'person-a', action: 'place_order', contextId: 'project-1', key: 'client-key-1' });
  assert.equal(storageKey, '{"action":"place_order","contextId":"project-1","key":"client-key-1","principalId":"person-a"}');
  assert.notEqual(storageKey, c.buildIdempotencyScope({ ...scope, principalId: 'person-b' }).storageKey, 'another principal cannot replay');
  assert.throws(() => c.buildIdempotencyScope({ ...scope, action: 'Place Order' }));
  const payload = { quoteVersionId: 'q-v2' };
  const record: c.IdempotencyRecord = { scope, payloadDigest: c.computeDigest(payload), status: 'completed', result: { httpStatus: 202, body: { actionId: 'a-1' } }, recordedAt: '2026-10-27T00:00:00Z' };
  assert.deepEqual(c.resolveIdempotency(null, c.computeDigest(payload)), { kind: 'first' });
  assert.deepEqual(c.resolveIdempotency(record, c.computeDigest({ quoteVersionId: 'q-v2' })), { kind: 'replay', result: record.result! });
  assert.deepEqual(c.resolveIdempotency(record, c.computeDigest({ quoteVersionId: 'q-v3' })), { kind: 'conflict' });
  assert.deepEqual(c.resolveIdempotency({ ...record, status: 'in_progress', result: null }, c.computeDigest(payload)), { kind: 'in_progress' });
  assert.equal(c.IdempotencyKeySchema.safeParse('has space').success, false);
  assert.equal(c.IDEMPOTENCY_KEY_HEADER, 'Idempotency-Key');
});
test('cursor pagination is bounded and cursors round-trip opaquely', () => {
  assert.deepEqual(c.PageRequestSchema.parse({}), { limit: 20 });
  assert.equal(c.PageRequestSchema.safeParse({ limit: 101 }).success, false);
  assert.equal(c.PageRequestSchema.safeParse({ limit: 10, offset: 5 }).success, false);
  const cursor = c.encodeCursor({ sortKey: '2026-10-27T00:00:00Z', id: 'rfq-1' });
  assert.ok(c.CursorSchema.safeParse(cursor).success);
  assert.deepEqual(c.decodeCursor(cursor), { sortKey: '2026-10-27T00:00:00Z', id: 'rfq-1' });
  assert.equal(c.decodeCursor('not base64url!'), null);
  assert.equal(c.decodeCursor(c.toBase64Url(c.utf8Encode('{"evil":1}'))), null);
  assert.equal(c.decodeCursor('AAAA'), null, 'non-JSON bytes');
  assert.deepEqual([...c.fromBase64Url(c.toBase64Url(new Uint8Array([0, 255, 128, 1])))!], [0, 255, 128, 1]);
  assert.equal(c.fromBase64Url('a+b/'), null);
  const page = c.pageSchema(c.PublicCompanySchema);
  assert.ok(page.safeParse({ items: [], nextCursor: null }).success);
  assert.equal(page.safeParse({ items: [], nextCursor: null, total: 10 }).success, false, 'no unrestricted totals');
});
test('API constants, health and mutation envelope', () => {
  assert.equal(c.apiPath('/search'), '/v1/search');
  assert.equal(c.SESSION_COOKIE, '__Host-sr_session');
  assert.equal(c.CSRF_HEADER, 'X-Trustwork-Request');
  assert.deepEqual(c.health, { status: 'ok', mode: 'bootstrap', externalProviders: 'disabled' });
  assert.ok(c.HealthSchema.safeParse(c.health).success);
  const command = c.mutation({ projectId: c.IdSchema });
  assert.ok(command.safeParse({ idempotencyKey: 'k1', projectId: 'p1', expectedRevision: 3 }).success);
  assert.equal(command.safeParse({ projectId: 'p1' }).success, false, 'idempotency key required');
  assert.equal(command.safeParse({ idempotencyKey: 'k1', projectId: 'p1', ownerId: 'me' }).success, false, 'mass assignment rejected');
  assert.ok(c.CommandAcceptedSchema.safeParse({ actionId: 'a', state: 'queued', revision: 1 }).success);
  assert.equal(c.CommandAcceptedSchema.safeParse({ actionId: 'a', state: 'succeeded', revision: 1 }).success, false, 'acknowledgement never implies the effect');
});
test('place_order command matches the documented example and rejects client-supplied money', () => {
  const digest = c.computeDigest({ fixture: true });
  const command = {
    action: 'place_order',
    context: { kind: 'project', id: 'project-fixture' },
    agreementId: 'agreement-fixture',
    quoteVersion: { id: 'quote-v3-fixture', version: 3, digest },
    rfqVersion: { id: 'rfq-v2-fixture', version: 2, digest },
    expectedRevision: 4,
    mandateId: 'mandate-fixture',
    mandateRevision: 2,
    transactionBudgetId: 'budget-fixture',
    platformBudgetId: null,
    idempotencyKey: 'fixture-unique-request',
  };
  assert.ok(c.PlaceOrderCommandSchema.safeParse(command).success);
  assert.equal(c.PlaceOrderCommandSchema.safeParse({ ...command, total: { minorUnits: '1', currency: 'UZS' } }).success, false);
  assert.equal(c.PlaceOrderCommandSchema.safeParse({ ...command, principalId: 'person-fixture' }).success, false, 'principal comes from the session');
  assert.equal(c.PlaceOrderCommandSchema.safeParse({ ...command, transactionBudgetId: null }).success, false);
});
test('JSON Schema is generated from every registered contract without throwing', () => {
  const schemas = c.contractJsonSchemas();
  assert.ok(Object.keys(schemas).length >= 25);
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    assert.ok(schema.type === 'object' || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf), name);
  }
  const envelope = schemas.ErrorEnvelope as { properties: Record<string, unknown>; additionalProperties?: boolean };
  assert.deepEqual(Object.keys(envelope.properties).sort(), ['code', 'details', 'message', 'requestId']);
  assert.equal(envelope.additionalProperties, false);
});
