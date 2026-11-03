import assert from 'node:assert/strict';
import test from 'node:test';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { BUILT_IN_PACKS, checkPackFile, installPacks, packs, resetPacks } from '@trustwork/country-packs';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { addLogins, signIn } from '../admin/helpers.js';
import { seedFixtures, principalFor } from '../data/helpers/seed.js';
import { syntheticPack } from '../config/helpers.js';
import { privacyPolicies, privacyPolicyFromPack, type PrivacyPackLike } from '../../packages/data/src/repositories/privacy.js';
import { PrivacyPolicySchema } from '../../packages/contracts/src/privacy.js';

const source = (what: string) => [{ url: `https://example.invalid/xf/${what}`, what: `synthetic ${what}`, accessed: '2026-11-01' }];
const law = (id: string, days: number | undefined, verification = 'official', extra: Record<string, unknown> = {}) => ({
  type: 'law', id, name: { en: `Synthetic privacy act ${id}` }, verification, sources: source(id), ...(days === undefined ? {} : { subjectRequestDays: days }), ...extra,
});
const retention = (id: string, years: number, verification = 'official') => ({ type: 'retention', id, record: { en: `Synthetic records ${id}` }, years, verification, sources: source(id) });
/** The synthetic federal pack (code XF, nothing real) with the given privacy facts, validated like a deployment pack. */
function xf(privacy: unknown[]) {
  const raw = syntheticPack('en');
  const check = checkPackFile('xf.json', { ...raw, facets: { ...(raw.facets as Record<string, unknown> | undefined), privacy } });
  assert.deepEqual(check.problems, []);
  return check.pack!;
}
const toSchema = (d: ReturnType<typeof privacyPolicyFromPack>) => ({ country: d.country, version: d.version, review: d.review, sources: d.sources,
  deadlineDays: d.deadlineDays, retentionDays: d.retentionDays, registryPollHours: d.registryPollHours, registryDeadlineDays: d.registryDeadlineDays });

