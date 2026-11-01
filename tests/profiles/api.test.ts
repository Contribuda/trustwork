import { installSyntheticServingHub } from '../agent-modules/serving-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import {
  CONSENT_NOTICE_VERSIONS, PROFILE_EVENT_PAYLOAD_KEYS, PROFILE_PUBLIC_FORBIDDEN_KEYS, PublicPersonProfileSchema, type ConsentRecord, type ExperienceEntry, type MyProfileView, type Portrait,
  type PublicPersonProfile,
} from '../../packages/contracts/src/profiles.js';
import { ProfilesService } from '../../apps/api/src/modules/profiles/profiles.service.js';
import { AllowListProfileMandates } from '../../apps/api/src/modules/profiles/mandates.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';

/**
 * PPL-001 through the HTTP API (real database, runtime role, CSRF, idempotency): a person builds a public profile
 * that exists only with their consent, shows a portrait only with consent and a licence, declares experience that
 * survives the end of their employment, appears on a company page only when they agreed, and keeps bookmarks, follows
 * and reading progress to themselves. Negative authorization for anonymous callers, other people, employers and
 * colleagues; concurrent editors; agents limited to profile edits under a mandate.
 */
const h = await startHarness('profiles_api');

function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
const PRIVATE_STRINGS = ['PRIVATE-reading', 'find_work', 'evidence', 'first_party_form', 'Fixture Licensor', '@example.invalid'];
function publicOnly(value: unknown): void {
  const json = JSON.stringify(value);
  for (const key of PROFILE_PUBLIC_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} reached a public projection: ${json.slice(0, 300)}`);
  for (const secret of PRIVATE_STRINGS) assert.ok(!json.includes(secret), `${secret} leaked: ${json.slice(0, 300)}`);
}
const profileBody = (over: Record<string, unknown> = {}) => ({
  expectedRevision: null, headline: 'Roofing estimator', expertise: ['roofing'], roleLine: 'Estimator, residential roofs', regionCode: 'US-CA', showEmployer: true,
  topics: ['materials', 'projects'], languages: ['en', 'es-US'], publicFields: ['roleLine', 'region', 'topics', 'experience', 'employer', 'portrait'], ...over,
});

test('profiles API: consent-driven public profiles, portraits, experience and private records', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  await installSyntheticServingHub(h);
  const seed = await seedPersonas(h);
  const reference = await kernelReference.fromRepository();
  await withMaintenance(h.db.admin, (trx) => kernelSync.apply(trx, reference));
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const petr = await as('petr');
  const anna = await as('anna');
  const xenia = await as('xenia');
  const carl = await as('carl');
  const boris = await as('boris');
  const anonymous = h.client();
  const { mixed } = seed.companies;

  await t.test('the owner view is private: anonymous callers are refused, nothing is public by default', async () => {
    expectError(await anonymous.get('/v1/me/profile'), 401, 'auth.session_invalid');
    expectError(await anonymous.post('/v1/me/profile', profileBody(), { idempotencyKey: null }), 401, 'auth.session_invalid');
    const view = ok<MyProfileView>(await petr.get('/v1/me/profile'));
    assert.equal(view.projection, 'owner_private');
    assert.equal(view.person.profileVisibility, 'private');
    assert.equal(view.profile, null);
    assert.equal(view.publicPreview, null);
    assert.equal(view.notices.profile_public, 'profile_public.v1');
    expectError(await anonymous.get(`/v1/people/${seed.people.petr}/profile`), 404, 'access.not_found');
  });

  let view: MyProfileView;
  await t.test('saving the profile: idempotent, one editor per revision, restricted places refused, still private', async () => {
    expectError(await petr.post('/v1/me/profile', profileBody({ regionCode: 'UA-43' })), 422, 'validation.schema');
    expectError(await petr.post('/v1/me/profile', profileBody({ publicFields: ['roleLine', 'roleLine'] })), 422, 'validation.schema');
    expectError(await petr.post('/v1/me/profile', profileBody({ email: 'x@example.invalid' })), 422, 'validation.unknown_field');
    view = ok<MyProfileView>(await petr.post('/v1/me/profile', profileBody(), { idempotencyKey: 'profile-save-1' }));
    assert.equal(view.profile?.revision, 1);
    assert.equal(view.person.headline, 'Roofing estimator');
    assert.deepEqual(ok(await petr.post('/v1/me/profile', profileBody(), { idempotencyKey: 'profile-save-1' })), view, 'a retry replays the result');
    expectError(await petr.post('/v1/me/profile', profileBody({ roleLine: 'other' }), { idempotencyKey: 'profile-save-1' }), 409, 'validation.idempotency_conflict');
    // Two editors with the same revision: one wins, the other is told to reload.
    const racers = await Promise.all([1, 2].map((n) => petr.post('/v1/me/profile', profileBody({ expectedRevision: 1, roleLine: `Editor ${n}` }))));
    assert.deepEqual(racers.map((r) => r.status).sort(), [200, 409]);
    view = ok<MyProfileView>(await petr.get('/v1/me/profile'));
    assert.equal(view.profile?.revision, 2);
    expectError(await anonymous.get(`/v1/people/${seed.people.petr}/profile`), 404, 'access.not_found');
  });

  let petrPublic: PublicPersonProfile;
  await t.test('going public is a consent to the current notice; the public projection is allowlisted and identical for everyone', async () => {
    const outdated = await petr.post('/v1/me/profile/visibility', { visibility: 'public', noticeVersion: 'profile_public.v0' });
    expectError(outdated, 422, 'validation.schema');
    expectError(await petr.post('/v1/me/profile/visibility', { visibility: 'public', noticeVersion: 'portrait_display.v1' }), 422, 'validation.schema');
    expectError(await petr.post('/v1/me/consents', { purpose: 'profile_public', target: null, noticeVersion: CONSENT_NOTICE_VERSIONS.profile_public }, {}), 422, 'validation.schema');
    view = ok<MyProfileView>(await petr.post('/v1/me/profile/visibility', { visibility: 'public', noticeVersion: CONSENT_NOTICE_VERSIONS.profile_public }));
    assert.equal(view.person.profileVisibility, 'public');
    const consent = view.consents.find((c) => c.purpose === 'profile_public');
    assert.equal(consent?.withdrawnAt, null);
    assert.deepEqual(consent?.evidence.method, 'first_party_form');
    assert.ok(view.publicPreview);
    ok(await petr.post('/v1/me/handle', { handle: 'petr-roofs' }));
    petrPublic = ok<PublicPersonProfile>(await anonymous.get(`/v1/people/${seed.people.petr}/profile`));
    assert.deepEqual(PublicPersonProfileSchema.parse(petrPublic), petrPublic);
    assert.equal(petrPublic.handle, 'petr-roofs');
    assert.match(petrPublic.roleLine ?? '', /^Editor [12]$/, 'the winning concurrent edit');
    assert.deepEqual(petrPublic.languages, [], 'languages were not chosen as public');
    assert.equal(petrPublic.employer, null, 'petr has no employer');
    publicOnly(petrPublic);
    assert.deepEqual(ok(await carl.get(`/v1/people/${seed.people.petr}/profile`)), petrPublic, 'identical for a signed-in stranger');
    assert.deepEqual(ok<{ item: PublicPersonProfile; redirect: boolean }>(await anonymous.get('/v1/people/by-handle/petr-roofs/profile')), { item: petrPublic, redirect: false });
    expectError(await anonymous.get('/v1/people/by-handle/not-a-person/profile'), 404, 'access.not_found');
    expectError(await anonymous.get('/v1/people/not-a-uuid/profile'), 404, 'access.not_found');
  });

  await t.test('a company lists only members who consented to that listing; withdrawal unpublishes at once with a tombstone', async () => {
    const people = async () => ok<{ items: { id: string }[] }>(await anonymous.get(`/v1/companies/${mixed}/people`)).items.map((p) => p.id);
    ok(await anna.post('/v1/me/profile/visibility', { visibility: 'public', noticeVersion: CONSENT_NOTICE_VERSIONS.profile_public }));
    assert.deepEqual(await people(), [], 'a public member is not listed without consent');
    // A former member's consent lists nobody.
    ok(await xenia.post('/v1/me/profile/visibility', { visibility: 'public', noticeVersion: CONSENT_NOTICE_VERSIONS.profile_public }));
    ok(await xenia.post('/v1/me/consents', { purpose: 'listed_by_company', target: { kind: 'company', id: mixed }, noticeVersion: CONSENT_NOTICE_VERSIONS.listed_by_company }), 201);
    assert.deepEqual(await people(), []);
    expectError(await anna.post('/v1/me/consents', { purpose: 'listed_by_company', target: null, noticeVersion: CONSENT_NOTICE_VERSIONS.listed_by_company }), 422, 'validation.schema');
    const consent = ok<ConsentRecord>(await anna.post('/v1/me/consents', { purpose: 'listed_by_company', target: { kind: 'company', id: mixed }, noticeVersion: CONSENT_NOTICE_VERSIONS.listed_by_company }), 201);
    expectError(await anna.post('/v1/me/consents', { purpose: 'listed_by_company', target: { kind: 'company', id: mixed }, noticeVersion: CONSENT_NOTICE_VERSIONS.listed_by_company }), 409, 'validation.revision_conflict');
    assert.deepEqual(await people(), [seed.people.anna]);
    const listing = ok<{ items: Record<string, unknown>[] }>(await anonymous.get(`/v1/companies/${mixed}/people`));
    publicOnly(listing);
    assert.deepEqual(Object.keys(listing.items[0] ?? {}).sort(), ['displayName', 'handle', 'headline', 'id']);
    // Nobody else withdraws or reads anna's consent.
    expectError(await petr.post(`/v1/me/consents/${consent.id}/withdraw`, { reason: 'not mine' }), 404, 'access.not_found');
    expectError(await boris.post(`/v1/me/consents/${consent.id}/withdraw`, { reason: 'not mine' }), 404, 'access.not_found');
    assert.equal(ok<{ items: ConsentRecord[] }>(await petr.get('/v1/me/consents')).items.some((c) => c.id === consent.id), false);
    const withdrawn = ok<ConsentRecord>(await anna.post(`/v1/me/consents/${consent.id}/withdraw`, { reason: 'Prefer not to be listed' }));
    assert.ok(withdrawn.withdrawnAt);
    assert.deepEqual(await people(), []);
    expectError(await anna.post(`/v1/me/consents/${consent.id}/withdraw`, { reason: 'again' }), 409, 'validation.revision_conflict');
    const stones = await h.db.admin.query("SELECT projection, target_id FROM trustwork.profile_tombstone WHERE subject_person_id = $1 AND consent_record_id = $2", [seed.people.anna, consent.id]);
    assert.deepEqual(stones.rows, [{ projection: 'company_listing', target_id: mixed }]);
    expectError(await anonymous.get(`/v1/companies/${seed.people.petr}/people`), 404, 'access.not_found');
  });

  let portrait: Portrait;
  await t.test('a portrait is shown only with consent and a licence; withdrawing either hides it', async () => {
    const upload = async (owner: string, key: string, classification = 'public') => (await withMaintenance(h.db.admin, (trx) => trx.insertInto('evidence_artifact').values({
      owner_person_id: owner, owner_company_id: null, parent_kind: 'person', parent_id: owner, classification: classification as 'public', storage_key: key, sha256: 'd'.repeat(64), bytes: 2048,
      media_type: 'image/webp', uploaded_by: owner, scan_state: 'clean',
    }).returning('id').executeTakeFirstOrThrow())).id;
    const asset = await upload(seed.people.petr, 'person/petr/portrait-api.webp');
    const annaAsset = await upload(seed.people.anna, 'person/anna/portrait-api.webp');
    expectError(await petr.post('/v1/me/media-licences', { assetId: annaAsset, licensor: 'Fixture Licensor', licenceKind: 'own_work', scope: 'profile portrait', validUntil: null }), 422, 'validation.schema');
    const licence = ok<{ id: string }>(await petr.post('/v1/me/media-licences', { assetId: asset, licensor: 'Fixture Licensor', licenceKind: 'own_work', scope: 'profile portrait', validUntil: null }), 201);
    const marketing = ok<ConsentRecord>(await petr.post('/v1/me/consents', { purpose: 'marketing', target: null, noticeVersion: CONSENT_NOTICE_VERSIONS.marketing }), 201);
    const noConsent = await petr.post('/v1/me/portrait', { assetId: asset, mediaLicenceId: licence.id, consentRecordId: marketing.id });
    expectError(noConsent, 422, 'validation.schema');
    assert.equal((noConsent.body as { details: { reason: string } }).details.reason, 'consent_required');
    const consent = ok<ConsentRecord>(await petr.post('/v1/me/consents', { purpose: 'portrait_display', target: null, noticeVersion: CONSENT_NOTICE_VERSIONS.portrait_display }), 201);
    // Someone else's consent or licence never works for petr.
    const annaConsent = ok<ConsentRecord>(await anna.post('/v1/me/consents', { purpose: 'portrait_display', target: null, noticeVersion: CONSENT_NOTICE_VERSIONS.portrait_display }), 201);
    expectError(await petr.post('/v1/me/portrait', { assetId: asset, mediaLicenceId: licence.id, consentRecordId: annaConsent.id }), 422, 'validation.schema');
    expectError(await anna.post('/v1/me/portrait', { assetId: asset, mediaLicenceId: licence.id, consentRecordId: annaConsent.id }), 422, 'validation.schema');
    // Two concurrent choices: one shown portrait at a time.
    const racers = await Promise.all([1, 2].map(() => petr.post('/v1/me/portrait', { assetId: asset, mediaLicenceId: licence.id, consentRecordId: consent.id })));
    assert.ok(racers.every((r) => r.status === 201 || r.status === 409), JSON.stringify(racers.map((r) => r.body)));
    assert.equal(Number((await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.portrait WHERE person_id = $1 AND status = 'shown'", [seed.people.petr])).rows[0].n), 1);
    const shown = ok<MyProfileView>(await petr.get('/v1/me/profile')).portraits.find((p) => p.status === 'shown');
    assert.ok(shown);
    portrait = shown;
    assert.deepEqual(ok<PublicPersonProfile>(await anonymous.get(`/v1/people/${seed.people.petr}/profile`)).portrait, { portraitId: portrait.id, assetId: asset });
    ok(await petr.post(`/v1/me/consents/${consent.id}/withdraw`, { reason: 'No portrait' }));
    assert.equal(ok<PublicPersonProfile>(await anonymous.get(`/v1/people/${seed.people.petr}/profile`)).portrait, null, 'hidden in the same transaction');
    const again = ok<ConsentRecord>(await petr.post('/v1/me/consents', { purpose: 'portrait_display', target: null, noticeVersion: CONSENT_NOTICE_VERSIONS.portrait_display }), 201);
    portrait = ok<Portrait>(await petr.post('/v1/me/portrait', { assetId: asset, mediaLicenceId: licence.id, consentRecordId: again.id }), 201);
    ok(await petr.post(`/v1/me/media-licences/${licence.id}/revoke`, { reason: 'Licence ended' }));
    assert.equal(ok<PublicPersonProfile>(await anonymous.get(`/v1/people/${seed.people.petr}/profile`)).portrait, null);
    expectError(await petr.post(`/v1/me/media-licences/${licence.id}/revoke`, { reason: 'again' }), 409, 'validation.revision_conflict');
    expectError(await anna.post(`/v1/me/media-licences/${licence.id}/revoke`, { reason: 'not mine' }), 404, 'access.not_found');
  });

  await t.test('experience is the person\'s own, labelled self-declared, and survives the end of employment', async () => {
    expectError(await xenia.post('/v1/me/experience', { organisation: { companyId: mixed, name: 'Fixture Mixed' }, role: 'Site engineer', summary: null, from: '2026-01-01', to: '2025-01-01', visibility: 'public' }), 422, 'validation.schema');
    const entry = ok<ExperienceEntry>(await anna.post('/v1/me/experience', { organisation: { companyId: mixed, name: 'Fixture Mixed Company' }, role: 'Procurement lead', summary: 'Facades and roofing', from: '2024-03-01', to: null, visibility: 'public' }), 201);
    assert.equal(entry.confirmation, 'self_declared');
    ok(await anna.post('/v1/me/profile', profileBody({ headline: 'Procurement lead', roleLine: 'Procurement', publicFields: ['experience', 'employer'] })));
    let pub = ok<PublicPersonProfile>(await anonymous.get(`/v1/people/${seed.people.anna}/profile`));
    assert.deepEqual(pub.experience.map((e) => [e.role, e.confirmation]), [['Procurement lead', 'self_declared']]);
    assert.equal(pub.employer?.companyId, mixed);
    // Nobody else edits or archives it, not the employer's colleagues and not strangers.
    for (const other of [petr, carl, boris]) {
      expectError(await other.post(`/v1/me/experience/${entry.id}`, { organisation: { companyId: null, name: 'Rewritten' }, role: 'Intern', summary: null, from: '2024-03-01', to: null, visibility: 'public', expectedRevision: entry.revision }), 404, 'access.not_found');
      expectError(await other.post(`/v1/me/experience/${entry.id}/archive`, { expectedRevision: entry.revision }), 404, 'access.not_found');
    }
    expectError(await anna.post(`/v1/me/experience/${entry.id}`, { organisation: { companyId: mixed, name: 'Fixture Mixed Company' }, role: 'Lead', summary: null, from: '2024-03-01', to: null, visibility: 'public', expectedRevision: entry.revision, confirmation: 'company_confirmed' }), 422, 'validation.unknown_field');
    // Anna's employment ends: her experience and her public profile stay; the employer line goes.
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: seed.people.anna, ended_reason: 'fixture: moved on' }).where('person_id', '=', seed.people.anna).where('status', '=', 'active').execute());
    const annaAfter = await as('anna');
    pub = ok<PublicPersonProfile>(await anonymous.get(`/v1/people/${seed.people.anna}/profile`));
    assert.deepEqual(pub.experience.map((e) => e.id), [entry.id]);
    assert.equal(pub.employer, null);
    const listed = ok<{ items: ExperienceEntry[] }>(await annaAfter.get('/v1/me/experience')).items;
    assert.deepEqual(listed.map((e) => [e.id, e.organisation.name]), [[entry.id, 'Fixture Mixed Company']]);
    const updated = ok<ExperienceEntry>(await annaAfter.post(`/v1/me/experience/${entry.id}`, { organisation: { companyId: mixed, name: 'Fixture Mixed Company' }, role: 'Procurement lead', summary: 'Facades and roofing', from: '2024-03-01', to: '2026-10-31', visibility: 'public', expectedRevision: entry.revision }));
    expectError(await annaAfter.post(`/v1/me/experience/${entry.id}`, { organisation: { companyId: mixed, name: 'x' }, role: 'y', summary: null, from: '2024-03-01', to: null, visibility: 'public', expectedRevision: entry.revision }), 409, 'validation.revision_conflict');
    ok(await annaAfter.post(`/v1/me/experience/${entry.id}/archive`, { expectedRevision: updated.revision }));
    assert.deepEqual(ok<PublicPersonProfile>(await anonymous.get(`/v1/people/${seed.people.anna}/profile`)).experience, []);
  });

  await t.test('bookmarks, follows, reading progress and preferences are never visible to employers or colleagues', async () => {
    const publication = '0198b1d0-0000-7000-8000-0000000000bb';
    // boris works for the supplier; carl administers another company; xenia is a former colleague of anna.
    ok(await boris.post('/v1/me/bookmarks', { target: { kind: 'publication', id: publication } }), 201);
    ok(await boris.post('/v1/me/reading-progress', { publicationVersionId: publication, progress: '0.35' }));
    ok(await boris.post('/v1/me/follows', { target: { kind: 'company', id: mixed } }), 201);
    ok(await boris.post('/v1/me/follows', { target: { kind: 'topic', code: 'materials' } }), 201);
    expectError(await boris.post('/v1/me/follows', { target: { kind: 'person', id: seed.people.carl } }), 404, 'access.not_found');
    expectError(await boris.post('/v1/me/follows', { target: { kind: 'region', code: 'RU' } }), 422, 'validation.schema');
    ok(await boris.post('/v1/me/follows', { target: { kind: 'person', id: seed.people.petr } }), 201);
    ok(await boris.post('/v1/me/preferences', { intents: ['find_work'], topics: ['materials'], regions: ['US-CA'], onboardingCompleted: true, expectedRevision: null }));
    // Every other person, including an administrator of a company and a colleague, sees only their own (empty) lists.
    for (const other of [carl, petr, xenia]) {
      assert.deepEqual(ok<{ items: unknown[] }>(await other.get('/v1/me/bookmarks')).items, []);
      assert.deepEqual(ok<{ items: unknown[] }>(await other.get('/v1/me/reading-progress')).items, []);
      assert.deepEqual(ok<{ preferences: unknown }>(await other.get('/v1/me/preferences')).preferences, null);
    }
    const borisBookmark = ok<{ items: { id: string }[] }>(await boris.get('/v1/me/bookmarks')).items[0];
    assert.ok(borisBookmark);
    expectError(await carl.post(`/v1/me/bookmarks/${borisBookmark.id}/remove`, {}), 404, 'access.not_found');
    // A company member with every company permission still reads nothing of a colleague's learning.
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.members.manage', 'company.deals.manage', 'company.page.edit', 'company.publish'] }).where('person_id', '=', seed.people.boris).execute());
    const colleague = await withMaintenance(h.db.admin, async (trx) => {
      const person = await trx.insertInto('person').values({ display_name: 'Fixture Colleague', profile_visibility: 'private' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('membership').values({ person_id: person.id, company_id: seed.companies.supplier, role: 'member', permissions: [], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
      await trx.insertInto('reading_progress').values({ person_id: person.id, publication_version_id: publication, progress: '0.9' }).execute();
      await trx.insertInto('bookmark').values({ person_id: person.id, target_kind: 'publication', target_id: publication }).execute();
      return person.id;
    });
    const borisAdmin = await as('boris');
    assert.deepEqual(ok<{ items: { progress: string }[] }>(await borisAdmin.get('/v1/me/reading-progress')).items.map((i) => i.progress), ['0.35'], 'only his own');
    assert.equal(ok<{ items: unknown[] }>(await borisAdmin.get('/v1/me/bookmarks')).items.length, 1);
    const count = Number((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.reading_progress WHERE person_id = $1', [colleague])).rows[0].n);
    assert.equal(count, 1, 'the colleague\'s record exists but no API path shows it to the employer');
    // Nothing about attention reaches the audit trail or the outbox.
    const leaks = await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action LIKE 'bookmark%' OR action LIKE 'follow%' OR action LIKE 'reading%' OR action LIKE 'preferences%'");
    assert.equal(leaks.rows[0].n, 0);
    const events = await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.outbox_event WHERE type LIKE 'bookmark%' OR type LIKE 'follow%' OR type LIKE 'reading%'");
    assert.equal(events.rows[0].n, 0);
    expectError(await boris.post('/v1/me/reading-progress', { publicationVersionId: publication, progress: '1.2' }), 422, 'validation.schema');
  });

  await t.test('hiding the profile withdraws the consent and unpublishes everywhere in the same request', async () => {
    ok(await petr.post('/v1/me/consents', { purpose: 'mentioned_in_publication', target: { kind: 'publication', id: '0198b1d0-0000-7000-8000-0000000000cc' }, noticeVersion: CONSENT_NOTICE_VERSIONS.mentioned_in_publication }), 201);
    const hidden = ok<MyProfileView>(await petr.post('/v1/me/profile/visibility', { visibility: 'private', reason: 'Taking a break' }));
    assert.equal(hidden.person.profileVisibility, 'private');
    assert.equal(hidden.publicPreview, null);
    expectError(await anonymous.get(`/v1/people/${seed.people.petr}/profile`), 404, 'access.not_found');
    expectError(await anonymous.get('/v1/people/by-handle/petr-roofs/profile'), 404, 'access.not_found');
    expectError(await anonymous.get('/v1/people/by-handle/petr-roofs'), 404, 'access.not_found');
    const directory = ok<{ items: { id: string }[] }>(await anonymous.get('/v1/people'));
    assert.equal(directory.items.some((p) => p.id === seed.people.petr), false, 'gone from the directory');
    const stones = await h.db.admin.query("SELECT projection FROM trustwork.profile_tombstone WHERE subject_person_id = $1 ORDER BY created_at", [seed.people.petr]);
    assert.ok(stones.rows.some((r) => r.projection === 'profile'));
    // Going public again needs a new consent: the old record stays withdrawn as proof.
    const back = ok<MyProfileView>(await petr.post('/v1/me/profile/visibility', { visibility: 'public', noticeVersion: CONSENT_NOTICE_VERSIONS.profile_public }));
    assert.equal(back.consents.filter((c) => c.purpose === 'profile_public').length, 2);
    assert.equal(back.consents.filter((c) => c.purpose === 'profile_public' && c.withdrawnAt === null).length, 1);
  });

  await t.test('agents edit a profile only under a maintain_profile mandate and never give consent', async () => {
    const token = petr.sessionCookie as string;
    const resolved = await h.services().principals.resolve(token);
    assert.ok(resolved);
    const delegated = (mandateId: string): RequestState => ({
      requestId: `profiles-agent-${mandateId}`, principal: { ...resolved.principal, delegation: { mandateId, mandateRevision: 1, principalPersonId: seed.people.petr } }, session: resolved.session,
      sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' },
    });
    const mandates = new AllowListProfileMandates([{ personId: seed.people.petr, mandateId: 'mandate-demo-profile' }]);
    const agent = new ProfilesService(h.created.ctx!, h.services().principals, mandates);
    const current = ok<MyProfileView>(await petr.get('/v1/me/profile'));
    await assert.rejects(agent.saveProfile({ ...profileBody({ expectedRevision: current.profile?.revision ?? null }) } as never, delegated('mandate-other')), (e: { code?: string }) => e.code === 'access.mandate_scope');
    const saved = await agent.saveProfile(profileBody({ expectedRevision: current.profile?.revision ?? null, roleLine: 'Updated by the agent' }) as never, delegated('mandate-demo-profile'));
    assert.equal(saved.profile?.roleLine, 'Updated by the agent');
    await assert.rejects(agent.setVisibility({ visibility: 'private' }, delegated('mandate-demo-profile')), (e: { code?: string }) => e.code === 'access.mandate_scope');
    await assert.rejects(agent.grantConsent({ purpose: 'marketing', target: null, noticeVersion: CONSENT_NOTICE_VERSIONS.marketing }, delegated('mandate-demo-profile')), (e: { code?: string }) => e.code === 'access.mandate_scope');
    assert.deepEqual(mandates.checks.map((c) => [c.mandateId, c.action]), [['mandate-other', 'maintain_profile'], ['mandate-demo-profile', 'maintain_profile']]);
  });

  await t.test('profile events carry identifiers only', async () => {
    const events = await h.db.admin.query<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM trustwork.outbox_event WHERE aggregate_kind = 'person' AND (type LIKE 'profile.%' OR type LIKE 'consent.%' OR type LIKE 'portrait.%' OR type LIKE 'experience.%') ORDER BY id");
    assert.ok(events.rows.length >= 10, `profile events recorded (${events.rows.length})`);
    for (const event of events.rows) {
      for (const key of Object.keys(event.payload)) assert.ok((PROFILE_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `${event.type}: ${key} is not an identifier`);
      for (const secret of ['Roofing estimator', 'Procurement lead', 'Fixture Licensor', 'Facades']) assert.ok(!JSON.stringify(event.payload).includes(secret), `${event.type}: ${secret} in an event`);
    }
  });
});
