import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEDERATED_OBJECT_KINDS,
  FederatedEnvelopeSchema,
  GlobalIdSchema,
  ITEM_SYNDICATION_TERMS,
  NEVER_FEDERATED_PROJECTIONS,
  NodeHostSchema,
  OBJECT_KIND_RULES,
  PROJECTION_LAYERS,
  formatGlobalId,
  parseGlobalId,
  payloadProblems,
} from '../../../packages/contracts/src/index.js';
import { CITY, NATIONAL, THIRD, TEST_ADDRESSES, dealEnvelope, envelope, gid } from './fixtures.js';

const issues = (value: unknown) => {
  const result = FederatedEnvelopeSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
const rejected = (value: unknown, pattern: RegExp) => {
  const found = issues(value);
  assert.ok(found.length > 0, 'expected a rejection');
  assert.ok(found.some((m) => pattern.test(m)), `expected ${pattern} in ${JSON.stringify(found)}`);
};

test('node names are lowercase DNS names and never network addresses', () => {
  for (const ok of [NATIONAL, CITY, 'hub.example.co.uk', 'xn--80ak6aa92e.example.org']) assert.ok(NodeHostSchema.safeParse(ok).success, ok);
  for (const bad of [...TEST_ADDRESSES, '[2001:db8::5]', 'Build.Example.org', 'build.example.org.', 'build.example.org:8443', 'https://build.example.org', 'localhost', 'build', '-a.example.org', '1.2.3.4']) {
    assert.equal(NodeHostSchema.safeParse(bad).success, false, bad);
  }
});

test('global identifiers are derived trustwork:// names that round-trip and refuse addresses and unknown kinds', () => {
  const id = formatGlobalId({ host: NATIONAL, kind: 'publication', localId: '7b0c-1' });
  assert.equal(id, 'trustwork://build.example.org/publication/7b0c-1');
  assert.deepEqual(parseGlobalId(id), { host: NATIONAL, kind: 'publication', localId: '7b0c-1' });
  for (const bad of ['trustwork://192.0.2.44/publication/x', 'trustwork://build.example.org/review/x', 'https://build.example.org/publication/x', 'trustwork://build.example.org/publication/', 'trustwork://build.example.org/publication/a/b']) {
    assert.equal(GlobalIdSchema.safeParse(bad).success, false, bad);
  }
  assert.throws(() => formatGlobalId({ host: '192.0.2.44', kind: 'event', localId: 'x' }));
});

test('ACCEPTANCE: envelopes with party_private, owner_private or staff_case projections are rejected by schema', () => {
  assert.deepEqual(NEVER_FEDERATED_PROJECTIONS, PROJECTION_LAYERS.filter((l) => l !== 'public' && l !== 'shared_party'));
  for (const projection of NEVER_FEDERATED_PROJECTIONS) {
    rejected(envelope({ projection }), /projection: party_private, owner_private and staff_case projections never leave their node/);
    rejected(dealEnvelope({ projection }), /never leave their node/);
  }
  rejected(envelope({ projection: 'internal' }), /projection/);
  assert.deepEqual(issues(envelope()), []);
  assert.deepEqual(issues(dealEnvelope()), []);
});

test('ACCEPTANCE (backstop): private layers smuggled inside the payload are rejected by schema', () => {
  for (const marker of ['party_private', 'owner_private', 'staff_case']) {
    rejected(envelope({ payload: { title: 'x', section: { projection: marker, notes: 'hidden' } } }), /private_marker at \$\.section\.projection/);
    rejected(envelope({ payload: { title: 'x', items: [{ audience: marker }] } }), /private_marker at \$\.items\[0\]\.audience/);
  }
  rejected(envelope({ kind: 'person_profile', id: gid(NATIONAL, 'person_profile', 'p1'), dataClass: 'person_profiles', syndication: 'mesh_only_redisplay', subject: gid(NATIONAL, 'person', 'p1'), consent: { basis: 'profile_visibility_public', recordedAt: '2026-10-01T00:00:00.000Z' }, payload: { displayName: 'A', profileVisibility: 'private' } }), /private_marker/);
});

test('each kind carries exactly its declared projection; deal kinds never go public and public kinds never go shared', () => {
  for (const kind of FEDERATED_OBJECT_KINDS) {
    const rule = OBJECT_KIND_RULES[kind];
    assert.ok(rule.dataClasses.length > 0, kind);
    assert.equal(rule.stream === null, rule.projection === 'shared_party', `${kind}: only public kinds have a feed stream`);
  }
  rejected(dealEnvelope({ projection: 'public', audience: { kind: 'public' } }), /quote_version travels only in the shared_party projection/);
  rejected(envelope({ projection: 'shared_party', audience: { kind: 'parties', parties: [gid(NATIONAL, 'company', 'a'), gid(CITY, 'company', 'b')], nodes: [NATIONAL, CITY] } }), /publication travels only in the public projection/);
  rejected(envelope({ dataClass: 'deal_data', syndication: 'parties_only' }), /publication carries/);
});

test('syndication: items marked none never leave their node; terms must fit the data class; reviews do not federate', () => {
  rejected(envelope({ syndication: 'none' }), /syndication none never leaves its node/);
  rejected(envelope({ syndication: 'open_data_with_attribution' }), /term not allowed for editorial_publications/);
  assert.deepEqual(issues(envelope({ dataClass: 'member_publications', syndication: 'cc_by_4_0' })), [], 'an author who chose CC BY 4.0 may syndicate full text');
  assert.deepEqual(issues(envelope({ dataClass: 'member_publications', syndication: 'headline_and_link' })), []);
  rejected(envelope({ dataClass: 'imported_items', syndication: 'source_licence' }), /term not allowed/);
  assert.deepEqual(ITEM_SYNDICATION_TERMS.reviews, []);
  assert.ok(!(FEDERATED_OBJECT_KINDS as readonly string[]).includes('review'));
});

test('identity and audience: one writer per object, deal envelopes only to the parties\' home nodes', () => {
  rejected(envelope({ homeNode: CITY, id: gid(NATIONAL, 'publication', 'x') }), /home node is the host of the identifier/);
  rejected(envelope({ id: gid(NATIONAL, 'event', 'x') }), /identifier names the envelope kind/);
  rejected(envelope({ audience: { kind: 'parties', parties: [gid(NATIONAL, 'company', 'a'), gid(CITY, 'company', 'b')], nodes: [NATIONAL, CITY] } }), /public envelope has the public audience/);
  rejected(dealEnvelope({ audience: { kind: 'public' } }), /names its parties/);
  const buyer = gid(NATIONAL, 'company', 'co-national-builder');
  const seller = gid(CITY, 'company', 'co-austin-glazing');
  rejected(dealEnvelope({ audience: { kind: 'parties', parties: [buyer, seller], nodes: [NATIONAL, CITY, THIRD] } }), /nodes are exactly the home nodes/);
  rejected(dealEnvelope({ audience: { kind: 'parties', parties: [buyer, seller], nodes: [NATIONAL] } }), /nodes are exactly the home nodes/);
  rejected(dealEnvelope({ audience: { kind: 'parties', parties: [buyer, gid(THIRD, 'company', 'c')], nodes: [NATIONAL, THIRD] } }), /home node is one of the parties' nodes/);
  rejected(dealEnvelope({ audience: { kind: 'parties', parties: [buyer, buyer], nodes: [NATIONAL] } }), /parties are unique/);
  rejected(dealEnvelope({ audience: { kind: 'parties', parties: [buyer, gid(CITY, 'publication', 'p')], nodes: [NATIONAL, CITY] } }), /a party is a person or a company/);
  rejected(dealEnvelope({ subject: gid(THIRD, 'company', 'c') }), /subject of a deal object is one of its parties/);
});

test('consent: nothing about a person crosses without a consent basis allowed for the kind', () => {
  const person = gid(NATIONAL, 'person', 'p1');
  const profile = { kind: 'person_profile', id: gid(NATIONAL, 'person_profile', 'p1'), dataClass: 'person_profiles', syndication: 'mesh_only_redisplay', subject: person, payload: { displayName: 'Synthetic Person', headline: 'Facade engineer' } };
  rejected(envelope(profile), /an object about a person travels only with a consent basis/);
  rejected(envelope({ ...profile, consent: { basis: 'deal_participation', recordedAt: '2026-10-01T00:00:00.000Z' } }), /person_profile accepts profile_visibility_public/);
  assert.deepEqual(issues(envelope({ ...profile, consent: { basis: 'profile_visibility_public', recordedAt: '2026-10-01T00:00:00.000Z' } })), []);
  rejected(envelope({ ...profile, subject: gid(NATIONAL, 'company', 'c1') }), /person_profile is about a person/);
  rejected(envelope({ kind: 'magazine_issue', id: gid(NATIONAL, 'magazine_issue', 'i12'), dataClass: 'magazine_issues', syndication: 'contents_and_links', subject: person, consent: { basis: 'published_by_subject', recordedAt: '2026-10-01T00:00:00.000Z' } }), /magazine_issue accepts no person subject/);
  const credential = { kind: 'passport_credential', id: gid(NATIONAL, 'passport_credential', 'vc1'), dataClass: 'certificates', syndication: 'verification_record', subject: person, payload: { credentialType: 'license', status: 'active' } };
  rejected(envelope({ ...credential, consent: { basis: 'profile_visibility_public', recordedAt: '2026-10-01T00:00:00.000Z' } }), /passport_credential accepts credential_shared_by_subject/);
  assert.deepEqual(issues(envelope({ ...credential, consent: { basis: 'credential_shared_by_subject', recordedAt: '2026-10-01T00:00:00.000Z' } })), []);
  const personSeller = gid(CITY, 'person', 'p-glazier');
  rejected(dealEnvelope({ subject: personSeller, audience: { kind: 'parties', parties: [gid(NATIONAL, 'company', 'co-national-builder'), personSeller], nodes: [NATIONAL, CITY] } }), /consent basis/);
});

test('agent envelopes are labelled agent-generated', () => {
  const agent = { kind: 'agent_envelope', id: gid(CITY, 'agent_envelope', 'ae1') };
  rejected(dealEnvelope(agent), /labelled agent-generated/);
  assert.deepEqual(issues(dealEnvelope({ ...agent, agentGenerated: true })), []);
});

test('payload backstop: credentials, budgets, private contact data and network addresses never cross', () => {
  for (const key of ['ipAddress', 'passwordHash', 'budgetRange', 'privateConstraint', 'floorPrice', 'mandateIds', 'screeningResult', 'email', 'phone', 'connectionId']) {
    rejected(envelope({ payload: { title: 'x', nested: { [key]: 'value' } } }), new RegExp(`forbidden_key at \\$\\.nested\\.${key}`));
  }
  for (const address of TEST_ADDRESSES) rejected(envelope({ payload: { title: 'x', mirror: [address] } }), /network_address at \$\.mirror\[0\]/);
  assert.deepEqual(payloadProblems({ title: 'Version 1.2.3 of the code', count: 4 }), []);
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 40; i++) deep = { d: deep };
  assert.ok(payloadProblems(deep).some((p) => p.reason === 'too_deep'));
  assert.ok(payloadProblems({ text: 'x'.repeat(300 * 1024) }).some((p) => p.reason === 'too_large'));
});

test('envelopes are strict: unknown top-level fields (for example an address) are refused', () => {
  rejected({ ...envelope(), senderAddress: '192.0.2.44' }, /senderAddress|Unrecognized/i);
  rejected({ ...envelope(), revision: 0 }, /revision/);
});
