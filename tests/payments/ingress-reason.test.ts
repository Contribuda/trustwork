import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ingressRefusalReason, startPaymentIngress } from '../../apps/worker/src/payments/ingress.js';
import type { PaymentRuntime } from '../../apps/worker/src/payments/index.js';

/** PAY-001: a refusal has to be diagnosable from the log, and the log must carry nothing the error happens to quote. */
const SECRET = 'synthetic-subject-ref-4711';

test('a refusal from the closed list becomes its code, whichever side raised it', () => {
  assert.equal(ingressRefusalReason(new Error('source challenge binding mismatch')), 'source_challenge_binding_mismatch');
  assert.equal(ingressRefusalReason(new Error('invalid source signature')), 'invalid_source_signature');
  assert.equal(ingressRefusalReason(new Error('payment sender mismatch')), 'payment_sender_mismatch');
});

test('text an error carries never reaches the code', () => {
  let parsing: unknown;
  try { JSON.parse(`{"verifiedSubjectRef":"${SECRET}"`); } catch (error) { parsing = error; }
  const schema = z.strictObject({ a: z.literal('b') }).safeParse({ a: SECRET, [SECRET]: 1 });
  const database = Object.assign(new Error(`duplicate key: (subject)=(${SECRET})`), { code: '23505', detail: SECRET });
  const reasons = [parsing, schema.error, database, new Error(SECRET), Object.assign(new Error(SECRET), { code: SECRET }), SECRET, null, undefined].map(ingressRefusalReason);
  assert.deepEqual(reasons, ['evidence_not_json', 'evidence_schema', 'database_23505', 'unclassified', 'unclassified', 'unclassified', 'unclassified', 'unclassified']);
});

test('the sender gets the empty 400 as before; the operator gets the route, the id and the code, and no byte of the request', async (t) => {
  const lines: Array<Record<string, unknown>> = [];
  const runtime = { providers: { get: () => { throw new Error('payment provider unavailable'); } } } as unknown as PaymentRuntime;
  const ingress = await startPaymentIngress(runtime, 0, (level, message, fields) => { lines.push({ level, message, ...fields }); });
  t.after(() => ingress.close());
  const id = '11111111-1111-4111-8111-111111111111';
  const post = (path: string) => fetch(`http://127.0.0.1:${ingress.port}${path}`, { method: 'POST', body: JSON.stringify({ verifiedSubjectRef: SECRET }), headers: { 'payment-signature': `signature-${SECRET}` } });

  const source = await post(`/payments/sources/${id}`);
  assert.deepEqual([source.status, await source.text()], [400, '']);
  const webhook = await post(`/payments/${id}`);
  assert.deepEqual([webhook.status, await webhook.text()], [400, '']);
  assert.deepEqual(lines, [
    { level: 'warn', message: 'payment ingress refused', route: 'source', target: id, reason: 'payment_source_verifier_unavailable' },
    { level: 'warn', message: 'payment ingress refused', route: 'webhook', target: id, reason: 'payment_provider_unavailable' },
  ]);
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(SECRET));
});
