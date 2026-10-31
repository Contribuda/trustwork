import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { computeDigest, type EgressRequest } from '@trustwork/contracts';
import { admission, AdmissionGate, AdmissionLeaseExpiredError, admissionScopes, bindTransaction, createPool, withMaintenance, withPrincipal, type Principal } from '@trustwork/data';
import { provisionTestDatabase, SKIP_REASON, untilDatabaseTimePasses } from '../data/helpers/postgres.js';
import { principalFor, seedFixtures } from '../data/helpers/seed.js';

const db = await provisionTestDatabase('admission');

test('common admission / revocation primitive: one linearization shared by two nodes', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  // Two independent pools stand in for an API node and a worker node.
  const nodeA = createPool({ ...db.appConfig, max: 4 });
  const nodeB = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await nodeA.end(); await nodeB.end(); await db.close(); });
  const principal = (id: string): Promise<Principal> => principalFor(db.admin, id);
  const scopes = [admissionScopes.person(seed.people.anna), admissionScopes.company(seed.companies.mixed)];
  const digest = computeDigest({ question: 'Поставщики фасадных панелей', dependencies: [] }).value;
  const request = (overrides: Partial<EgressRequest['binding']> = {}, context: Partial<EgressRequest['context']> = {}): EgressRequest => ({
    binding: { target: 'embedding_provider', purpose: 'query_embedding', providerId: 'fixture-embed', policyId: 'policy-1', policyRevision: '1', modelId: 'fixture-model', modelRevision: 'r1', configId: 'config-1', dataClass: 'company_private', fingerprintHash: 'fp-1', ...overrides } as EgressRequest['binding'],
    payloadDigest: digest,
    context: { principalId: seed.people.anna, scopeFingerprint: 'scope-fp-1', policyEpoch: '1', ...context },
    dependencies: [{ sourceId: 'src-1', versionId: 'v1', projectionId: 'proj-1', contentHash: 'h1' }],
  });

  await t.test('issue + admit succeed once; the same permit a second time is a replay', async () => {
    const anna = await principal(seed.people.anna);
    const permit = await withPrincipal(nodeA, anna, (trx) => admission.issue(trx, request(), { scopes, ttlMs: 60_000 }));
    assert.ok(permit.permitId && permit.signature);
    const first = await withPrincipal(nodeB, anna, (trx) => admission.admit(trx, request(), permit, { leaseMs: 5_000 }));
    assert.equal(first.admitted, true);
    const replay = await withPrincipal(nodeB, anna, (trx) => admission.admit(trx, request(), permit, { leaseMs: 5_000 }));
    assert.deepEqual(replay, { admitted: false, reason: 'replayed' });
    if (first.admitted) assert.equal(await withPrincipal(nodeB, anna, (trx) => admission.settle(trx, first.leaseId, 'dispatched')), true);
  });

  await t.test('revoke between preflight (issue) and admission denies the permit', async () => {
    const anna = await principal(seed.people.anna);
    const permit = await withPrincipal(nodeA, anna, (trx) => admission.issue(trx, request(), { scopes, ttlMs: 60_000 }));
    const epoch = await withPrincipal(nodeB, anna, (trx) => admission.revoke(trx, admissionScopes.company(seed.companies.mixed), 'participation revoked'));
    assert.equal(epoch, 2n);
    const denied = await withPrincipal(nodeA, anna, (trx) => admission.admit(trx, request(), permit, { leaseMs: 5_000 }));
    assert.deepEqual(denied, { admitted: false, reason: 'revoked' });
    const lease = await withPrincipal(nodeA, anna, (trx) => admission.getLease(trx, permit.permitId));
    assert.equal(lease?.revoked_at !== null, true, 'unadmitted permit invalidated by the revocation');
    const events = await withPrincipal(nodeA, anna, (trx) => admission.revocations(trx, admissionScopes.company(seed.companies.mixed)));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.epoch, '2');
  });

  await t.test('concurrency: an uncommitted revocation on node B blocks node A admission, which then observes the new epoch and denies', async () => {
    const anna = await principal(seed.people.anna);
    const permit = await withPrincipal(nodeA, anna, (trx) => admission.issue(trx, request(), { scopes, ttlMs: 60_000 }));
    const revoker = await nodeB.connect();
    await revoker.query('BEGIN');
    await revoker.query('SELECT trustwork.set_principal($1::uuid, $2::integer)', [anna.personId, anna.authzEpoch]);
    await revoker.query("SELECT trustwork.admission_revoke($1, 'held open')", [admissionScopes.person(seed.people.anna)]);
    let settled = false;
    const admitting = withPrincipal(nodeA, anna, (trx) => admission.admit(trx, request(), permit, { leaseMs: 5_000 })).then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, 'admission waits for the exclusive revocation');
    await revoker.query('COMMIT');
    revoker.release();
    const result = await admitting;
    assert.deepEqual(result, { admitted: false, reason: 'revoked' });
  });

  await t.test('concurrency the other way: an admission that committed before the revocation stays admitted (bytes already out); the in-flight lease is listed', async () => {
    const anna = await principal(seed.people.anna);
    const permit = await withPrincipal(nodeA, anna, (trx) => admission.issue(trx, request(), { scopes, ttlMs: 60_000 }));
    const admitted = await withPrincipal(nodeA, anna, (trx) => admission.admit(trx, request(), permit, { leaseMs: 5_000 }));
    assert.equal(admitted.admitted, true);
    await withPrincipal(nodeB, anna, (trx) => admission.revoke(trx, admissionScopes.person(seed.people.anna), 'after admission'));
    const inFlight = await withPrincipal(nodeB, anna, (trx) => admission.inFlight(trx, admissionScopes.person(seed.people.anna)));
    assert.ok(inFlight.some((l) => l.permit_id === permit.permitId), 'already admitted dispatch is reported, not recalled');
  });

  await t.test('expiry, wrong provider/model/policy/data class, query-vs-document kind, tampered permit and digest mismatch fail closed', async () => {
    const anna = await principal(seed.people.anna);
    const issue = (ttlMs = 60_000) => withPrincipal(nodeA, anna, (trx) => admission.issue(trx, request(), { scopes, ttlMs }));
    // Expiry is computed from this process's clock and checked against the database's now(); the two may run tens of
    // milliseconds apart (Docker VM), so wait for the database clock instead of a fixed sleep. A TTL below the skew
    // would also violate admission_lease_window (expires_at > issued_at = now()).
    const SHORT_TTL_MS = 250;
    const expired = await issue(SHORT_TTL_MS);
    await untilDatabaseTimePasses(db.admin, new Date(expired.expiresAt));
    assert.deepEqual(await withPrincipal(nodeB, anna, (trx) => admission.admit(trx, request(), expired, { leaseMs: 5_000 })), { admitted: false, reason: 'expired' });
    const variants: [string, EgressRequest][] = [
      ['provider', request({ providerId: 'other-provider' })],
      ['model', request({ modelId: 'other-model' })],
      ['policy', request({ policyRevision: '2' })],
      ['data class', request({ dataClass: 'public' })],
      ['document instead of query', request({ purpose: 'document_embedding' })],
      ['fingerprint', request({ fingerprintHash: 'fp-2' })],
      ['policy epoch', request({}, { policyEpoch: '2' })],
      ['digest', { ...request(), payloadDigest: computeDigest({ question: 'другой вопрос' }).value }],
    ];
    for (const [label, variant] of variants) {
      const permit = await issue();
      const result = await withPrincipal(nodeB, anna, (trx) => admission.admit(trx, variant, permit, { leaseMs: 5_000 }));
      assert.equal(result.admitted, false, label);
      assert.ok(['binding_mismatch', 'digest_mismatch', 'context_mismatch'].includes((result as { reason: string }).reason), `${label}: ${JSON.stringify(result)}`);
    }
    const permit = await issue();
    const tampered = { ...permit, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    assert.deepEqual(await withPrincipal(nodeB, anna, (trx) => admission.admit(trx, request(), tampered, { leaseMs: 5_000 })), { admitted: false, reason: 'permit_tampered' });
    const shortLived = await issue(SHORT_TTL_MS);
    await untilDatabaseTimePasses(db.admin, new Date(shortLived.expiresAt));
    const dbTamper = await withPrincipal(nodeB, anna, (trx) => admission.admit(trx, request(), { ...shortLived, signature: undefined, expiresAt: tampered.expiresAt }, { leaseMs: 5_000 }));
    assert.deepEqual(dbTamper, { admitted: false, reason: 'expired' }, 'the database lease, not the permit text, is authoritative');
  });

  await t.test('pooled missing identity and a foreign principal fail closed', async () => {
    const anna = await principal(seed.people.anna);
    const permit = await withPrincipal(nodeA, anna, (trx) => admission.issue(trx, request(), { scopes, ttlMs: 60_000 }));
    const client = await nodeB.connect();
    try {
      await client.query('BEGIN');
      const bare = await admission.admit(bindTransaction(client), request(), permit, { leaseMs: 5_000 });
      assert.deepEqual(bare, { admitted: false, reason: 'missing_identity' });
      await client.query("SELECT set_config('trustwork.person_id', $1, true)", [anna.personId]);
      const forged = await admission.admit(bindTransaction(client), request(), permit, { leaseMs: 5_000 });
      assert.deepEqual(forged, { admitted: false, reason: 'missing_identity' }, 'a forged GUC without the MAC is no identity');
      await client.query('ROLLBACK');
    } finally {
      client.release(true);
    }
    const boris = await principal(seed.people.boris);
    assert.deepEqual(await withPrincipal(nodeB, boris, (trx) => admission.admit(trx, request(), permit, { leaseMs: 5_000 })), { admitted: false, reason: 'unknown_permit' }, 'a foreign principal learns nothing about the permit');
    const untouched = await withPrincipal(nodeA, anna, (trx) => admission.getLease(trx, permit.permitId));
    assert.equal(untouched?.denied_at, null, 'the foreign attempt leaves the owner lease untouched');
    await assert.rejects(withPrincipal(nodeB, boris, (trx) => admission.issue(trx, request(), { scopes, ttlMs: 60_000 })), (e: unknown) => (e as { code?: string }).code === 'access.no_principal' || (e as { code?: string }).code === '28000');
    const still = await withPrincipal(nodeA, anna, (trx) => admission.admit(trx, request(), permit, { leaseMs: 5_000 }));
    assert.equal(still.admitted, true, 'the owner can still use the permit once');
  });

  await t.test('AdmissionGate runs the dispatch inside the lease and settles; an overlong dispatch raises lease expiry (outcome unknown)', async () => {
    const anna = await principal(seed.people.anna);
    const gate = new AdmissionGate(nodeB, { leaseMs: 200, ttlMs: 60_000 });
    const permit = await gate.issue(anna, request(), scopes);
    const ok = await gate.admit(anna, request(), permit, async () => 'vector-bytes');
    assert.deepEqual(ok.admitted ? ok.value : null, 'vector-bytes');
    const lease = await withPrincipal(nodeA, anna, (trx) => admission.getLease(trx, permit.permitId));
    assert.equal(lease?.outcome, 'dispatched');
    const slow = await gate.issue(anna, request(), scopes);
    await assert.rejects(gate.admit(anna, request(), slow, () => new Promise((resolve) => setTimeout(() => resolve('late'), 600))), AdmissionLeaseExpiredError);
    const slowLease = await withPrincipal(nodeA, anna, (trx) => admission.getLease(trx, slow.permitId));
    assert.equal(slowLease?.outcome, 'lease_expired');
    const port = gate.forPrincipal(anna, scopes);
    const p2 = await port.issue(request());
    assert.ok(p2);
    const r2 = await port.admit(request(), p2 as NonNullable<typeof p2>, async () => 1);
    assert.deepEqual(r2, { admitted: true, value: 1 });
  });

  await t.test('revocation requires an identity or the maintenance context; events are append-only', async () => {
    const client = await nodeA.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(client.query("SELECT trustwork.admission_revoke('person:x', 'anonymous')"), (e: unknown) => (e as pg.DatabaseError).code === '28000');
      await client.query('ROLLBACK');
    } finally {
      client.release(true);
    }
    const epoch = await withMaintenance(db.admin, (trx) => admission.revoke(trx, 'project:maintenance', 'sweeper'));
    assert.equal(epoch, 2n);
    await assert.rejects(db.admin.query('DELETE FROM trustwork.revocation_event'), (e: unknown) => (e as pg.DatabaseError).hint === 'audit.append_only');
  });
});
