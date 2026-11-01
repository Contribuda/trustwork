import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { PublicLegalDocumentsSchema } from '@trustwork/contracts';
import { legalActivationDigestInput, type LegalDocumentKind } from '../../packages/contracts/src/hub-core.js';
import { legalDocuments } from '../../packages/data/src/repositories/hubs.js';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { jurisdictionOpenPath } from '../../apps/api/src/modules/jurisdiction/gate.js';
import { Client, SKIP_REASON, startHarness, type Harness } from '../backend/helpers/app.js';
import { actors, buildHubWorld, syncKernel } from './helpers.js';

const h = await startHarness('hubs_public_legal');

function apiFor(harness: Harness, hubId: string): Promise<CreatedApp> {
  return createApp({
    env: {
      API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', MAIL_SECRET_KEY: randomBytes(32).toString('hex'),
      TRUSTWORK_HUB_ID: hubId,
    },
    pool: harness.pool, clock: harness.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
}

test('GET /v1/legal is an open door of the API jurisdiction gate (ADR 014 decision 6)', () => {
  assert.equal(jurisdictionOpenPath('/v1/legal'), true);
  assert.equal(jurisdictionOpenPath('/v1/legal?x=1'), true);
  assert.equal(jurisdictionOpenPath('/v1/legal/other'), false);
  assert.equal(jurisdictionOpenPath('/v1/hubs/x/legal'), false);
});

/**
 * QA-002 D4: the active legal texts of the hub this API serves (`TRUSTWORK_HUB_ID`), for everyone without a session.
 * Drafts never appear; nothing appears before the hub is visible to everyone; an API that serves no hub says so.
 */
test('public legal texts of the served hub', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  await syncKernel(h.db.admin);
  const w = await buildHubWorld(h.db.admin);
  const a = actors(h.db.admin, h.pool, w);
  const p = w.people;
  await a.assignSensitive({ personId: p.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub('synthetic-public-legal')).hub_id;
  await a.assignSensitive({ personId: p.owner, role: 'hub-owner', scope: { kind: 'hub', hubId } });
  await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId } });
  const draft = (kind: LegalDocumentKind, body: string) => a.cmd(p.owner, (trx, ctx) => legalDocuments.draft(trx, ctx, hubId, { kind, locale: 'en', body }));
  const terms = await draft('terms', 'Synthetic terms of the public legal test hub');
  const privacyDraft = await draft('privacy_notice', 'Synthetic privacy notice, still a draft');
  const counsel = await a.cmd(p.officer, (trx, ctx) => legalDocuments.recordCounselApproval(trx, ctx, hubId, {
    documentVersionIds: [terms.id], counselName: 'Synthetic Counsel', firm: 'Synthetic Firm LLP', approvedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), scopeNote: 'Synthetic review',
  }));
  const approval = await a.approve(p.officer, p.owner, 'legal.activate_document_version', hubId,
    legalActivationDigestInput({ id: terms.id, hubId, kind: 'terms', locale: 'en', version: terms.version, bodyDigest: terms.body_digest, counselApprovalId: counsel.id }));
  await a.cmd(p.officer, (trx, ctx) => legalDocuments.activate(trx, ctx, terms.id, null, approval));

  // Like the content module, the legal route reads TRUSTWORK_HUB_ID per request (a hub set up after start is picked up).
  const previousHub = process.env.TRUSTWORK_HUB_ID;
  const served = await apiFor(h, hubId);
  t.after(async () => {
    if (previousHub === undefined) delete process.env.TRUSTWORK_HUB_ID;
    else process.env.TRUSTWORK_HUB_ID = previousHub;
    await served.close();
    await h.close();
  });
  const read = async (hub: string | null) => {
    if (hub) process.env.TRUSTWORK_HUB_ID = hub;
    else delete process.env.TRUSTWORK_HUB_ID;
    const response = await new Client(served).get('/v1/legal');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return PublicLegalDocumentsSchema.parse(response.body);
  };

  await t.test('an API that serves no hub says so and lists nothing', async () => {
    assert.deepEqual(await read(null), { hubConfigured: false, documents: [] });
  });

  await t.test('before the hub is visible to everyone, nothing is listed, not even its active text', async () => {
    assert.deepEqual(await read(hubId), { hubConfigured: true, documents: [] });
  });

  await t.test('a launched hub lists its active texts to anonymous callers, never a draft', async () => {
    // Test shortcut: the launch gates and the second-person lifecycle are HUB-001's own tests; here the hub only needs
    // to be visible, so the lifecycle guard is bypassed once, as the superuser, in this test database.
    const client = await h.db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE trustwork.hub DISABLE TRIGGER hub_lifecycle_guard');
      await client.query("UPDATE trustwork.hub SET lifecycle = 'soft_launch' WHERE id = $1", [hubId]);
      await client.query('ALTER TABLE trustwork.hub ENABLE TRIGGER hub_lifecycle_guard');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const listed = await read(hubId);
    assert.equal(listed.hubConfigured, true);
    assert.deepEqual(listed.documents.map((d) => [d.kind, d.locale, d.version, d.id]), [['terms', 'en', 1, terms.id]]);
    const [doc] = listed.documents;
    assert.equal(doc!.body, 'Synthetic terms of the public legal test hub');
    assert.equal(doc!.bodyDigest, createHash('sha256').update(doc!.body, 'utf8').digest('hex'));
    assert.ok(doc!.activatedAt);
    assert.ok(!JSON.stringify(listed).includes(privacyDraft.id), 'a draft is never public');
    assert.ok(!JSON.stringify(listed).includes('still a draft'));
  });
});
