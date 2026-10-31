import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import {
  bookmarks, consentRecords, experienceEntries, follows, mediaLicences, personPreferences, personProfiles, portraits, profileIdentity, profileTombstones, publicProfiles, readingProgress,
} from '../../packages/data/src/repositories/profiles.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { principalFor, seedFixtures } from '../data/helpers/seed.js';

/**
 * PPL-001 database layer under the real runtime role (FORCE RLS, no mocks): every profile table is the person's own,
 * no consent means no public link, consent records change only by their one withdrawal, withdrawal unpublishes and
 * leaves a tombstone in the same transaction, portraits need consent and licence, experience survives employment and
 * cannot be confirmed by its author, learning and attention records are invisible to employers and colleagues, and
 * concurrent writers serialize.
 */
const db = await provisionTestDatabase('profiles_db');

interface PgError { code?: string; hint?: string; message?: string }
async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}
const evidence = (requestId: string) => ({ method: 'first_party_form', requestId });

test('profiles database: own rows only, consent-gated public reads, withdrawal with tombstones, portraits and experience', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  const reference = await kernelReference.fromRepository();
  await withMaintenance(db.admin, (trx) => kernelSync.apply(trx, reference));
  const { petr, anna, carl, xenia } = seed.people;
  const mixed = seed.companies.mixed;
  // dana: an active ordinary member of anna's company (anna is its administrator): a colleague and an employer side.
  const dana = await withMaintenance(db.admin, async (trx) => {
    const row = await trx.insertInto('person').values({ display_name: 'Fixture Dana', profile_visibility: 'private' }).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto('membership').values({ person_id: row.id, company_id: mixed, role: 'member', permissions: [], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
    return row.id;
  });
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(db.app, await principalFor(db.admin, personId), fn);
  const count = async (sqlText: string, params: unknown[]) => Number((await db.admin.query(sqlText, params)).rows[0].n);

  await t.test('a profile is public only with a live profile_public consent; the switch without it is refused', async () => {
    await fails(as(dana, (trx) => profileIdentity.setVisibility(trx, dana, 'public')), 'profiles.consent_required');
    await fails(as(anna, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: 'profile_public.v1', evidence: evidence('r-1') })), '42501');
    await fails(as(dana, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'profile_public', target_kind: 'company', target_id: mixed, notice_version: 'profile_public.v1', evidence: evidence('r-1') })), '23514');
    await fails(as(dana, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: 'portrait_display.v1', evidence: evidence('r-1') })), '23514');
    await fails(as(dana, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: 'profile_public.v1', evidence: { method: 'chat', requestId: 'r-1' } })), '23514');
    await as(dana, async (trx) => {
      await consentRecords.insert(trx, { subject_person_id: dana, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: 'profile_public.v1', evidence: evidence('r-2') });
      await profileIdentity.setVisibility(trx, dana, 'public');
      await profileIdentity.setPublicText(trx, dana, { headline: 'Site engineer', expertise: ['facades'] });
      await personProfiles.insert(trx, { person_id: dana, role_line: 'Facade engineer', region_code: 'US-CA', show_employer: true, topics: ['materials'], languages: ['en', 'es-US'], public_fields: ['roleLine', 'region', 'topics', 'employer', 'experience'] });
    });
    const pub = await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana));
    assert.equal(pub?.displayName, 'Fixture Dana');
    assert.equal(pub?.roleLine, 'Facade engineer');
    assert.deepEqual(pub?.languages, [], 'languages are not in the public fields');
    assert.equal(pub?.employer?.companyId, mixed, 'shown employer with an active membership');
    assert.equal(pub?.portrait, null);
    const json = JSON.stringify(pub);
    for (const secret of ['email', 'authz', 'preferences', 'bookmark', 'evidence', 'noticeVersion']) assert.ok(!json.includes(secret), `${secret} reached the public profile`);
  });

  await t.test('a maintenance-seeded public person without consent is not found through the profile read', async () => {
    await withMaintenance(db.admin, (trx) => trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', '=', carl).execute());
    assert.equal(await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, carl)), undefined);
    assert.equal(await as(petr, (trx) => publicProfiles.profile(trx, carl)), undefined);
  });

  await t.test('every profile table is the person\'s own: employers, colleagues and strangers read nothing and write nothing', async () => {
    const pubVersion = '0198b1d0-0000-7000-8000-000000000001';
    await as(dana, async (trx) => {
      await personPreferences.insert(trx, { person_id: dana, intents: ['find_work'], topics: ['materials'], regions: ['US-CA'], onboarding_completed_at: null });
      await bookmarks.insert(trx, { person_id: dana, target_kind: 'publication', target_id: pubVersion });
      await readingProgress.upsert(trx, { person_id: dana, publication_version_id: pubVersion, progress: '0.4' });
      await follows.insert(trx, { follower_person_id: dana, target_kind: 'company', target_id: mixed, target_code: null });
      await experienceEntries.insert(trx, { person_id: dana, organisation_company_id: mixed, organisation_name: 'Fixture Mixed Company', role: 'Facade engineer', summary: null, from_date: '2025-01-01', to_date: null, visibility: 'public' });
    });
    for (const viewer of [anna, xenia, carl, petr]) {
      const seen = await as(viewer, async (trx) => ({
        profile: await personProfiles.get(trx, dana),
        preferences: await personPreferences.get(trx, dana),
        bookmarks: await bookmarks.listForPerson(trx, dana),
        progress: await readingProgress.listForPerson(trx, dana),
        follows: await follows.listForPerson(trx, dana),
        consents: await consentRecords.listForSubject(trx, dana),
        experience: await experienceEntries.listForPerson(trx, dana, true),
        tombstones: await profileTombstones.listForSubject(trx, dana),
      }));
      assert.deepEqual(seen, { profile: undefined, preferences: undefined, bookmarks: [], progress: [], follows: [], consents: [], experience: [], tombstones: [] }, `viewer ${viewer} saw dana's private rows`);
    }
    // The employer's administrator cannot write anything on dana's behalf.
    await fails(as(anna, (trx) => bookmarks.insert(trx, { person_id: dana, target_kind: 'publication', target_id: pubVersion })), '42501');
    await fails(as(anna, (trx) => readingProgress.upsert(trx, { person_id: dana, publication_version_id: pubVersion, progress: '1' })), '42501');
    const blind = await as(anna, (trx) => trx.updateTable('reading_progress').set({ progress: '1' }).where('person_id', '=', dana).executeTakeFirst());
    assert.equal(Number(blind.numUpdatedRows), 0);
    // Without any identity the runtime role sees none of these tables.
    for (const table of ['person_profile', 'person_preference', 'consent_record', 'media_licence', 'portrait', 'experience_entry', 'follow', 'bookmark', 'reading_progress', 'profile_tombstone']) {
      assert.equal(Number((await db.app.query(`SELECT count(*)::int AS n FROM trustwork.${table}`)).rows[0].n), 0, table);
    }
    assert.equal((await as(dana, (trx) => readingProgress.upsert(trx, { person_id: dana, publication_version_id: pubVersion, progress: '0.75' }))).progress, '0.75', 'last write wins for the owner');
    await fails(as(dana, (trx) => readingProgress.upsert(trx, { person_id: dana, publication_version_id: pubVersion, progress: '1.5' })), '23514');
  });

  await t.test('restricted places are refused in profiles, preferences and followed regions', async () => {
    await fails(as(dana, (trx) => trx.updateTable('person_profile').set({ region_code: 'RU' }).where('person_id', '=', dana).execute()), 'profiles.restricted_place');
    await fails(as(dana, (trx) => personPreferences.update(trx, dana, 1, { intents: [], topics: [], regions: ['US-CA', 'UA-43'], onboarding_completed_at: null })), 'profiles.restricted_place');
    await fails(as(dana, (trx) => follows.insert(trx, { follower_person_id: dana, target_kind: 'region', target_id: null, target_code: 'KP' })), 'profiles.restricted_place');
  });

  await t.test('consent records are never rewritten; withdrawal is the one change and only by the subject', async () => {
    const consent = await as(dana, (trx) => consentRecords.live(trx, dana, 'profile_public', null));
    assert.ok(consent);
    await fails(as(dana, (trx) => trx.updateTable('consent_record').set({ withdrawn_at: null }).where('id', '=', consent.id).execute()), 'profiles.consent_immutable');
    await fails(db.app.query('UPDATE trustwork.consent_record SET notice_version = $1 WHERE id = $2', ['profile_public.v2', consent.id]), '42501');
    const byOther = await as(anna, (trx) => consentRecords.withdraw(trx, consent.id, 'not mine'));
    assert.equal(byOther, undefined, 'another person cannot even see the record');
    await fails(db.app.query('DELETE FROM trustwork.consent_record'), '42501');
  });

  await t.test('company listing and mentions need a live consent naming that company or publication', async () => {
    const listed = async () => (await withMaintenance(db.admin, (trx) => publicProfiles.companyPeople(trx, mixed))).map((p) => p.id);
    assert.deepEqual(await listed(), [], 'a public member without listed_by_company consent is not listed');
    const listing = await as(dana, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'listed_by_company', target_kind: 'company', target_id: mixed, notice_version: 'listed_by_company.v1', evidence: evidence('r-3') }));
    assert.deepEqual(await listed(), [dana]);
    assert.deepEqual((await withMaintenance(db.admin, (trx) => publicProfiles.companyPeople(trx, seed.companies.supplier))), [], 'consent for one company lists nowhere else');
    const publication = '0198b1d0-0000-7000-8000-0000000000aa';
    assert.deepEqual(await withMaintenance(db.admin, (trx) => publicProfiles.consentedMentions(trx, publication, [dana, anna, petr])), []);
    const mention = await as(dana, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'mentioned_in_publication', target_kind: 'publication', target_id: publication, notice_version: 'mentioned_in_publication.v1', evidence: evidence('r-4') }));
    assert.deepEqual(await withMaintenance(db.admin, (trx) => publicProfiles.consentedMentions(trx, publication, [dana, anna, petr])), [dana]);
    // Withdrawing either consent unpublishes in the same transaction and leaves a tombstone with an outbox event.
    await as(dana, async (trx) => {
      await consentRecords.withdraw(trx, listing.id, 'left the company page');
      await consentRecords.withdraw(trx, mention.id, 'no longer agree');
    });
    assert.deepEqual(await listed(), []);
    assert.deepEqual(await withMaintenance(db.admin, (trx) => publicProfiles.consentedMentions(trx, publication, [dana])), []);
    const stones = await as(dana, (trx) => profileTombstones.listForSubject(trx, dana));
    assert.deepEqual(stones.map((s) => [s.projection, s.target_kind, s.target_id, s.reason]), [['company_listing', 'company', mixed, 'consent_withdrawn'], ['publication_mention', 'publication', publication, 'consent_withdrawn']]);
    assert.equal(await count("SELECT count(*)::int AS n FROM trustwork.outbox_event WHERE type = 'profile.projection_withdrawn' AND aggregate_id = $1", [dana]), 2);
    const payload = (await db.admin.query("SELECT payload FROM trustwork.outbox_event WHERE type = 'profile.projection_withdrawn' AND aggregate_id = $1 LIMIT 1", [dana])).rows[0].payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ['consentId', 'personId', 'portraitId', 'projection', 'reason', 'targetId', 'targetKind', 'tombstoneId'], 'identifiers only');
    await fails(db.admin.query('UPDATE trustwork.profile_tombstone SET reason = $1', ['portrait_removed']), 'audit.append_only');
  });

  let assetId = '';
  let licenceId = '';
  await t.test('a portrait is shown only with both a live consent and a licence record on the person\'s own public image', async () => {
    const upload = (owner: string, classification: string, key: string) => as(owner, (trx) => trx.insertInto('evidence_artifact').values({
      owner_person_id: owner, owner_company_id: null, parent_kind: 'person', parent_id: owner, classification: classification as 'public', storage_key: key, sha256: 'b'.repeat(64), bytes: 1024,
      media_type: 'image/jpeg', uploaded_by: owner,
    }).returning('id').executeTakeFirstOrThrow());
    assetId = (await upload(dana, 'public', 'person/dana/portrait-1.jpg')).id;
    const privateAsset = (await upload(dana, 'owner_private', 'person/dana/private-1.jpg')).id;
    const annaAsset = (await upload(anna, 'public', 'person/anna/portrait-1.jpg')).id;
    await fails(as(dana, (trx) => mediaLicences.insert(trx, { asset_id: annaAsset, owner_person_id: dana, licensor: 'Fixture Dana', licence_kind: 'own_work', scope: 'profile portrait', valid_until: null, recorded_by_person_id: dana })), 'profiles.asset_not_owned');
    const licence = await as(dana, (trx) => mediaLicences.insert(trx, { asset_id: assetId, owner_person_id: dana, licensor: 'Fixture Dana', licence_kind: 'own_work', scope: 'profile portrait', valid_until: null, recorded_by_person_id: dana }));
    licenceId = licence.id;
    // No consent yet: refused.
    const noConsent = await as(dana, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'marketing', target_kind: null, target_id: null, notice_version: 'marketing.v1', evidence: evidence('r-5') }));
    await fails(as(dana, (trx) => portraits.insertShown(trx, { person_id: dana, asset_id: assetId, media_licence_id: licence.id, consent_record_id: noConsent.id })), 'profiles.consent_required');
    const consent = await as(dana, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'portrait_display', target_kind: null, target_id: null, notice_version: 'portrait_display.v1', evidence: evidence('r-6') }));
    // A licence on another file, a private image or a stranger's consent: refused.
    const privateLicence = await as(dana, (trx) => mediaLicences.insert(trx, { asset_id: privateAsset, owner_person_id: dana, licensor: 'Fixture Dana', licence_kind: 'own_work', scope: 'profile portrait', valid_until: null, recorded_by_person_id: dana }));
    await fails(as(dana, (trx) => portraits.insertShown(trx, { person_id: dana, asset_id: assetId, media_licence_id: privateLicence.id, consent_record_id: consent.id })), 'profiles.licence_missing');
    await fails(as(dana, (trx) => portraits.insertShown(trx, { person_id: dana, asset_id: privateAsset, media_licence_id: privateLicence.id, consent_record_id: consent.id })), 'profiles.asset_not_owned');
    await fails(as(anna, (trx) => portraits.insertShown(trx, { person_id: dana, asset_id: assetId, media_licence_id: licence.id, consent_record_id: consent.id })), '42501');
    const portrait = await as(dana, (trx) => portraits.insertShown(trx, { person_id: dana, asset_id: assetId, media_licence_id: licence.id, consent_record_id: consent.id }));
    await as(dana, (trx) => personProfiles.update(trx, dana, 1, { role_line: 'Facade engineer', region_code: 'US-CA', show_employer: true, topics: ['materials'], languages: ['en'], public_fields: ['roleLine', 'region', 'topics', 'employer', 'experience', 'portrait'] }));
    assert.equal((await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)))?.portrait, null, 'an unscanned file is never shown');
    await withMaintenance(db.admin, (trx) => trx.updateTable('evidence_artifact').set({ scan_state: 'clean' }).where('id', '=', assetId).execute());
    assert.deepEqual((await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)))?.portrait, { portraitId: portrait.id, assetId });
    // Withdrawal of the portrait consent hides it in the same transaction, with a tombstone.
    await as(dana, (trx) => consentRecords.withdraw(trx, consent.id, 'no portrait please'));
    assert.equal((await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)))?.portrait, null);
    const after = await as(dana, (trx) => portraits.listForPerson(trx, dana));
    assert.deepEqual(after.map((p) => [p.status, p.withdrawn_reason]), [['withdrawn', 'consent_withdrawn']]);
    assert.ok((await as(dana, (trx) => profileTombstones.listForSubject(trx, dana))).some((s) => s.projection === 'portrait' && s.portrait_id === portrait.id && s.reason === 'consent_withdrawn'));
    await fails(as(dana, (trx) => trx.updateTable('portrait').set({ status: 'shown', withdrawn_at: null, withdrawn_reason: null }).where('id', '=', portrait.id).execute()), 'profiles.portrait_immutable');
  });

  await t.test('revoking the licence withdraws the portrait relying on it', async () => {
    const consent = await as(dana, (trx) => consentRecords.insert(trx, { subject_person_id: dana, purpose: 'portrait_display', target_kind: null, target_id: null, notice_version: 'portrait_display.v1', evidence: evidence('r-7') }));
    const portrait = await as(dana, (trx) => portraits.insertShown(trx, { person_id: dana, asset_id: assetId, media_licence_id: licenceId, consent_record_id: consent.id }));
    assert.equal((await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)))?.portrait?.portraitId, portrait.id);
    await fails(as(dana, (trx) => trx.updateTable('media_licence').set({ scope: 'everything' }).where('id', '=', licenceId).execute()), '42501');
    await as(dana, (trx) => mediaLicences.revoke(trx, licenceId, dana, 'licence ended'));
    assert.equal((await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)))?.portrait, null);
    assert.equal((await as(dana, (trx) => portraits.listForPerson(trx, dana))).find((p) => p.id === portrait.id)?.withdrawn_reason, 'licence_revoked');
    await fails(as(dana, (trx) => portraits.insertShown(trx, { person_id: dana, asset_id: assetId, media_licence_id: licenceId, consent_record_id: consent.id })), 'profiles.licence_missing');
  });

  await t.test('experience belongs to the person, survives the end of employment and is never self-confirmed', async () => {
    const [entry] = await as(dana, (trx) => experienceEntries.listForPerson(trx, dana));
    assert.ok(entry);
    assert.equal((await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)))?.experience[0]?.confirmation, 'self_declared');
    await fails(as(dana, (trx) => trx.updateTable('experience_entry').set({ confirmed_by_company_at: new Date() } as never).where('id', '=', entry.id).execute()), '42501');
    const adminEdit = await as(anna, (trx) => experienceEntries.update(trx, entry.id, entry.revision, { organisation_company_id: mixed, organisation_name: 'Rewritten', role: 'Intern', summary: null, from_date: '2025-01-01', to_date: null, visibility: 'public' }));
    assert.equal(adminEdit, undefined, 'the employer cannot rewrite the person\'s experience');
    // The membership ends; the experience stays, still the person's and still public.
    await withMaintenance(db.admin, (trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: anna, ended_reason: 'fixture: contract ended' }).where('person_id', '=', dana).where('status', '=', 'active').execute());
    const kept = await as(dana, (trx) => experienceEntries.listForPerson(trx, dana));
    assert.deepEqual(kept.map((e) => [e.id, e.organisation_name, e.role]), [[entry.id, 'Fixture Mixed Company', 'Facade engineer']]);
    const pub = await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana));
    assert.equal(pub?.experience.length, 1);
    assert.equal(pub?.employer, null, 'no active membership: no employer line');
    // A recorded confirmation is cleared when the confirmed facts change.
    await withMaintenance(db.admin, (trx) => trx.updateTable('experience_entry').set({ confirmed_by_company_at: new Date(), confirmed_by_person_id: anna }).where('id', '=', entry.id).execute());
    assert.equal((await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)))?.experience[0]?.confirmation, 'company_confirmed');
    const current = await as(dana, (trx) => experienceEntries.get(trx, entry.id));
    const edited = await as(dana, (trx) => experienceEntries.update(trx, entry.id, current?.revision as number, { organisation_company_id: mixed, organisation_name: 'Fixture Mixed Company', role: 'Lead facade engineer', summary: null, from_date: '2025-01-01', to_date: '2026-10-31', visibility: 'public' }));
    assert.equal(edited?.confirmed_by_company_at, null);
    const archived = await as(dana, (trx) => experienceEntries.archive(trx, entry.id, edited?.revision as number));
    assert.ok(archived?.archived_at);
    assert.equal((await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)))?.experience.length, 0, 'archived entries are not public');
  });

  await t.test('withdrawing profile_public unpublishes the profile in the same transaction and records a tombstone', async () => {
    const consent = await as(dana, (trx) => consentRecords.live(trx, dana, 'profile_public', null));
    assert.ok(consent);
    // Rolled back: nothing changes.
    await assert.rejects(as(dana, async (trx) => {
      await consentRecords.withdraw(trx, consent.id, 'rollback probe');
      throw new Error('abort');
    }), /abort/);
    assert.equal((await withMaintenance(db.admin, (trx) => profileIdentity.get(trx, dana)))?.profile_visibility, 'public');
    await as(dana, async (trx) => {
      await consentRecords.withdraw(trx, consent.id, 'going private');
      assert.equal((await profileIdentity.get(trx, dana))?.profile_visibility, 'private', 'private inside the same transaction');
    });
    assert.equal(await withMaintenance(db.admin, (trx) => publicProfiles.profile(trx, dana)), undefined);
    assert.ok((await as(dana, (trx) => profileTombstones.listForSubject(trx, dana))).some((s) => s.projection === 'profile' && s.consent_record_id === consent.id));
    assert.equal(await as(dana, (trx) => consentRecords.withdraw(trx, consent.id, 'twice')), undefined, 'a withdrawn record is not withdrawn again');
    await fails(as(dana, (trx) => trx.updateTable('consent_record').set({ withdrawn_reason: 'rewritten' }).where('id', '=', consent.id).execute()), 'profiles.consent_immutable');
  });

  await t.test('concurrent writers: one profile edit per revision, one live consent per purpose', async () => {
    await as(petr, (trx) => personProfiles.insert(trx, { person_id: petr, role_line: null, region_code: null, show_employer: false, topics: [], languages: [], public_fields: [] }));
    const edits = await Promise.allSettled([1, 2].map((n) => as(petr, async (trx) => {
      const row = await personProfiles.update(trx, petr, 1, { role_line: `Editor ${n}`, region_code: null, show_employer: false, topics: [], languages: [], public_fields: [] });
      if (!row) throw Object.assign(new Error('revision moved'), { code: 'revision' });
      return row;
    })));
    assert.equal(edits.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(edits.filter((r) => r.status === 'rejected').length, 1);
    const grants = await Promise.allSettled([1, 2].map((n) => as(petr, (trx) => consentRecords.insert(trx, { subject_person_id: petr, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: 'profile_public.v1', evidence: evidence(`r-c${n}`) }))));
    assert.equal(grants.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((grants.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code, '23505');
    assert.equal(await count("SELECT count(*)::int AS n FROM trustwork.consent_record WHERE subject_person_id = $1 AND purpose = 'profile_public' AND withdrawn_at IS NULL", [petr]), 1);
  });
});
