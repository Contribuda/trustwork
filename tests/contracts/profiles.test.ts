import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/contracts/src/index.js';
import * as p from '../../packages/contracts/src/profiles.js';

/* Synthetic US demo data; no real people, companies or images. */
const ID = '0198b1d0-0000-7000-8000-000000000001';
const COMPANY = '0198b1d0-0000-7000-8000-0000000000c1';
const at = '2026-10-31T12:00:00.000Z';
const consent = (over: Partial<p.ConsentRecord> = {}): p.ConsentRecord => ({
  id: 'consent-1', subjectPersonId: ID, purpose: 'portrait_display', target: null, noticeVersion: 'portrait_display.v1', grantedAt: at,
  evidence: { method: 'first_party_form', requestId: 'req-1' }, withdrawnAt: null, withdrawnReason: null, ...over,
});
const licence = (over: Partial<p.MediaLicence> = {}): p.MediaLicence => ({
  id: 'licence-1', assetId: 'asset-1', licensor: 'Fixture Person', licenceKind: 'own_work', scope: 'profile portrait', validUntil: null, recordedByPersonId: ID, revokedAt: null, createdAt: at, ...over,
});
const portrait = (over: Partial<p.Portrait> = {}): p.Portrait => ({
  id: 'portrait-1', personId: ID, assetId: 'asset-1', mediaLicenceId: 'licence-1', consentRecordId: 'consent-1', status: 'shown', withdrawnAt: null, withdrawnReason: null, revision: 1, createdAt: at, ...over,
});
const source = (over: Partial<p.PublicProfileSource> = {}): p.PublicProfileSource => ({
  id: ID, handle: 'demo-roofer', displayName: 'Demo Roofer', headline: 'Roofing estimator', expertise: ['roofing'], roleLine: 'Estimator', regionCode: 'US-CA', topics: ['materials'],
  languages: ['en', 'es-US'], publicFields: ['roleLine', 'region', 'topics', 'experience'], employer: { companyId: COMPANY, name: 'Demo Roofing LLC' }, portrait: { portraitId: 'portrait-1', assetId: 'asset-1' },
  experience: [
    { id: 'e-1', organisation: { companyId: COMPANY, name: 'Demo Roofing LLC' }, role: 'Estimator', summary: null, from: '2024-01-01', to: null, confirmation: 'self_declared', visibility: 'public', archivedAt: null },
    { id: 'e-2', organisation: { companyId: null, name: 'Private gig' }, role: 'Helper', summary: null, from: '2020-01-01', to: '2020-06-30', confirmation: 'self_declared', visibility: 'private', archivedAt: null },
    { id: 'e-3', organisation: { companyId: null, name: 'Old job' }, role: 'Laborer', summary: null, from: '2018-01-01', to: '2019-01-01', confirmation: 'self_declared', visibility: 'public', archivedAt: at },
  ],
  profileVisibility: 'public', profileConsentLive: true, ...over,
});

test('consent records are explicit, versioned and name the target their purpose requires', () => {
  assert.ok(p.ConsentRecordSchema.safeParse(consent()).success);
  for (const purpose of p.CONSENT_PURPOSES) {
    assert.equal(p.CONSENT_NOTICE_VERSIONS[purpose], `${purpose}.v1`);
    assert.equal(p.noticePurpose(p.CONSENT_NOTICE_VERSIONS[purpose]), purpose);
    const kind = p.CONSENT_TARGET_BY_PURPOSE[purpose];
    const target = kind ? { kind, id: COMPANY } : null;
    assert.ok(p.ConsentRecordSchema.safeParse(consent({ purpose, target, noticeVersion: `${purpose}.v1` })).success, purpose);
    assert.equal(p.ConsentRecordSchema.safeParse(consent({ purpose, target: kind ? null : { kind: 'company', id: COMPANY }, noticeVersion: `${purpose}.v1` })).success, false, `${purpose}: wrong target`);
  }
  assert.equal(p.ConsentRecordSchema.safeParse(consent({ noticeVersion: 'profile_public.v1' })).success, false, 'the notice belongs to the purpose');
  assert.equal(p.ConsentRecordSchema.safeParse(consent({ evidence: { method: 'chat', requestId: 'x' } as never })).success, false, 'chat text never consents');
  assert.equal(p.ConsentRecordSchema.safeParse(consent({ withdrawnAt: at })).success, false, 'a withdrawal has a reason');
  assert.equal(p.GrantConsentCommandSchema.safeParse({ purpose: 'listed_by_company', target: null, noticeVersion: 'listed_by_company.v1' }).success, false);
  assert.ok(p.GrantConsentCommandSchema.safeParse({ purpose: 'listed_by_company', target: { kind: 'company', id: COMPANY }, noticeVersion: 'listed_by_company.v1' }).success);
  assert.equal(p.GrantConsentCommandSchema.safeParse({ purpose: 'marketing', target: null, noticeVersion: 'marketing.v1', agentId: 'x' }).success, false, 'strict: no agent field');
  assert.equal(p.SetProfileVisibilityCommandSchema.safeParse({ visibility: 'public' }).success, false, 'going public needs a notice version');
  const records = [consent({ id: 'a', withdrawnAt: at, withdrawnReason: 'no' }), consent({ id: 'b' })];
  assert.equal(p.liveConsentFor(records, ID, 'portrait_display', null)?.id, 'b');
  assert.equal(p.liveConsentFor(records, 'someone-else', 'portrait_display', null), null);
});

