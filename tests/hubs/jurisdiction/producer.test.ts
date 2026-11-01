import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { importJurisdictionProof, jurisdictionIssuers } from '../../../packages/data/src/repositories/jurisdiction-source.js';
import { jurisdictionAuthority, jurisdictionEvidence, jurisdictionApplicabilityReview } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { projects } from '../../../packages/data/src/repositories/projects.js';
import { startHarness } from '../../backend/helpers/app.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';
import { syntheticSourceAuthority } from './source-fixture.js';
import { staleRequest } from './current-request.js';
import type { JurisdictionProofPayload } from '../../../packages/contracts/src/jurisdiction.js';

const h = await startHarness('jurisdiction_producer');
test('authenticated synthetic producer and scoped current evidence use actual owning rows', { skip: !h }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const f = await authorityFixture(h.db.admin, h.pool);
  const deal = await createQuote(f.a.as, f.p.outsider, f.p.moderator);
  const producer = await syntheticSourceAuthority(h.db.admin, f);
  const source = sourceDocument('US', 'synthetic-source-no-consent');
  source.policy.consentRequirements = [];
  const imported = await withMaintenance(h.db.admin, trx => jurisdictionEvidence.importSource(trx, source));
  Object.assign(f.payload.agentSettings.jurisdictions[0]!, { sourceId: imported.id, sourceRevision: imported.revision, sourceDigest: imported.digest, policy: source.policy });
  await f.activate(await f.draft());
  const limits = () => f.a.as(f.p.moderator, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'send_quote'));
  const counts = async () => (await h.db.admin.query('SELECT (SELECT count(*)::int FROM trustwork.jurisdiction_proof_record) proofs,(SELECT count(*)::int FROM trustwork.jurisdiction_applicability_origin) origins,(SELECT count(*)::int FROM trustwork.jurisdiction_scoped_head) heads')).rows[0];
  const payload = await producer.payload('person', f.p.outsider, deal.quoteId);

  await t.test('legacy maintenance assertions and independent legacy review do not authorize v2 consumption', async () => {
    for (const [kind, id] of [['person', f.p.outsider], ['person', f.p.moderator], ['project', deal.projectId]] as const) {
      await withMaintenance(h.db.admin, trx => jurisdictionEvidence.attestApplicability(trx, { subjectKind: kind, subjectId: id, hubId: f.hubId,
        jurisdictions: ['US'], evidenceId: 'synthetic.legacy', evidenceDigest: 'a'.repeat(64), effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: '2099-01-01T00:00:00.000Z' }));
    }
    assert.equal((await limits()).status, 'unknown');
  });
  await t.test('signature, missing competence/linkage, foreign scope, issuer and exact owner revisions refuse without partial imports', async () => {
    const before = await counts();
    const forged = producer.envelope(payload); forged.signature = `${'A'.repeat(86)}==`;
    await assert.rejects(withMaintenance(h.db.admin, trx => importJurisdictionProof(trx, forged)));
    const mutations: Array<(p: JurisdictionProofPayload) => void> = [
      p => { p.subject.id = f.p.owner; }, p => { p.subject.revision++; }, p => { p.subject.epoch = (p.subject.epoch ?? 0) + 1; },
      p => { p.context.id = randomUUID(); }, p => { p.context.digest = 'f'.repeat(64); }, p => { p.context.revision++; },
      p => { p.originHubId = f.otherHubId; p.audienceHubId = f.otherHubId; }, p => { p.keyId = 'synthetic.wrong'; },
      p => { p.issuerVersionId = randomUUID(); }, p => { p.issuerDigest = 'f'.repeat(64); }, p => { p.coverage.jurisdictions = ['CA']; },
      p => { p.coverage.competenceDigest = 'f'.repeat(64); }, p => { p.coverage.independenceEvidenceDigest = null; },
      p => { p.effectiveUntil = new Date(Date.now() - 1).toISOString(); }, p => { p.effectiveFrom = new Date(Date.now() + 60000).toISOString(); },
      p => { p.issuedAt = new Date(Date.now() + 60000).toISOString(); },
      p => { p.demoAuthority.version++; }, p => { p.demoAuthority.digest = 'f'.repeat(64); },
    ];
    for (const mutate of mutations) { const changed = structuredClone(payload); mutate(changed); await assert.rejects(producer.stage(changed)); }
    for (const changed of [{ ...payload, evidenceMode: 'operational' }, { ...payload, linkage: undefined }, { ...payload, verified: true }]) {
      await assert.rejects(withMaintenance(h.db.admin, trx => importJurisdictionProof(trx, { payload: changed, signature: forged.signature })));
    }
    await assert.rejects(withMaintenance(h.db.admin, trx => importJurisdictionProof(trx, { padding: 'x'.repeat(17000) })));
    assert.deepEqual(await counts(), before);
  });
  await t.test('authentic import stages only; two humans activate exact evidence; identical import replays', async () => {
    const evidence = await producer.stage(payload);
    assert.equal((await counts()).heads, 0);
    assert.equal((await limits()).status, 'unknown');
    assert.deepEqual(await producer.stage(payload), evidence);
    const ctx = await f.a.elevate(f.p.owner);
    const review = await f.a.as(f.p.owner, trx => jurisdictionApplicabilityReview.propose(trx, f.world.sessions.owner, ctx, evidence.id, evidence.digest));
    await assert.rejects(f.a.as(f.p.owner, trx => jurisdictionApplicabilityReview.activate(trx, f.world.sessions.owner, ctx, review.reviewId, evidence.digest)), { code: '42501' });
    await f.a.cmd(f.p.officer, (trx, officer) => jurisdictionApplicabilityReview.activate(trx, f.world.sessions.officer, officer, review.reviewId, evidence.digest));
    await producer.issue('person', f.p.moderator, deal.quoteId);
    await producer.issue('project', deal.projectId, deal.quoteId);
    const result = await limits(); assert.equal(result.status, 'resolved');
    for (const value of [payload.linkage.evidenceDigest, payload.coverage.basisDigest, producer.registration.publicKey, f.p.outsider, deal.projectId]) assert.ok(!JSON.stringify(result).includes(value));
    await assert.rejects(f.a.as(f.p.moderator, trx => sql`SELECT * FROM trustwork.jurisdiction_proof_record`.execute(trx)), { code: '42501' });
    await assert.rejects(f.a.as(f.p.owner, trx => sql`SELECT * FROM trustwork.jurisdiction_applicability_origin FOR UPDATE`.execute(trx)), { code: '42501' });
    await assert.rejects(f.a.as(f.p.moderator, trx => importJurisdictionProof(trx, producer.envelope(payload))), { code: '42501' });
    await assert.rejects(withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.jurisdiction_proof_record SET digest=${'f'.repeat(64)} WHERE id=${evidence.sourceId}::uuid`.execute(trx)), { code: '23000' });
  });
  await t.test('owning project revision change invalidates every bound source; no address or old proof fallback', async () => {
    const before = await limits(); assert.equal(before.status, 'resolved');
    await f.a.as(f.p.outsider, async trx => {
      const project = await projects.getById(trx, deal.projectId); assert.ok(project);
      assert.ok(await projects.update(trx, deal.projectId, project.revision, { summary: 'Synthetic changed owning context' }));
    });
    assert.equal((await limits()).status, 'unknown');
    for (const [kind, id] of [['person', f.p.outsider], ['person', f.p.moderator], ['project', deal.projectId]] as const) await producer.issue(kind, id, deal.quoteId);
    const after = await limits(); assert.equal(after.status, 'resolved'); assert.notEqual(after.bindingDigest, before.bindingDigest);
  });
  await t.test('a contradictory authentic current source refuses instead of selecting the convenient head', async () => {
    const conflict = await producer.payload('person', f.p.outsider, deal.quoteId, ['GB']);
    conflict.recordId = 'synthetic.independentConflictingRecord'; conflict.recordRevision = 1;
    const staged = await producer.stage(conflict);
    assert.equal((await limits()).status, 'unknown');
    await f.a.cmd(f.p.owner, (trx, ctx) => jurisdictionIssuers.revoke(trx, f.world.sessions.owner, ctx, 'source', staged.sourceId, staged.sourceDigest));
    assert.equal((await limits()).status, 'resolved');
    await assert.rejects(producer.stage(conflict));
  });
  await t.test('verifier pin, signed conflicting replay and transaction rollback cannot create another proof', async () => {
    const fresh = await producer.payload('person', f.p.moderator, deal.quoteId);
    const before = await counts();
    await assert.rejects(withMaintenance(h.db.admin, async trx => {
      await importJurisdictionProof(trx, producer.envelope(fresh));
      throw new Error('synthetic producer transaction abort');
    }), { message: 'synthetic producer transaction abort' });
    assert.deepEqual(await counts(), before);
    const registration = { ...producer.registration, issuerId: randomUUID(), implementationDigest: 'f'.repeat(64) };
    const v = await f.a.cmd(f.p.owner, (trx, ctx) => jurisdictionIssuers.propose(trx, f.world.sessions.owner, ctx, registration));
    await f.a.cmd(f.p.officer, (trx, ctx) => jurisdictionIssuers.activate(trx, f.world.sessions.officer, ctx, v.id, v.digest));
    await assert.rejects(producer.stage({ ...fresh, issuerVersionId: v.id, issuerDigest: v.digest }));
    assert.deepEqual(await counts(), before);
    const e = await producer.stage(fresh);
    const forgedRevision = structuredClone(fresh); forgedRevision.coverage.basisDigest = 'f'.repeat(64);
    const after = await counts(); await assert.rejects(producer.stage(forgedRevision)); assert.deepEqual(await counts(), after);
    await producer.activate(e);
  });
  await t.test('registered issuer API is scoped, independent, idempotent and refuses current stale request authority', async () => {
    const clients = { owner: h.client(), officer: h.client(), foreign: h.client() };
    for (const [key, person] of [['owner', 'owner'], ['officer', 'officer'], ['foreign', 'otherOwner']] as const) {
      const token = randomBytes(32).toString('base64url');
      await h.db.admin.query('UPDATE trustwork.session SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(token).digest(), f.world.sessions[person]]);
      clients[key].setSessionCookie(token); h.staff.set(f.p[person], [person === 'officer' ? 'compliance-officer' : 'hub-owner']); await f.a.elevate(f.p[person]);
    }
    const url = '/v1/admin/jurisdiction-sources/issuers';
    const registration = { ...producer.registration, issuerId: randomUUID() };
    const body = { registration, reason: 'Synthetic issuer test' };
    assert.equal((await clients.foreign.post(url, body)).status, 403);
    assert.equal((await clients.owner.post(url, { ...body, verified: true })).status, 422);
    await staleRequest(h, () => clients.owner.post(url, body));
    const proposeKey = { idempotencyKey: randomUUID() };
    const proposed = await clients.owner.post(url, body, proposeKey); assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    assert.deepEqual((await clients.owner.post(url, body, proposeKey)).body, proposed.body);
    const issuer = proposed.body as { id: string; digest: string };
    const activate = `${url}/${issuer.id}/activate`;
    const decision = { digest: issuer.digest, reason: 'Synthetic independent issuer activation' };
    assert.equal((await clients.owner.post(activate, decision)).status, 403);
    assert.equal((await clients.officer.post(activate, { ...decision, digest: 'f'.repeat(64) })).status, 422);
    const activateKey = { idempotencyKey: randomUUID() };
    assert.equal((await clients.officer.post(activate, decision, activateKey)).status, 200);
    assert.deepEqual((await clients.officer.post(activate, decision, activateKey)).body, { ...issuer, state: 'active' });
    const audit = await h.db.admin.query('SELECT action,after_digest FROM trustwork.admin_audit_event WHERE object_id=$1 ORDER BY sequence', [issuer.id]);
    assert.equal(audit.rowCount, 2);
    const exact = await h.db.admin.query(`SELECT trustwork.admin_digest(to_jsonb(v)) proposal,
      trustwork.admin_digest(jsonb_build_object('decision',to_jsonb(a),'head',to_jsonb(c))) activation
      FROM trustwork.jurisdiction_issuer_version v JOIN trustwork.jurisdiction_issuer_activation a ON a.version_id=v.id
      JOIN trustwork.jurisdiction_issuer_current c ON c.version_id=v.id WHERE v.id=$1`, [issuer.id]);
    assert.equal(audit.rows[0]!.after_digest, exact.rows[0]!.proposal);
    assert.equal(audit.rows[1]!.after_digest, exact.rows[0]!.activation);
    const outbox = await h.db.admin.query('SELECT payload FROM trustwork.outbox_event WHERE aggregate_id=$1 ORDER BY id', [issuer.id]);
    assert.equal(outbox.rowCount, 2);
    for (const row of outbox.rows) assert.deepEqual(Object.keys(row.payload).sort(), ['decisionId', 'requestId']);
    assert.equal((await clients.owner.post(`/v1/admin/jurisdiction-sources/issuer/${issuer.id}/revoke`, { digest: issuer.digest, reason: 'Synthetic issuer revocation' })).status, 200);
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.jurisdiction_issuer_revocation WHERE version_id=$1', [issuer.id])).rowCount, 1);
    // The earlier issuer depended on the exact original proposer epoch; changed authority cannot revive its proof.
    assert.equal((await limits()).status, 'unknown');
  });
});
