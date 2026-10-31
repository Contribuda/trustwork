import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { createApp, expectError, SKIP_REASON, startHarness, type Client } from '../backend/helpers/app.js';
import { login, seedPersonas, type PersonaKey } from '../backend/helpers/personas.js';
import { providerState } from '../backend/hardening/helpers.js';
import { elevate, enrol, nextCode, secondStep, type Enrolled } from '../backend/second-factor/helpers.js';
import { ConfigError } from '../../apps/api/src/config.js';
import { adminSetup, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { fakeGate, restrictedPlaces } from '../../packages/contracts/src/sanctions.js';
import { RESTRICTED } from '../../packages/country-packs/src/restricted.js';

/**
 * SANC-001 on real PostgreSQL through the API (Fastify inject): the gate refuses restricted places before any route,
 * holds the person of a live session, refuses held people on every request and at every sign-in, and only a
 * compliance officer of the node clears a hold. Addresses are documentation ranges (RFC 5737) answered by the fake
 * adapter; every person is synthetic.
 */
const restricted = restrictedPlaces(RESTRICTED.places.map((p) => p.code));
const RESTRICTED_ADDRESS = '192.0.2.10';
const SERVED_ADDRESS = '203.0.113.7';
const h = await startHarness('jurisdiction_gate', { jurisdictionGate: fakeGate(restricted) });

test('jurisdiction gate and holds through the API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const seed = await seedPersonas(h);
  const from = (address: string) => ({ remoteAddress: address });
  const logs: string[] = [];

  // Node anchor, the compliance-officer definition and two founding compliance officers (anna, boris) at the node.
  await withMaintenance(h.db.admin, async (trx) => {
    const node = await adminSetup.createNode(trx, 'Synthetic jurisdiction node');
    await staffRoleDefinitions.release(trx, { version: 1, role: 'compliance-officer', scopes: ['node', 'hub'], permissions: ['admin.claims.read', 'admin.claims.decide'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    for (const key of ['anna', 'boris'] as const) await adminSetup.bootstrapFirstAdmin(trx, { personId: seed.people[key], role: 'compliance-officer', scope: { kind: 'node', nodeId: node.id }, definitionVersion: 1, reason: 'Synthetic setup' });
  });
  // The principal's staff list (ElevationGuard) uses the ADM-000 role ids until ADM-001 resolves scoped roles; the
  // database decides with the node's compliance-officer assignment.
  h.staff.set(seed.people.anna, ['trust-reviewer']);
  h.staff.set(seed.people.boris, ['trust-reviewer']);
  h.staff.set(seed.people.carl, ['support-agent']);

  const enrolled = new Map<PersonaKey, Enrolled>();
  const staffClient = async (key: PersonaKey): Promise<Client> => {
    const client = h.client();
    await login(client, key);
    if (!enrolled.has(key)) enrolled.set(key, await enrol(h, client));
    else assert.equal((await secondStep(client, { method: 'totp', code: nextCode(h, enrolled.get(key)!.secret) })).status, 200);
    return client;
  };
  const holdsOf = (personId: string) => h.db.admin.query<{ id: string; place: string; source: string; dataset: string; cleared_at: Date | null }>('SELECT id, place, source, dataset, cleared_at FROM trustwork.jurisdiction_hold WHERE person_id = $1 ORDER BY placed_at', [personId]).then((r) => r.rows);

  await t.test('anonymous requests from a restricted place are refused with 451 before any route, unknown paths included; probes stay open', async () => {
    const anonymous = h.client();
    expectError(await anonymous.get('/v1/me', from(RESTRICTED_ADDRESS)), 451, 'jurisdiction.restricted');
    expectError(await anonymous.get('/v1/route-the-proxy-does-not-know', from(RESTRICTED_ADDRESS)), 451, 'jurisdiction.restricted');
    expectError(await anonymous.post('/v1/auth/login', { email: 'x@example.invalid', password: 'x' }, { ...from(RESTRICTED_ADDRESS), idempotencyKey: null }), 451, 'jurisdiction.restricted');
    expectError(await anonymous.get('/v1/me', from('2001:db8::1')), 451, 'jurisdiction.restricted');
    assert.equal((await anonymous.get('/health', from(RESTRICTED_ADDRESS))).status, 200);
    assert.equal((await anonymous.get('/v1/jurisdiction/sighting', from(SERVED_ADDRESS))).status, 204, 'the relay route is a no-op when served');
    expectError(await anonymous.get('/v1/me', from(SERVED_ADDRESS)), 401, 'auth.session_invalid');
  });

  await t.test('a signed-in person seen in a restricted place is held; held, they are refused everywhere, from anywhere', async () => {
    const petr = h.client();
    await login(petr, 'petr');
    assert.equal((await petr.get('/v1/me', from(SERVED_ADDRESS))).status, 200);
    expectError(await petr.get('/v1/me', from(RESTRICTED_ADDRESS)), 451, 'jurisdiction.restricted');
    const holds = await holdsOf(seed.people.petr);
    assert.equal(holds.length, 1);
    assert.deepEqual([holds[0]?.place, holds[0]?.source, holds[0]?.dataset], ['CU', 'geolocation', 'fake']);
    expectError(await petr.get('/v1/me', from(SERVED_ADDRESS)), 403, 'auth.jurisdiction_hold');
    expectError(await petr.get('/v1/projects', from(SERVED_ADDRESS)), 403, 'auth.jurisdiction_hold');
    expectError(await petr.post('/v1/auth/logout', undefined, { ...from(SERVED_ADDRESS), idempotencyKey: null }), 403, 'auth.jurisdiction_hold');
    // A second sighting keeps the first hold.
    expectError(await petr.get('/v1/me', from('198.51.100.5')), 451, 'jurisdiction.restricted');
    assert.equal((await holdsOf(seed.people.petr)).length, 1);
    // Nothing anywhere in the database carries the address.
    const leaks = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.jurisdiction_hold WHERE row_to_json(jurisdiction_hold)::text LIKE '%192.0.2%' OR row_to_json(jurisdiction_hold)::text LIKE '%198.51.100%'");
    assert.equal(leaks.rows[0]?.n, 0);
    const outbox = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.outbox_event WHERE payload::text LIKE '%192.0.2%'");
    assert.equal(outbox.rows[0]?.n, 0);
    const counts = await h.db.admin.query<{ refusals: number; holds: number }>("SELECT sum(refusals)::int AS refusals, sum(holds)::int AS holds FROM trustwork.jurisdiction_refusal_count WHERE door = 'api'");
    assert.ok((counts.rows[0]?.refusals ?? 0) >= 6);
    assert.equal(counts.rows[0]?.holds, 1);
  });

  await t.test('a held person is refused at password sign-in and comes back from a provider sign-in with the reason', async () => {
    const again = h.client();
    expectError(await again.post('/v1/auth/login', { email: 'petr@example.invalid', password: 'fixture-password-petr-0001' }, { ...from(SERVED_ADDRESS), idempotencyKey: null }), 403, 'auth.jurisdiction_hold');
    assert.equal(again.sessionCookie, null, 'no session was issued');
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('credential').values({ person_id: seed.people.petr, kind: 'google', provider: 'google', provider_subject: 'google-petr-synthetic' }).execute());
    const viaGoogle = h.client();
    const state = await providerState(viaGoogle, 'google');
    h.google.enqueue({ subject: 'google-petr-synthetic', email: 'petr@example.invalid', emailVerified: true, name: 'Petr' });
    const callback = await viaGoogle.get(`/v1/auth/google/callback?code=fake&state=${state}`, from(SERVED_ADDRESS));
    assert.equal(callback.status, 303);
    assert.equal(new URL(String(callback.headers.location)).searchParams.get('auth'), 'jurisdiction_hold');
    assert.equal(viaGoogle.sessionCookie, null);
  });

  await t.test('concurrent sightings of one session open exactly one hold', async () => {
    const xenia = h.client();
    await login(xenia, 'xenia');
    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => xenia.get('/v1/me', from(i % 2 ? RESTRICTED_ADDRESS : '198.51.100.20'))));
    assert.ok(answers.every((a) => a.status === 451));
    const holds = await holdsOf(seed.people.xenia);
    assert.equal(holds.filter((x) => x.cleared_at === null).length, 1);
  });

  let holdId = '';
  await t.test('clearing is staff work: not the subject, not other staff, not without elevation; a compliance officer clears with a reason', async () => {
    holdId = (await holdsOf(seed.people.petr))[0]?.id as string;
    const carl = h.client();
    await login(carl, 'carl');
    const carlFactor = await enrol(h, carl);
    await elevate(h, carl, carlFactor.secret);
    expectError(await carl.post(`/v1/admin/jurisdiction/holds/${holdId}/clear`, { reason: 'Synthetic', evidence: 'call' }, from(SERVED_ADDRESS)), 403, 'access.forbidden');
    assert.deepEqual((await carl.get('/v1/admin/jurisdiction/holds', from(SERVED_ADDRESS))).body, { items: [] }, 'other staff read no holds');
    const anna = await staffClient('anna');
    const unelevated = await anna.post(`/v1/admin/jurisdiction/holds/${holdId}/clear`, { reason: 'Synthetic', evidence: 'call' }, from(SERVED_ADDRESS));
    expectError(unelevated, 403, 'access.forbidden');
    assert.equal((unelevated.body as { details?: { required?: string } }).details?.required, 'elevation');
    await elevate(h, anna, enrolled.get('anna')!.secret);
    const listed = await anna.get('/v1/admin/jurisdiction/holds?open=true', from(SERVED_ADDRESS));
    assert.equal(listed.status, 200);
    assert.ok((listed.body as { items: { id: string; personId: string }[] }).items.some((x) => x.id === holdId && x.personId === seed.people.petr));
    expectError(await anna.post(`/v1/admin/jurisdiction/holds/${holdId}/clear`, { reason: '  ', evidence: 'call' }, from(SERVED_ADDRESS)), 422, 'validation.schema');
    expectError(await anna.post(`/v1/admin/jurisdiction/holds/${holdId}/clear`, { reason: 'Synthetic', evidence: 'selfie' }, from(SERVED_ADDRESS)), 422, 'validation.schema');
    expectError(await anna.post('/v1/admin/jurisdiction/holds/00000000-0000-4000-8000-000000000009/clear', { reason: 'Synthetic', evidence: 'call' }, from(SERVED_ADDRESS)), 404, 'access.not_found');
    // The officer is in a restricted place: refused like everyone (no staff exception).
    expectError(await anna.post(`/v1/admin/jurisdiction/holds/${holdId}/clear`, { reason: 'Synthetic', evidence: 'call' }, from(RESTRICTED_ADDRESS)), 451, 'jurisdiction.restricted');
  });

  await t.test('the cleared person is served again; the clear is audited; a second clear conflicts; anna is now held and boris clears her', async () => {
    // anna was just seen in a restricted place (previous step) and is held herself.
    const annaHolds = await holdsOf(seed.people.anna);
    assert.equal(annaHolds.filter((x) => x.cleared_at === null).length, 1);
    const boris = await staffClient('boris');
    await elevate(h, boris, enrolled.get('boris')!.secret);
    const cleared = await boris.post(`/v1/admin/jurisdiction/holds/${holdId}/clear`, { reason: 'Synthetic: back home, confirmed by a call', evidence: 'call' }, from(SERVED_ADDRESS));
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal((cleared.body as { clearedBy: string }).clearedBy, seed.people.boris);
    expectError(await boris.post(`/v1/admin/jurisdiction/holds/${holdId}/clear`, { reason: 'Synthetic again', evidence: 'call' }, from(SERVED_ADDRESS)), 409, 'validation.revision_conflict');
    const audit = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE action = 'jurisdiction.hold_cleared' AND object_id = $1 AND actor_person_id = $2", [holdId, seed.people.boris]);
    assert.equal(audit.rows[0]?.n, 1);
    const petr = h.client();
    await login(petr, 'petr');
    assert.equal((await petr.get('/v1/me', from(SERVED_ADDRESS))).status, 200, 'the person signs in and is served again');
    const annaHold = annaHolds.find((x) => x.cleared_at === null)?.id as string;
    assert.equal((await boris.post(`/v1/admin/jurisdiction/holds/${annaHold}/clear`, { reason: 'Synthetic: travelling officer is back', evidence: 'travel_record' }, from(SERVED_ADDRESS))).status, 200);
    logs.push('ok');
  });

  await t.test('configuration: production refuses to start without an explicit gate, or with the fake one', async () => {
  const production = { NODE_ENV: 'production', AUTH_FLOW_SECRET: 'a1'.repeat(32), PUBLIC_ORIGIN: 'https://hub.example.test', MAIL_SECRET_KEY: 'b2'.repeat(32), SECOND_FACTOR_SECRET_KEY: 'c3'.repeat(32) };
  await assert.rejects(createApp({ env: production, pool: h.pool }), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes('TRUSTWORK_JURISDICTION_GATE')));
  await assert.rejects(createApp({ env: { ...production, TRUSTWORK_JURISDICTION_GATE: 'fake' }, pool: h.pool }), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes('refused in production')));
  const upstream = await createApp({ env: { ...production, TRUSTWORK_JURISDICTION_GATE: 'upstream_gate' }, pool: h.pool, logSink: () => undefined });
  await upstream.close();
  });

  await t.test('the edge-header adapter and the trusted-proxy rules decide from what the operator trusts, never from what a client claims', async () => {
  const base = { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test' };
  const edge = await createApp({ env: { ...base, TRUSTWORK_JURISDICTION_GATE: 'edge_header', TRUSTWORK_JURISDICTION_COUNTRY_HEADER: 'X-Geo-Country', TRUSTWORK_JURISDICTION_REGION_HEADER: 'X-Geo-Region' }, pool: h.pool, logSink: () => undefined });
  try {
    const call = (headers: Record<string, string>) => edge.fastify.inject({ method: 'GET', url: '/v1/me', headers });
    assert.equal((await call({ 'x-geo-country': 'IR' })).statusCode, 451);
    assert.equal((await call({ 'x-geo-country': 'UA', 'x-geo-region': '14' })).statusCode, 451);
    assert.equal((await call({ 'x-geo-country': 'UA', 'x-geo-region': '30' })).statusCode, 401, 'Kyiv is served (no session: 401)');
  } finally {
    await edge.close();
  }
  const untrusted = await createApp({ env: { ...base, TRUSTWORK_JURISDICTION_GATE: 'fake' }, pool: h.pool, logSink: () => undefined });
  const trusted = await createApp({ env: { ...base, TRUSTWORK_JURISDICTION_GATE: 'fake', API_TRUSTED_PROXY_HOPS: '1' }, pool: h.pool, logSink: () => undefined });
  try {
    const viaProxy = { method: 'GET' as const, url: '/v1/me', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': RESTRICTED_ADDRESS } };
    assert.equal((await untrusted.fastify.inject(viaProxy)).statusCode, 401, 'without trusted hops a forwarded address is ignored');
    assert.equal((await trusted.fastify.inject(viaProxy)).statusCode, 451, 'the configured proxy hop is trusted');
    assert.equal((await trusted.fastify.inject({ ...viaProxy, headers: { 'x-forwarded-for': `${RESTRICTED_ADDRESS}, ${SERVED_ADDRESS}` } })).statusCode, 401, 'only the hop the proxy appended counts');
  } finally {
    await untrusted.close();
    await trusted.close();
  }
});
});
