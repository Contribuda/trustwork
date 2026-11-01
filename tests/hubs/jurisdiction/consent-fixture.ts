import { withMaintenance, type DataPool } from '@trustwork/data';
import { jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';

export async function consentFixture(admin: DataPool, app: DataPool, shared?: Parameters<typeof authorityFixture>[2], completeLanguages = false) {
  const f = await authorityFixture(admin, app, shared, completeLanguages);
  const deal = await createQuote(f.a.as, f.p.outsider, f.p.moderator);
  await f.attest('person', f.p.outsider);
  await f.attest('person', f.p.moderator);
  await f.attest('project', deal.projectId);
  const source = sourceDocument('US', 'synthetic-typed-consent');
  source.consentScopes = ['buyer', 'seller'].map(affectedParty => ({
    requirement: 'synthetic.electronicRecords', purpose: 'synthetic.quoteProcessing', action: 'send_quote' as const,
    affectedParty: affectedParty as 'buyer' | 'seller', noticeKey: 'synthetic.agentTerms',
  }));
  const imported = await withMaintenance(admin, trx => jurisdictionEvidence.importSource(trx, source));
  Object.assign(f.payload.agentSettings.jurisdictions[0]!, {
    sourceId: imported.id, sourceRevision: imported.revision, sourceDigest: imported.digest,
    consentScopes: source.consentScopes,
  });
  await f.activate(await f.draft());
  const publishLegal = async () => {
    // Same synthetic visibility fixture as public-legal.test.ts. Launch gates are not accepted by this test.
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE trustwork.hub DISABLE TRIGGER hub_lifecycle_guard');
      await c.query("UPDATE trustwork.hub SET lifecycle='soft_launch' WHERE id=$1", [f.hubId]);
      await c.query('ALTER TABLE trustwork.hub ENABLE TRIGGER hub_lifecycle_guard');
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  return { ...f, ...deal, publishLegal };
}
