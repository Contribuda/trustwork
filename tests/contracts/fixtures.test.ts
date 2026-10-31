import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as c from '../../packages/contracts/src/index.js';

const dir = new URL('../../packages/contracts/fixtures/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();
assert.deepEqual(files, ['mixed-company.json', 'personal-project.json', 'pure-participant.json', 'rfq-amendment.json']);
const schemaFor = (name: string) => (c as Record<string, unknown>)[`${name}Schema`] as { safeParse(v: unknown): { success: boolean; error?: unknown } } | undefined;

for (const file of files) {
  const fixture = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { $fixture: string; synthetic: boolean; records: Record<string, unknown[]>; expectations: Record<string, unknown> };
  test(`${file}: every record validates against its named schema and is synthetic`, () => {
    assert.equal(fixture.synthetic, true);
    assert.equal(`${fixture.$fixture}.json`, file);
    for (const [name, rows] of Object.entries(fixture.records)) {
      const schema = schemaFor(name);
      assert.ok(schema, `schema ${name}`);
      for (const row of rows) {
        const result = schema.safeParse(row);
        assert.ok(result.success, `${name}: ${JSON.stringify(result.error)}`);
      }
    }
  });
  test(`${file}: recorded digests reproduce from stored content`, () => {
    for (const v of (fixture.records.RfqVersion ?? []) as c.RfqVersion[]) if (v.digest) assert.ok(c.verifyRfqVersionDigest(v), v.id);
    for (const v of (fixture.records.QuoteVersion ?? []) as c.QuoteVersion[]) if (v.digest) assert.ok(c.verifyQuoteVersionDigest(v), v.id);
    for (const a of (fixture.records.Agreement ?? []) as c.Agreement[]) assert.deepEqual(a.acceptedTerms.digest, c.computeAgreementDigest(a.acceptedTerms.quoteVersion, a.acceptedTerms.rfqVersion));
  });
  test(`${file}: forbidden-field expectations hold on the serialized projections`, () => {
    for (const [key, forbidden] of Object.entries(fixture.expectations).filter(([k]) => k.startsWith('forbiddenIn'))) {
      const target = key.replace('forbiddenIn', '');
      const projectionKey = target.charAt(0).toLowerCase() + target.slice(1);
      const projection = fixture.expectations[projectionKey];
      assert.notEqual(projection, undefined, projectionKey);
      const json = JSON.stringify(projection);
      for (const field of forbidden as string[]) assert.ok(!json.includes(`"${field}"`), `${projectionKey} leaks ${field}`);
    }
  });
}
test('pure participant has no membership and no commercial authority', () => {
  const f = JSON.parse(readFileSync(new URL('pure-participant.json', dir), 'utf8'));
  const principal = c.PrincipalSchema.parse(f.records.Principal[0]);
  assert.equal(principal.membership, null);
  assert.deepEqual(principal.staff, []);
  assert.equal(f.records.Membership, undefined);
});
test('mixed company: same person is buyer-side RFQ owner and seller-side quote author; budgets are of two kinds', () => {
  const f = JSON.parse(readFileSync(new URL('mixed-company.json', dir), 'utf8'));
  const rfq = c.RfqSchema.parse(f.records.Rfq[0]);
  const quote = c.QuoteSchema.parse(f.records.Quote[0]);
  assert.deepEqual(rfq.owner, quote.seller);
  assert.equal(rfq.creatorPersonId, c.QuoteVersionSchema.parse(f.records.QuoteVersion[0]).sentBy!.personId);
  assert.deepEqual((f.records.Budget as c.Budget[]).map((b) => b.kind).sort(), ['platform', 'transaction']);
  assert.equal(f.expectations.budgetKindForPlaceOrder, 'transaction');
  assert.equal(f.expectations.budgetKindForDeliverable, 'platform');
});
test('personal project: private by default, supplier participation scoped, transfer needs consent', () => {
  const f = JSON.parse(readFileSync(new URL('personal-project.json', dir), 'utf8'));
  const project = c.ProjectSchema.parse(f.records.Project[0]);
  assert.equal(project.owner.kind, 'person');
  assert.equal(f.expectations.publicProject, null);
  assert.equal(f.expectations.transferEffectiveAllowedFromProposed, false);
  const participation = c.ObjectParticipationSchema.parse(f.records.ObjectParticipation[0]);
  assert.equal(participation.audience, 'shared_party');
  assert.ok(!participation.capabilities.includes('read.owner_private'));
});
test('rfq amendment expectations are reproduced by the pure functions', () => {
  const f = JSON.parse(readFileSync(new URL('rfq-amendment.json', dir), 'utf8'));
  assert.deepEqual([f.expectations.v1QuoteStale, f.expectations.v2QuoteStale, f.expectations.invitationStale], [true, false, true]);
  assert.equal(f.expectations.acceptV1, 'commercial.stale_version');
  assert.equal(f.expectations.acceptV2, 'ok');
  assert.ok(f.expectations.rfqDigestsDiffer && f.expectations.v3DraftDigestEqualsV1 && f.expectations.v3IdDiffersFromV1);
});
