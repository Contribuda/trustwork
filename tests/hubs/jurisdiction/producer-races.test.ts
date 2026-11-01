import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { hubConfig } from '../../../packages/data/src/repositories/hubs.js';
import { jurisdictionAuthority, jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { jurisdictionIssuers } from '../../../packages/data/src/repositories/jurisdiction-source.js';
import { provisionTestDatabase } from '../../data/helpers/postgres.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';
import { syntheticSourceAuthority } from './source-fixture.js';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function waitForLock(admin: DataPool) {
  for (let n = 0; n < 200; n++) {
    if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' LIMIT 1")).rowCount) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail('competing transaction never reached a database lock');
}
const db = await provisionTestDatabase('jurisdiction_producer_races', { weight: 2 });
test('owning source revocation, real modes and wall-clock races', { skip: !db }, async t => {
  if (!db) return; t.after(() => db.close()); await db.migrate(); await db.createAppLogin();
  const f = await authorityFixture(db.admin, db.app);
  const deal = await createQuote(f.a.as, f.p.outsider, f.p.moderator);
  const producer = await syntheticSourceAuthority(db.admin, f);
  const source = sourceDocument('US', 'synthetic-source-races'); source.policy.consentRequirements = [];
  const imported = await withMaintenance(db.admin, trx => jurisdictionEvidence.importSource(trx, source));
  Object.assign(f.payload.agentSettings.jurisdictions[0]!, { sourceId: imported.id, sourceRevision: imported.revision, sourceDigest: imported.digest, policy: source.policy });
  await f.activate(await f.draft());
  const issueAll = async () => {
    await producer.issue('person', f.p.outsider, deal.quoteId);
    await producer.issue('project', deal.projectId, deal.quoteId);
    return producer.issue('person', f.p.moderator, deal.quoteId);
  };
  const resolve = () => f.a.as(f.p.moderator, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'send_quote'));
  let evidence = await issueAll();
  for (const first of ['revoke', 'consume'] as const) await t.test(`source ${first} wins the actual HUB fence`, async () => {
    if (first === 'consume') evidence = await issueAll();
    const ctx = await f.a.elevate(f.p.owner), entered = barrier(), release = barrier();
    const revoke = async (hold = false) => f.a.as(f.p.owner, async trx => {
      await jurisdictionIssuers.revoke(trx, f.world.sessions.owner, ctx, 'source', evidence.sourceId, evidence.sourceDigest);
      if (hold) { entered.resolve(); await release.promise; }
    });
    const consume = async (hold = false) => f.a.as(f.p.moderator, async trx => {
      const result = await jurisdictionAuthority.limits(trx, deal.quoteId, 'send_quote');
      if (hold) { assert.equal(result.status, 'resolved'); entered.resolve(); await release.promise; }
      return result;
    });
    const winner = first === 'revoke' ? revoke(true) : consume(true); await entered.promise;
    const waiter = first === 'revoke' ? consume() : revoke();
    try { await waitForLock(db.admin); } finally { release.resolve(); }
    await winner; const result = await waiter;
    if (first === 'revoke') assert.equal(result?.status, 'unknown');
    assert.equal((await resolve()).status, 'unknown');
  });
  await t.test('expiry after an actual quote lock wait refuses current proof', async () => {
    await issueAll();
    const short = await producer.payload('person', f.p.moderator, deal.quoteId);
    short.effectiveUntil = new Date(Date.now() + 1800).toISOString();
    await producer.activate(await producer.stage(short));
    const entered = barrier(), release = barrier();
    const owner = withMaintenance(db.admin, async trx => {
      await sql`SELECT id FROM trustwork.quote WHERE id=${deal.quoteId}::uuid FOR UPDATE`.execute(trx);
      entered.resolve(); await release.promise;
    });
    await entered.promise; const waiting = resolve();
    try {
      await waitForLock(db.admin);
      await new Promise(r => setTimeout(r, Math.max(1, Date.parse(short.effectiveUntil) - Date.now() + 30)));
    } finally { release.resolve(); }
    await owner; assert.equal((await waiting).status, 'unknown');
  });
  const modes = async (dataMode: 'live' | 'demo') => {
    const current = await db.admin.query('SELECT v.payload FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id=c.version_id WHERE c.hub_id=$1 AND c.domain=$2', [f.hubId, 'modes']);
    return f.a.cmd(f.p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, f.hubId, 'modes', { ...current.rows[0]!.payload, dataMode }));
  };
  const activateMode = (draft: Awaited<ReturnType<typeof modes>>, hold?: () => Promise<void>) => f.a.cmd(f.p.officer, async (trx, ctx) => {
    await hubConfig.activate(trx, ctx, draft.id, draft.revision, null); await hold?.();
  });
  await t.test('real live mode wins: current synthetic proof, replay and new import refuse', async () => {
    await issueAll(); const old = await producer.payload('person', f.p.moderator, deal.quoteId);
    const draft = await modes('live'), entered = barrier(), release = barrier();
    const first = activateMode(draft, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    try { await assert.rejects(resolve(), { code: '55P03' }); } finally { release.resolve(); }
    await first; assert.equal((await resolve()).status, 'unknown'); await assert.rejects(producer.stage(old));
    // Switching back never revives a proof bound to an older demo version.
    await activateMode(await modes('demo')); assert.equal((await resolve()).status, 'unknown');
    await assert.rejects(producer.stage(old));
  });
  await t.test('consumption wins: real mode activation waits, then immediately invalidates authority', async () => {
    await issueAll(); const draft = await modes('live'), entered = barrier(), release = barrier();
    const first = f.a.as(f.p.moderator, async trx => {
      assert.equal((await jurisdictionAuthority.limits(trx, deal.quoteId, 'send_quote')).status, 'resolved');
      entered.resolve(); await release.promise;
    });
    await entered.promise; const second = activateMode(draft);
    try { await waitForLock(db.admin); } finally { release.resolve(); }
    await first; await second; assert.equal((await resolve()).status, 'unknown');
    await activateMode(await modes('demo'));
  });
  for (const first of ['revoke', 'consume'] as const) await t.test(`issuer ${first} wins; no old-key revival`, async () => {
    const current = first === 'revoke' ? producer : await syntheticSourceAuthority(db.admin, f);
    for (const [kind, id] of [['person', f.p.outsider], ['person', f.p.moderator], ['project', deal.projectId]] as const) await current.issue(kind, id, deal.quoteId);
    const ctx = await f.a.elevate(f.p.owner), entered = barrier(), release = barrier();
    const revoke = async (hold = false) => f.a.as(f.p.owner, async trx => {
      await jurisdictionIssuers.revoke(trx, f.world.sessions.owner, ctx, 'issuer', current.proposed.id, current.proposed.digest);
      if (hold) { entered.resolve(); await release.promise; }
    });
    const consume = async (hold = false) => f.a.as(f.p.moderator, async trx => {
      const result = await jurisdictionAuthority.limits(trx, deal.quoteId, 'send_quote');
      if (hold) { assert.equal(result.status, 'resolved'); entered.resolve(); await release.promise; }
      return result;
    });
    const winner = first === 'revoke' ? revoke(true) : consume(true); await entered.promise;
    const waiter = first === 'revoke' ? consume() : revoke();
    try { await waitForLock(db.admin); } finally { release.resolve(); }
    await winner; const result = await waiter;
    if (first === 'revoke') assert.equal(result?.status, 'unknown');
    assert.equal((await resolve()).status, 'unknown');
  });
});
