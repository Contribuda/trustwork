import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDigest } from '@trustwork/contracts';
import { jurisdictionDisclosure } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { validateJurisdictionTemplate, type ImmutableDisclosureTemplate } from '../../../apps/api/src/modules/hubs/jurisdiction/disclosure-port.js';
import { provisionTestDatabase } from '../../data/helpers/postgres.js';
import { LOCALES } from './fixtures.js';
import { consentFixture } from './consent-fixture.js';

const db = await provisionTestDatabase('jurisdiction_disclosure', { weight: 2 });
test('immutable complete-language disclosure port; no OUTR runtime or activation claim', { skip: !db }, async t => {
  if (!db) return; t.after(() => db.close()); await db.migrate(); await db.createAppLogin();
  const f = await consentFixture(db.admin, db.app, undefined, true); await f.publishLegal();
  const current = await db.admin.query("SELECT version_id FROM trustwork.hub_config_current WHERE hub_id=$1 AND domain='jurisdiction'", [f.hubId]);
  const versionId = current.rows[0]!.version_id as string;
  const ctx = await f.a.elevate(f.p.owner);
  const bundle = await f.a.as(f.p.owner, trx => jurisdictionDisclosure.current(trx, f.world.sessions.owner, ctx, versionId));
  assert.deepEqual(bundle.locales, LOCALES);
  const content = { id: versionId, version: 1, policyVersionId: versionId, policyDigest: bundle.policyDigest,
    variants: bundle.bindings.map(b => ({ jurisdiction: b.jurisdiction, locale: b.locale, blocks: [
      { kind: 'automated_assistant', locked: true, text: b.body, documentId: b.documentId, bodyDigest: b.bodyDigest },
      ...['operator_identification', 'data_sources', 'page_link', 'correct_or_remove', 'unsubscribe'].map(kind => ({ kind, locked: true, text: 'Synthetic owning OUTR port fixture' })),
    ] })),
  };
  const template = { ...content, digest: computeDigest(content).value };
  const validate = (candidate: ImmutableDisclosureTemplate | null) => f.a.as(f.p.owner, trx => validateJurisdictionTemplate(trx, {
    loadOwningTemplate: async () => candidate,
    loadCurrentDisclosure: tx => jurisdictionDisclosure.current(tx, f.world.sessions.owner, ctx, versionId),
  }, versionId));
  assert.equal((await validate(template)).status, 'validated');
  assert.equal((await validate(null)).status, 'unavailable');
  for (const change of ['missing_language', 'removed_disclosure', 'unlocked', 'changed_text', 'stale_policy', 'missing_opt_out'] as const) {
    const bad = structuredClone(content);
    if (change === 'missing_language') bad.variants.pop();
    if (change === 'removed_disclosure') bad.variants[0]!.blocks.shift();
    if (change === 'unlocked') bad.variants[0]!.blocks[0]!.locked = false;
    if (change === 'changed_text') bad.variants[0]!.blocks[0]!.text = 'Unreviewed replacement';
    if (change === 'stale_policy') bad.policyDigest = '0'.repeat(64);
    if (change === 'missing_opt_out') bad.variants[0]!.blocks.pop();
    assert.equal((await validate({ ...bad, digest: computeDigest(bad).value })).status, 'unavailable', change);
  }
  await assert.rejects(f.a.as(f.p.outsider, trx => jurisdictionDisclosure.current(trx, f.world.sessions.outsider, ctx, versionId)), { code: '42501' });
});
