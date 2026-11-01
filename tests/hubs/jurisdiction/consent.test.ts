import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { sql } from 'kysely';
import { JurisdictionConsentPreviewSchema, JurisdictionConsentReceiptSchema } from '../../../packages/contracts/src/jurisdiction.js';
import { jurisdictionConsent, jurisdictionAuthority } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { startHarness } from '../../backend/helpers/app.js';
import { consentFixture } from './consent-fixture.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function waiting(admin: DataPool) {
  for (let n = 0; n < 100; n++) {
    if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rowCount) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('competitor did not reach the database lock');
}
const h = await startHarness('jurisdiction_consent');
test('typed consent through registered API and competing PostgreSQL connections', { skip: !h }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const f = await consentFixture(h.db.admin, h.pool);
  const { a, p, world, quoteId } = f;
  const clients = { buyer: h.client(), seller: h.client(), staff: h.client() };
  for (const [key, person] of [['buyer', 'outsider'], ['seller', 'moderator'], ['staff', 'owner']] as const) {
    const token = randomBytes(32).toString('base64url');
    await h.db.admin.query('UPDATE trustwork.session SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(token).digest(), world.sessions[person]]);
    clients[key].setSessionCookie(token);
  }
  const path = `/v1/jurisdiction-consents/quotes/${quoteId}`;
  const preview = async (who: 'buyer' | 'seller') => {
    const response = await clients[who].get(path);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return JurisdictionConsentPreviewSchema.parse(response.body);
  };
  const notices = {} as Record<'buyer' | 'seller', string>;
  await t.test('prelaunch counsel text, staff and anonymous access are refused', async () => {
    assert.equal((await preview('seller')).status, 'unavailable');
    assert.equal((await clients.staff.get(path)).status, 403);
    assert.equal((await h.client().get(path)).status, 401);
  });
  await f.publishLegal();
  await t.test('only own affected scope and complete current public language versions are returned', async () => {
    for (const who of ['buyer', 'seller'] as const) {
      const result = await preview(who);
      assert.equal(result.status, 'available'); assert.equal(result.notices.length, 1);
      const notice = result.notices[0]!; notices[who] = notice.noticeDigest;
      assert.equal(notice.affectedPersonId, who === 'buyer' ? p.outsider : p.moderator);
      assert.equal(notice.actorId, p.moderator);
      assert.deepEqual([...new Set(notice.documents.map(d => d.locale))].sort(), ['en', 'es']);
      assert.ok(notice.documents.every(d => d.body.startsWith('Synthetic machinery fixture')));
      assert.equal(JSON.stringify(result).includes('counselApprovalId'), false);
    }
  });
  await t.test('caller-selected subject, hub, approval, language or changed notice cannot authorize', async () => {
    for (const extra of [{ personId: p.outsider }, { hubId: f.hubId }, { approvalId: world.sessions.owner }]) {
      assert.equal((await clients.seller.post(path, { noticeDigest: notices.seller, locale: 'en', ...extra })).status, 422);
    }
    for (const body of [{ noticeDigest: notices.buyer, locale: 'en' }, { noticeDigest: notices.seller, locale: 'ka' }, { noticeDigest: 'a'.repeat(64), locale: 'en' }]) {
      assert.equal((await clients.seller.post(path, body)).status, 422);
    }
    await assert.rejects(a.as(p.moderator, trx => jurisdictionConsent.grant(trx, world.sessions.outsider, quoteId, notices.seller, 'en')), { code: '42501' });
  });
  const receipts = {} as Record<'buyer' | 'seller', string>;
  await t.test('every affected party consents separately; retry preserves the exact immutable receipt', async () => {
    assert.equal((await a.as(p.moderator, trx => jurisdictionAuthority.limits(trx, quoteId, 'send_quote'))).consentSatisfied, false);
    for (const who of ['seller', 'buyer'] as const) {
      const body = { noticeDigest: notices[who], locale: 'en' };
      const r = await clients[who].post(path, body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      receipts[who] = JurisdictionConsentReceiptSchema.parse(r.body).receiptId;
      const replay = await clients[who].post(path, body);
      assert.deepEqual(replay.body, r.body);
      if (who === 'seller') assert.equal((await a.as(p.moderator, trx => jurisdictionAuthority.limits(trx, quoteId, 'send_quote'))).consentSatisfied, false);
    }
    assert.equal((await a.as(p.moderator, trx => jurisdictionAuthority.limits(trx, quoteId, 'send_quote'))).consentSatisfied, true);
    await assert.rejects(h.db.admin.query("UPDATE trustwork.jurisdiction_consent_receipt SET locale='es' WHERE id=$1", [receipts.seller]), { code: '23000' });
    assert.equal((await clients.seller.post(path, { noticeDigest: notices.seller, locale: 'es' })).status, 422);
  });
  await t.test('current check wins: competing revocation waits, then all later checks refuse', async () => {
    const entered = barrier(), release = barrier();
    const first = a.as(p.moderator, async trx => { const r = await jurisdictionAuthority.limits(trx, quoteId, 'send_quote'); entered.resolve(); await release.promise; return r; });
    await entered.promise;
    const second = clients.buyer.post(`/v1/jurisdiction-consents/${receipts.buyer}/revoke`, {});
    try { await waiting(h.db.admin); } finally { release.resolve(); }
    assert.equal((await first).consentSatisfied, true);
    assert.equal((await second).status, 200);
    assert.equal((await a.as(p.moderator, trx => jurisdictionAuthority.limits(trx, quoteId, 'send_quote'))).consentSatisfied, false);
    assert.equal((await clients.buyer.post(path, { noticeDigest: notices.buyer, locale: 'en' })).status, 422);
  });
  await t.test('revocation wins: waiting current check sees it', async () => {
    const entered = barrier(), release = barrier();
    const first = a.as(p.moderator, async trx => { await jurisdictionConsent.revoke(trx, world.sessions.moderator, receipts.seller); entered.resolve(); await release.promise; });
    await entered.promise;
    const second = a.as(p.moderator, trx => jurisdictionAuthority.limits(trx, quoteId, 'send_quote'));
    try { await waiting(h.db.admin); } finally { release.resolve(); }
    await first; assert.equal((await second).consentSatisfied, false);
    assert.equal((await clients.seller.post(`/v1/jurisdiction-consents/${receipts.buyer}/revoke`, {})).status, 403);
  });
  await t.test('session revoked while the request waits on domain lock is refused after the wait', async () => {
    const entered = barrier(), release = barrier();
    const first = withMaintenance(h.db.admin, async trx => {
      await sql`SELECT trustwork.jurisdiction_lock()`.execute(trx); entered.resolve(); await release.promise;
    });
    await entered.promise;
    const second = clients.seller.get(path);
    try {
      await waiting(h.db.admin);
      await h.db.admin.query("UPDATE trustwork.session SET revoked_at=clock_timestamp(),revoked_reason='logout' WHERE id=$1", [world.sessions.moderator]);
    } finally { release.resolve(); }
    await first; assert.equal((await second).status, 403);
  });
});