test('a portrait is displayable only with its own live consent and a live licence on the same file', () => {
  const now = new Date(at);
  assert.equal(p.portraitDisplayable(portrait(), consent(), licence(), now), true);
  assert.equal(p.portraitDisplayable(portrait(), null, licence(), now), false, 'no consent');
  assert.equal(p.portraitDisplayable(portrait(), consent(), null, now), false, 'no licence');
  assert.equal(p.portraitDisplayable(portrait(), consent({ withdrawnAt: at, withdrawnReason: 'no' }), licence(), now), false, 'withdrawn consent');
  assert.equal(p.portraitDisplayable(portrait(), consent({ purpose: 'marketing', noticeVersion: 'marketing.v1' }), licence(), now), false, 'another purpose');
  assert.equal(p.portraitDisplayable(portrait(), consent({ subjectPersonId: 'other' }), licence(), now), false, 'someone else\'s consent');
  assert.equal(p.portraitDisplayable(portrait(), consent(), licence({ assetId: 'asset-2' }), now), false, 'a licence on another file');
  assert.equal(p.portraitDisplayable(portrait(), consent(), licence({ revokedAt: at }), now), false, 'revoked licence');
  assert.equal(p.portraitDisplayable(portrait(), consent(), licence({ validUntil: '2026-10-01T00:00:00.000Z' }), now), false, 'expired licence');
  assert.equal(p.portraitDisplayable(portrait({ status: 'pending', consentRecordId: null }), consent(), licence(), now), false, 'pending');
  assert.equal(p.PortraitSchema.safeParse(portrait({ consentRecordId: null })).success, false, 'a shown portrait has a consent record');
});

