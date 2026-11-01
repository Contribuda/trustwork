import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { computeDigest } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { startHarness } from '../../backend/helpers/app.js';
import { installCrashPoints, recordState } from '../../backend/idempotency/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from '../../../apps/api/src/common/idempotency/index.js';
import { authorityFixture } from './authority-fixture.js';

const h = await startHarness('jurisdiction_shared_audit');
test('registered applicability API commits exact shared ADM audit and opaque outbox atomically', { skip: !h }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const f = await authorityFixture(h.db.admin, h.pool);
  const clients = { owner: h.client(), officer: h.client() };
  for (const key of ['owner', 'officer'] as const) {
    const token = randomBytes(32).toString('base64url');
    await h.db.admin.query('UPDATE trustwork.session SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(token).digest(), f.world.sessions[key]]);
    clients[key].setSessionCookie(token);
    h.staff.set(f.p[key], [key === 'owner' ? 'hub-owner' : 'compliance-officer']);
    await f.a.elevate(f.p[key]);
  }
  const stage = () => withMaintenance(h.db.admin, trx => jurisdictionEvidence.stageApplicability(trx, {
    subjectKind: 'person', subjectId: f.p.outsider, hubId: f.hubId, jurisdictions: ['US'],
    evidenceId: 'synthetic.privateLegalEvidence', evidenceDigest: 'e'.repeat(64), effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: '2099-01-01T00:00:00.000Z',
  }));
  const image = async (table: string, column: string, id: string): Promise<unknown> => (await h.db.admin.query(`SELECT to_jsonb(r) image FROM trustwork.${table} r WHERE ${column}=$1`, [id])).rows[0]?.image ?? null;
  const counts = async () => (await h.db.admin.query(`SELECT
    (SELECT count(*)::int FROM trustwork.jurisdiction_applicability_review) reviews,
    (SELECT count(*)::int FROM trustwork.jurisdiction_applicability_activation) activations,
    (SELECT count(*)::int FROM trustwork.admin_audit_event WHERE action LIKE 'jurisdiction.applicability_%') audits,
    (SELECT count(*)::int FROM trustwork.outbox_event WHERE type LIKE 'jurisdiction.applicability_%') outbox`)).rows[0]!;
  const check = async (reviewId: string, operation: 'proposed' | 'activated', actor: 'owner' | 'officer', before: unknown, after: unknown, requestId: string) => {
    const action = `jurisdiction.applicability_${operation}`;
    const audits = await h.db.admin.query('SELECT * FROM trustwork.admin_audit_event WHERE action=$1 AND object_id=$2', [action, reviewId]);
    assert.equal(audits.rowCount, 1);
    const a = audits.rows[0]!;
    assert.equal(a.actor_person_id, f.p[actor]);
    assert.equal(a.actor_role, actor === 'owner' ? 'hub-owner' : 'compliance-officer');
    const snapshot = operation === 'proposed'
      ? (await h.db.admin.query('SELECT proposer authority FROM trustwork.jurisdiction_applicability_review WHERE id=$1', [reviewId])).rows[0]!.authority
      : (await h.db.admin.query('SELECT reviewer authority FROM trustwork.jurisdiction_applicability_activation WHERE review_id=$1', [reviewId])).rows[0]!.authority;
    const grant = (await h.db.admin.query('SELECT role,breakglass FROM trustwork.staff_role_assignment WHERE id=$1', [snapshot.assignmentId])).rows[0]!;
    assert.equal(a.actor_role, grant.role); assert.equal(a.breakglass, grant.breakglass);
    assert.equal(a.session_elevation_id, snapshot.elevationId);
    assert.equal(a.permission, actor === 'owner' ? 'admin.hub.jurisdiction.edit' : 'admin.hub.jurisdiction.activate');
    assert.equal(a.scope_kind, 'hub'); assert.equal(a.hub_id, f.hubId); assert.equal(a.node_id, null);
    assert.equal(a.reason_code, 'jurisdiction_review'); assert.equal(a.reason_text, 'Synthetic reviewed evidence');
    assert.equal(a.request_id, requestId); assert.equal(a.outcome, 'applied');
    assert.equal(a.before_digest, before === null ? null : computeDigest(before).value);
    assert.equal(a.after_digest, computeDigest(after).value);
    const events = await h.db.admin.query('SELECT * FROM trustwork.outbox_event WHERE type=$1 AND aggregate_id=$2', [action, reviewId]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0]!.aggregate_kind, 'jurisdiction_applicability_review');
    assert.deepEqual(events.rows[0]!.payload, { reviewId, requestId });
    const serialized = JSON.stringify([a, events.rows[0]!]);
    for (const privateValue of [f.p.outsider, 'synthetic.privateLegalEvidence', 'jurisdictions', 'evidence_digest', 'sessionId', 'consent', 'legalBindings']) assert.ok(!serialized.includes(privateValue), privateValue);
    assert.equal((await f.a.as(f.p.otherOwner, trx => trx.selectFrom('admin_audit_event').select('id').where('object_id', '=', reviewId).execute())).length, 0);
    assert.equal((await f.a.as(f.p.outsider, trx => trx.selectFrom('admin_audit_event').select('id').where('object_id', '=', reviewId).execute())).length, 0);
  };
  for (const existingHead of [false, true]) {
    await t.test(`exact snapshots and idempotent retries with ${existingHead ? 'replacement' : 'initial'} current head`, async () => {
      const e = await stage();
      const body = { evidenceDigest: e.digest, reason: 'Synthetic reviewed evidence' };
      const url = `/v1/admin/jurisdiction-applicability/evidence/${e.id}/review`;
      const before = await counts();
      for (const override of [{ hubId: f.otherHubId }, { actorPersonId: f.p.officer }, { audience: 'public' }, { target: f.p.outsider }]) {
        assert.equal((await clients.owner.post(url, { ...body, ...override })).status, 422);
      }
      assert.deepEqual(await counts(), before);
      const requestId = `synthetic-propose-${existingHead}`;
      const opts = { idempotencyKey: requestId, headers: { 'x-request-id': requestId } };
      const proposed = await clients.owner.post(url, body, opts);
      assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
      const reviewId = (proposed.body as { reviewId: string }).reviewId;
      const review = await image('jurisdiction_applicability_review', 'id', reviewId);
      await check(reviewId, 'proposed', 'owner', null, review, requestId);
      const committed = await counts();
      const retries = await Promise.all([clients.owner.post(url, body, opts), clients.owner.post(url, body, opts)]);
      for (const response of retries) { assert.equal(response.status, 200); assert.deepEqual(response.body, proposed.body); }
      assert.deepEqual(await counts(), committed);
      const previous = await image('jurisdiction_applicability_current', 'subject_id', f.p.outsider);
      assert.equal(previous !== null, existingHead);
      const activateId = `synthetic-activate-${existingHead}`;
      const activationUrl = `/v1/admin/jurisdiction-applicability/reviews/${reviewId}/activate`;
      const activationOpts = { idempotencyKey: activateId, headers: { 'x-request-id': activateId } };
      const activated = await clients.officer.post(activationUrl, body, activationOpts);
      assert.equal(activated.status, 200, JSON.stringify(activated.body));
      const activation = await image('jurisdiction_applicability_activation', 'review_id', reviewId);
      const head = await image('jurisdiction_applicability_current', 'subject_id', f.p.outsider);
      await check(reviewId, 'activated', 'officer', { review, activation: null, head: previous }, { review, activation, head }, activateId);
      const after = await counts();
      assert.deepEqual((await clients.officer.post(activationUrl, body, activationOpts)).body, activated.body);
      assert.deepEqual(await counts(), after);
    });
  }
  await t.test('authority and shared-audit contention return 409 without refresh, retry, escaped result or mutation', async () => {
    const e = await stage();
    const url = `/v1/admin/jurisdiction-applicability/evidence/${e.id}/review`;
    const body = { evidenceDigest: e.digest, reason: 'Synthetic reviewed evidence' };
    const principals = h.services().principals;
    const original = principals.runAs;
    for (const target of ['person', 'session', 'session_elevation', 'staff_role_assignment', 'admin_sequence'] as const) {
      const before = await counts();
      let calls = 0, executions = 0;
      principals.runAs = async function (state, fn, options) {
        calls++;
        assert.equal(options?.refreshStale, false);
        const snapshot = structuredClone(state), principal = state.principal;
        const blocker = await h.db.admin.connect();
        try {
          await blocker.query('BEGIN');
          const where = target === 'admin_sequence' ? "name='admin_audit_event'" : target === 'person' ? 'id=$1' : 'person_id=$1';
          await blocker.query(`SELECT 1 FROM trustwork.${target} WHERE ${where} FOR UPDATE`, target === 'admin_sequence' ? [] : [f.p.owner]);
          return await original.call(principals, state, async (trx, p) => { executions++; return fn(trx, p); }, options);
        } finally {
          await blocker.query('ROLLBACK'); blocker.release();
          assert.equal(state.principal, principal); assert.deepEqual(state, snapshot);
        }
      } as typeof original;
      try {
        const response = await clients.owner.post(url, body);
        assert.equal(response.status, 409, JSON.stringify(response.body));
        assert.equal((response.body as { code: string }).code, 'validation.revision_conflict');
        assert.equal((response.body as { details: { reason: string } }).details.reason, 'authority_busy');
        assert.ok(!JSON.stringify(response.body).includes('reviewId'));
        assert.equal(calls, 1); assert.equal(executions, 1);
        assert.deepEqual(await counts(), before, target);
      } finally { principals.runAs = original; }
    }
  });
  await t.test('before/after COMMIT crashes preserve one mutation, audit and outbox and never return a rolled-back review', async () => {
    const crash = await installCrashPoints(h.db.admin);
    const evidence = await stage();
    let reviewId = '';
    for (const operation of ['propose', 'activate'] as const) {
      const key = `synthetic-crash-${operation}`;
      const client = operation === 'propose' ? clients.owner : clients.officer;
      const path = operation === 'propose' ? `evidence/${evidence.id}/review` : `reviews/${reviewId}/activate`;
      const send = () => client.post(`/v1/admin/jurisdiction-applicability/${path}`, { evidenceDigest: evidence.digest, reason: 'Synthetic reviewed evidence' }, { idempotencyKey: key });
      const before = await counts();
      const headBefore = await image('jurisdiction_applicability_current', 'subject_id', f.p.outsider);
      try {
        await crash.arm('handler', 'bookkeeping');
        const failed = await send();
        assert.equal(failed.status, 500);
        assert.ok(!JSON.stringify(failed.body).includes('reviewId'));
        assert.deepEqual(await counts(), before);
        assert.deepEqual(await image('jurisdiction_applicability_current', 'subject_id', f.p.outsider), headBefore);
        assert.equal((await recordState(h.db.admin, key))?.result, null);
        await crash.disarm('handler');
        assert.equal((await send()).status, 409);
        h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
        const done = await send();
        assert.equal(done.status, 200, JSON.stringify(done.body));
        reviewId = (done.body as { reviewId: string }).reviewId;
        const after = { ...before, [operation === 'propose' ? 'reviews' : 'activations']: before[operation === 'propose' ? 'reviews' : 'activations'] + 1, audits: before.audits + 1, outbox: before.outbox + 1 };
        assert.deepEqual(await counts(), after);
        assert.equal((await recordState(h.db.admin, key))?.state, 'completed');
        // The caller discards the successful response, then retries after another lease.
        h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
        const replay = await send(); assert.equal(replay.status, 200); assert.deepEqual(replay.body, done.body);
        assert.deepEqual(await counts(), after);
      } finally { await crash.clear(); h.clock.reset(); }
    }
  });
});