test('PRV-001 deadlines and retention bounds come from the country pack, never from code', async (t) => {
  await t.test('no built-in pack carries a sourced subject-request deadline today, so every country stays UNKNOWN with named reasons', () => {
    const derived = privacyPolicies.fromPacks(BUILT_IN_PACKS as readonly PrivacyPackLike[]);
    assert.deepEqual(derived.map((d) => d.country), [...BUILT_IN_PACKS.map((p) => p.code)].sort());
    for (const d of derived) {
      assert.equal(d.review, 'UNKNOWN', d.country);
      assert.equal(d.deadlineDays, null); assert.equal(d.retentionDays, null);
      assert.ok(d.reasons.includes('no_subject_request_deadline_fact'), `${d.country}: ${d.reasons.join(',')}`);
      assert.ok(d.version.startsWith(`pack:${d.country}:`));
      assert.ok(PrivacyPolicySchema.safeParse(toSchema(d)).success, d.country);
      assert.ok(d.gaps.includes('registry_cadence_not_in_pack_schema'));
    }
    const us = derived.find((d) => d.country === 'US')!;
    assert.equal(us.facts.retention, 'irs-tax-records', 'the US pack already carries an official retention fact');
    assert.ok(!us.reasons.includes('no_retention_fact'));
  });
  await t.test('official sourced facts verify a policy; the strictest deadline and the longest retention win', () => {
    const d = privacyPolicyFromPack(xf([law('consumer-privacy', 45), law('state-privacy', 30), retention('tax', 7), retention('contracts', 4)]) as PrivacyPackLike);
    assert.equal(d.review, 'verified');
    assert.equal(d.deadlineDays, 30); assert.equal(d.facts.deadline, 'state-privacy');
    assert.equal(d.retentionDays, Math.ceil(7 * 365.25)); assert.equal(d.facts.retention, 'tax');
    assert.deepEqual(d.reasons, []);
    assert.deepEqual(d.sources, ['https://example.invalid/xf/state-privacy', 'https://example.invalid/xf/tax']);
    assert.ok(PrivacyPolicySchema.safeParse(toSchema(d)).success);
    const sameFacts = privacyPolicyFromPack(xf([law('state-privacy', 30), retention('tax', 7)]) as PrivacyPackLike);
    assert.equal(sameFacts.version, d.version, 'the version depends on the contributing facts only');
    const changedSource = privacyPolicyFromPack(xf([{ ...law('state-privacy', 30), sources: source('state-privacy-amended') }, retention('tax', 7)]) as PrivacyPackLike);
    assert.notEqual(changedSource.version, d.version, 'a changed source changes the policy version');
  });
  await t.test('unverified, expired or missing facts keep the country UNKNOWN; a law without a deadline is not a deadline', () => {
    const pending = privacyPolicyFromPack(xf([law('consumer-privacy', 45, 'secondary'), retention('tax', 7)]) as PrivacyPackLike);
    assert.equal(pending.review, 'UNKNOWN'); assert.deepEqual(pending.reasons, ['deadline_fact_unverified:consumer-privacy:secondary']);
    assert.equal(pending.deadlineDays, null); assert.equal(pending.retentionDays, null, 'an UNKNOWN policy carries no partial numbers');
    const noRetention = privacyPolicyFromPack(xf([law('consumer-privacy', 45)]) as PrivacyPackLike);
    assert.deepEqual(noRetention.reasons, ['no_retention_fact']);
    const pendingRetention = privacyPolicyFromPack(xf([law('consumer-privacy', 45), retention('tax', 7, 'pending')]) as PrivacyPackLike);
    assert.deepEqual(pendingRetention.reasons, ['retention_fact_unverified:tax:pending']);
    const expired = privacyPolicyFromPack(xf([law('old-act', 10, 'official', { effectiveTo: '2020-01-01' }), law('consumer-privacy', 45), retention('tax', 7)]) as PrivacyPackLike, new Date('2026-11-01T00:00:00Z'));
    assert.equal(expired.deadlineDays, 45, 'an expired fact does not shorten the deadline');
    const future = privacyPolicyFromPack(xf([law('next-act', 10, 'official', { effectiveFrom: '2030-01-01' }), law('consumer-privacy', 45), retention('tax', 7)]) as PrivacyPackLike, new Date('2026-11-01T00:00:00Z'));
    assert.equal(future.deadlineDays, 45);
    const noDeadline = privacyPolicyFromPack(xf([law('coppa-like', undefined), retention('tax', 7)]) as PrivacyPackLike);
    assert.deepEqual(noDeadline.reasons, ['no_subject_request_deadline_fact']);
    const disabled = privacyPolicyFromPack({ ...(xf([law('consumer-privacy', 45), retention('tax', 7)]) as PrivacyPackLike), enabled: false });
    assert.deepEqual(disabled.reasons, ['pack_disabled']);
  });

  const h = await startHarness('privacy_pack_policy');
  if (!h) { t.skip(SKIP_REASON); return; }
  t.after(async () => { resetPacks(); await h.close(); });
  const seed = await seedFixtures(h.db.admin);
  await addLogins(h, [[seed.people.petr, 'synthetic-pack-policy-petr@example.invalid']]);
  const petr = h.client(); await signIn(petr, 'synthetic-pack-policy-petr@example.invalid');
  const subject = { kind: 'person' as const, id: seed.people.petr };
  const sync = () => withMaintenance(h.db.admin, (trx) => privacyPolicies.apply(trx, privacyPolicies.fromPacks(packs() as readonly PrivacyPackLike[])));
  const request = async (country: string) => {
    const r = await petr.post('/v1/privacy/requests', { subject, country, kind: 'erasure' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as { created_at: string; deadline_at: string | null; retention_days: number | null; policy_status: string; policy_version: string | null };
  };
  await t.test('the sync writes UNKNOWN rows for the built-in packs; a request for such a country gets no deadline', async () => {
    const report = await sync();
    assert.deepEqual(report.manual, []);
    assert.ok(report.applied.every((r) => r.review === 'UNKNOWN' && r.changed));
    const second = await sync();
    assert.ok(second.applied.every((r) => !r.changed), 'the sync is idempotent');
    const r = await request('US');
    assert.equal(r.policy_status, 'UNKNOWN'); assert.equal(r.deadline_at, null); assert.equal(r.retention_days, null);
    assert.ok(r.policy_version?.startsWith('pack:US:'));
  });
  await t.test('an installed pack with official facts gives requests their deadline and retention; a later downgrade fails closed', async () => {
    installPacks([xf([law('consumer-privacy', 45), retention('tax', 7)])]);
    const report = await sync();
    assert.deepEqual(report.applied.filter((r) => r.country === 'XF').map((r) => [r.review, r.changed]), [['verified', true]]);
    const verified = await request('XF');
    assert.equal(verified.policy_status, 'verified');
    assert.equal(Date.parse(verified.deadline_at!) - Date.parse(verified.created_at), 45 * 86_400_000);
    assert.equal(verified.retention_days, Math.ceil(7 * 365.25));
    installPacks([xf([law('consumer-privacy', 45, 'pending'), retention('tax', 7)])]);
    const downgraded = await sync();
    const row = downgraded.applied.find((r) => r.country === 'XF')!;
    assert.equal(row.review, 'UNKNOWN'); assert.ok(row.changed); assert.notEqual(row.version, verified.policy_version);
    const after = await request('XF');
    assert.equal(after.policy_status, 'UNKNOWN'); assert.equal(after.deadline_at, null);
    assert.equal(verified.deadline_at !== null, true, 'the earlier request keeps the deadline it was created with');
  });
  await t.test('hand-written policy rows are reported and never overwritten; the runtime role cannot write policies', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('privacy_country_policy').values({ country: 'ZZ', version: 'synthetic-manual-v1', review: 'verified',
      sources: JSON.stringify(['https://example.invalid/synthetic-policy']), deadline_days: 3, retention_days: 7, registry_poll_hours: 6, registry_deadline_days: 4 }).execute());
    installPacks([{ ...xf([law('consumer-privacy', 45), retention('tax', 7)]), code: 'ZZ' }]);
    const report = await sync();
    assert.deepEqual(report.manual, ['ZZ']);
    assert.equal((await request('ZZ')).retention_days, 7);
    const p = await principalFor(h.db.admin, seed.people.petr);
    await assert.rejects(withPrincipal(h.pool, p, (trx) => trx.updateTable('privacy_country_policy').set({ deadline_days: 1 }).where('country', '=', 'ZZ').execute()), /permission denied/);
    await assert.rejects(withPrincipal(h.pool, p, (trx) => trx.insertInto('privacy_country_policy').values({ country: 'ZY', version: 'forged', review: 'verified', sources: JSON.stringify(['https://example.invalid/forged']), deadline_days: 1, retention_days: 1, registry_poll_hours: null, registry_deadline_days: null }).execute()), /permission denied/);
  });
});