test('the public serializer: not found without consent or when private; optional parts only when chosen', () => {
  assert.equal(p.toPublicPersonProfile(source({ profileConsentLive: false })), null, 'no consent, no public profile');
  assert.equal(p.toPublicPersonProfile(source({ profileVisibility: 'private' })), null);
  const pub = p.toPublicPersonProfile(source());
  assert.ok(pub);
  assert.equal(pub.roleLine, 'Estimator');
  assert.deepEqual(pub.languages, [], 'languages not chosen');
  assert.equal(pub.employer, null, 'employer not chosen');
  assert.equal(pub.portrait, null, 'portrait not chosen');
  assert.deepEqual(pub.experience.map((e) => [e.id, e.confirmation]), [['e-1', 'self_declared']], 'private and archived entries never appear; self-declared is labelled');
  const all = p.toPublicPersonProfile(source({ publicFields: [...p.PROFILE_PUBLIC_FIELDS] }));
  assert.equal(all?.employer?.name, 'Demo Roofing LLC');
  assert.deepEqual(all?.portrait, { portraitId: 'portrait-1', assetId: 'asset-1' });
  const none = p.toPublicPersonProfile(source({ publicFields: [] }));
  assert.deepEqual([none?.roleLine, none?.regionCode, none?.topics, none?.experience], [null, null, [], []]);
  // Whatever extra fields a source carries, nothing outside the allowlist reaches the output.
  const leaky = { ...source({ publicFields: [...p.PROFILE_PUBLIC_FIELDS] }), emailBindings: ['x@example.invalid'], preferences: { intents: ['find_work'] }, bookmarks: ['b'], readingProgress: [{ progress: '0.4' }] } as p.PublicProfileSource;
  const json = JSON.stringify(p.toPublicPersonProfile(leaky));
  for (const key of p.PROFILE_PUBLIC_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} in the public projection`);
  assert.equal(p.PublicPersonProfileSchema.safeParse({ ...all, preferences: {} }).success, false, 'strict schema');
  for (const key of p.PROFILE_PUBLIC_FORBIDDEN_KEYS) {
    assert.equal(key in p.PublicPersonProfileSchema.shape, false, `${key} is not a public field`);
    assert.equal(key in p.CompanyListedPersonSchema.shape, false, `${key} is not in a company listing`);
  }
  assert.deepEqual(p.consentedMentions(['a', 'b', 'c'], new Set(['c', 'a'])), ['a', 'c']);
});

test('experience, profile and private-record shapes', () => {
  const entry = { organisation: { companyId: COMPANY, name: 'Demo Roofing LLC' }, role: 'Estimator', summary: null, from: '2024-01-01', to: null, visibility: 'public' };
  assert.ok(p.AddExperienceCommandSchema.safeParse(entry).success);
  assert.equal(p.AddExperienceCommandSchema.safeParse({ ...entry, to: '2023-01-01' }).success, false, 'from is not after to');
  assert.equal(p.AddExperienceCommandSchema.safeParse({ ...entry, confirmation: 'company_confirmed' }).success, false, 'a person cannot declare a confirmation');
  assert.equal(p.ExperienceEntrySchema.safeParse({ ...entry, id: 'e', personId: ID, confirmation: 'company_confirmed', confirmedAt: null, archivedAt: null, revision: 1, createdAt: at }).success, false);
  const save = { expectedRevision: null, headline: null, expertise: [], roleLine: null, regionCode: 'US-CA', showEmployer: false, topics: ['materials'], languages: ['en', 'uz-Latn', 'es-419'], publicFields: ['region'] };
  assert.ok(p.SaveProfileCommandSchema.safeParse(save).success);
  assert.equal(p.SaveProfileCommandSchema.safeParse({ ...save, publicFields: ['email'] }).success, false);
  assert.equal(p.SaveProfileCommandSchema.safeParse({ ...save, topics: ['materials', 'materials'] }).success, false);
  assert.equal(p.SaveProfileCommandSchema.safeParse({ ...save, regionCode: 'California' }).success, false);
  for (const v of ['0', '0.5', '0.125', '1', '1.000']) assert.ok(p.ReadingProgressValueSchema.safeParse(v).success, v);
  for (const v of ['-0.1', '1.01', '2', '0.1234', 'half']) assert.equal(p.ReadingProgressValueSchema.safeParse(v).success, false, v);
  assert.equal(p.FollowTargetSchema.safeParse({ kind: 'topic', id: COMPANY }).success, false);
  assert.ok(p.FollowTargetSchema.safeParse({ kind: 'region', code: 'US-TX' }).success);
});

test('the profile keeper registers every operation once: parity, maintain_profile commits, consent on the first-party form only', async () => {
  const manifest = p.PROFILE_KEEPER_MANIFEST;
  assert.ok(c.AgentModuleManifestSchema.safeParse(manifest).success);
  const registry = c.buildCapabilityRegistry({ registryVersion: 1, hubId: null, manifests: [manifest], extensionCapabilities: [] });
  assert.deepEqual(c.parityGaps(registry.capabilities), []);
  const byId = new Map(registry.capabilities.map((x) => [x.id, x]));
  for (const id of ['profile_keeper.set_visibility', 'profile_keeper.grant_consent', 'profile_keeper.withdraw_consent', 'profile_keeper.set_portrait']) {
    assert.equal(byId.get(id)?.kind, 'govern', id);
    assert.equal(byId.get(id)?.mandateAction, null, `${id}: never delegated`);
  }
  for (const id of ['profile_keeper.apply_profile_edit', 'profile_keeper.add_experience', 'profile_keeper.update_experience']) assert.equal(byId.get(id)?.mandateAction, 'maintain_profile', id);
  for (const id of ['profile_keeper.list_bookmarks', 'profile_keeper.list_reading_progress']) assert.equal(byId.get(id)?.surfaces.includes('mcp'), false, `${id}: attention records do not leave through connections`);
  for (const cap of registry.capabilities) {
    for (const ref of [cap.input, cap.output]) {
      const mod = (await import(`../../packages/contracts/src/${ref.contract}.js`)) as Record<string, unknown>;
      assert.ok(mod[ref.schema] && typeof (mod[ref.schema] as { safeParse?: unknown }).safeParse === 'function', `${cap.id}: ${ref.contract}.${ref.schema}`);
    }
  }
});

test('owner-private records never leave the owner; events carry identifiers only', () => {
  assert.deepEqual(p.PROFILE_EGRESS.ownerPrivate.records, ['person_preference', 'follow', 'bookmark', 'reading_progress', 'consent_record', 'media_licence']);
  assert.equal(p.PROFILE_EGRESS.ownerPrivate.employerVisible, false);
  for (const key of p.PROFILE_EVENT_PAYLOAD_KEYS) assert.ok(!/name|headline|role|summary|progress|bookmark|licensor|evidence|notice/i.test(key), key);
  for (const kind of ['bookmark', 'reading_progress', 'follow', 'person_preference']) assert.equal((c.SourceKindSchema.options as readonly string[]).includes(kind), false, `${kind} is not a retrieval source`);
  for (const purpose of p.CONSENT_PURPOSES) assert.ok(p.PROFILE_PROJECTIONS.includes(p.PROJECTION_BY_PURPOSE[purpose]), purpose);
});
