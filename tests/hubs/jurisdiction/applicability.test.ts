import { staleRequest } from './current-request.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { staffAssignments } from '../../../packages/data/src/repositories/admin.js';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { jurisdictionApplicabilityReview as review, jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { startHarness } from '../../backend/helpers/app.js';
import { authorityFixture } from './authority-fixture.js';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const h = await startHarness('jurisdiction_applicability');
test('owning staged evidence review uses exact current two-person authority', { skip: !h }, async t => {
  if (!h) return; t.after(() => h.close());
  const f = await authorityFixture(h.db.admin, h.pool); const { a, p, world } = f;
  const stage = () => withMaintenance(h.db.admin, trx => jurisdictionEvidence.stageApplicability(trx, {
    subjectKind: 'person', subjectId: p.outsider, hubId: f.hubId, jurisdictions: ['US'],
    evidenceId: 'synthetic.reviewedDomainEvidence', evidenceDigest: 'd'.repeat(64), effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: '2099-01-01T00:00:00.000Z',
  }));
  const propose = async () => {
    const e = await stage(); const ctx = await a.elevate(p.owner);
    const r = await a.as(p.owner, trx => review.propose(trx, world.sessions.owner, ctx, e.id, e.digest));
    return { e, ctx, r };
  };
  await t.test('staging does not select a current head; caller scope and same-person activation refuse', async () => {
    const { e, ctx, r } = await propose();
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.jurisdiction_applicability_current WHERE subject_id=$1', [p.outsider])).rowCount, 0);
    await assert.rejects(a.as(p.owner, trx => review.activate(trx, world.sessions.owner, ctx, r.reviewId, e.digest)), { code: '42501' });
    const foreign = await a.elevate(p.otherOwner);
    await assert.rejects(a.as(p.otherOwner, trx => review.propose(trx, world.sessions.otherOwner, foreign, e.id, e.digest)), { code: '42501' });
    const officer = await a.elevate(p.officer);
    await assert.rejects(a.as(p.officer, trx => review.activate(trx, world.sessions.owner, officer, r.reviewId, e.digest)), { code: '42501' });
    await assert.rejects(a.as(p.officer, trx => review.activate(trx, world.sessions.officer, officer, r.reviewId, 'a'.repeat(64))), { code: '23514' });
    assert.equal((await a.as(p.officer, trx => review.activate(trx, world.sessions.officer, officer, r.reviewId, e.digest))).state, 'active');
    await assert.rejects(a.as(p.officer, trx => review.activate(trx, world.sessions.officer, officer, r.reviewId, e.digest)));
  });
  await t.test('registered API rejects invented jurisdiction and consumes an exact immutable staged evidence ID', async t => {
    const e = await stage(); const clients = { owner: h.client(), officer: h.client() };
    for (const key of ['owner', 'officer'] as const) {
      const token = randomBytes(32).toString('base64url');
      await h.db.admin.query('UPDATE trustwork.session SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(token).digest(), world.sessions[key]]);
      clients[key].setSessionCookie(token); h.staff.set(p[key], [key === 'owner' ? 'hub-owner' : 'compliance-officer']); await a.elevate(p[key]);
    }
    const path = `/v1/admin/jurisdiction-applicability/evidence/${e.id}/review`;
    assert.equal((await clients.owner.post(path, { evidenceDigest: e.digest, reason: 'Synthetic review', jurisdiction: 'US' })).status, 422);
    await t.test('resolved review does not refresh changed request authority', async () => {
      await staleRequest(h, () => clients.owner.post(path, { evidenceDigest: e.digest, reason: 'Synthetic stale review' }));
    });
    const r = await clients.owner.post(path, { evidenceDigest: e.digest, reason: 'Synthetic review' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const reviewId = (r.body as { reviewId: string }).reviewId;
    const audit = await h.db.admin.query('SELECT * FROM trustwork.admin_audit_event WHERE object_id=$1 AND action=$2', [reviewId, 'jurisdiction.applicability_proposed']);
    assert.equal(audit.rowCount, 1, 'a private review is not the shared administration audit');
    assert.equal(audit.rows[0]!.actor_person_id, p.owner);
    assert.equal(audit.rows[0]!.hub_id, f.hubId);
    assert.equal(audit.rows[0]!.reason_text, 'Synthetic review');
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.outbox_event WHERE aggregate_id=$1 AND type=$2', [reviewId, 'jurisdiction.applicability_proposed'])).rowCount, 1);
    await t.test('resolved activation does not refresh changed request authority', async () => {
      await staleRequest(h, () => clients.officer.post(`/v1/admin/jurisdiction-applicability/reviews/${(r.body as { reviewId: string }).reviewId}/activate`, { evidenceDigest: e.digest, reason: 'Synthetic stale activation' }));
    });
    const done = await clients.officer.post(`/v1/admin/jurisdiction-applicability/reviews/${(r.body as { reviewId: string }).reviewId}/activate`, { evidenceDigest: e.digest, reason: 'Synthetic second review' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
  });
  async function waiting() {
    for (let n = 0; n < 100; n++) {
      if ((await h!.db.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rowCount) return;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail('competitor did not reach database wait');
  }
  for (const target of ['elevation', 'role', 'epoch'] as const) {
    await t.test(`${target} change wins during domain wait: activation refuses current authority`, async () => {
      const { e, r } = await propose(); const officer = await a.elevate(p.officer);
      const entered = barrier(), release = barrier();
      const first = withMaintenance(h.db.admin, async trx => { await sql`SELECT trustwork.jurisdiction_lock()`.execute(trx); entered.resolve(); await release.promise; });
      await entered.promise;
      const second = a.as(p.officer, trx => review.activate(trx, world.sessions.officer, officer, r.reviewId, e.digest)).then(() => null, error => error as { code: string });
      try {
        await waiting();
        if (target === 'elevation') await h.db.admin.query("UPDATE trustwork.session_elevation SET revoked_at=clock_timestamp(),revoked_reason='ended' WHERE id=$1", [officer.elevationId]);
        if (target === 'epoch') await h.db.admin.query('UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1', [p.officer]);
        if (target === 'role') {
          const assignment = (await h.db.admin.query("SELECT id FROM trustwork.staff_role_assignment WHERE person_id=$1 AND role='compliance-officer' AND revoked_at IS NULL", [p.officer])).rows[0]!.id as string;
          await a.cmd(p.founder, (trx, ctx) => staffAssignments.revoke(trx, ctx, assignment));
        }
      } finally { release.resolve(); }
      await first; assert.equal((await second)?.code, '42501');
      if (target === 'role') {
        // A fresh grant cannot repair the old decision; it only enables a new independent proposal below.
        await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId: f.hubId } });
      }
    });
  }
  await t.test('activation wins: session revocation waits for the committed decision', async () => {
    const { e, r } = await propose(); const officer = await a.elevate(p.officer);
    const entered = barrier(), release = barrier();
    const first = a.as(p.officer, async trx => { const result = await review.activate(trx, world.sessions.officer, officer, r.reviewId, e.digest); entered.resolve(); await release.promise; return result; });
    await entered.promise;
    const second = h.db.admin.query("UPDATE trustwork.session SET revoked_at=clock_timestamp(),revoked_reason='logout' WHERE id=$1", [world.sessions.officer]);
    try { await waiting(); } finally { release.resolve(); }
    assert.equal((await first).state, 'active'); await second;
  });
});
