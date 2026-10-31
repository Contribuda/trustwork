import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { computeDigest, computeRfqVersionDigest, quoteVersionDigestInput } from '@trustwork/contracts';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';
import {
  bundleComponents, cataloguePublic, needs, offeringPrivate, offerings, offeringVersions, rfqInvitations, rfqPrivate, rfqPublic, rfqs, rfqVersions,
} from '../../../packages/data/src/repositories/commerce.js';
import { offeringQuoteSnapshot, offeringVersionDigestInput, type OwnerOfferingVersion } from '../../../packages/contracts/src/commerce.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { principalFor, seedFixtures } from '../../data/helpers/seed.js';

/**
 * COM-001 database layer under the real runtime role (FORCE RLS, no mocks): owner-side catalogues, needs and RFQs;
 * published offering and RFQ versions frozen for every role; private knowledge and the buyer-private constraint
 * invisible to everyone else; invitations pinned to the current version, flagged stale by an amendment in the same
 * transaction and never un-flagged; the invitee projection; explicit units and restricted places at publication; and
 * concurrent publication and invitation.
 */
const db = await provisionTestDatabase('commerce_db');

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
const offeringPayload = (title: string, components: unknown[] = []) => ({
  title, description: 'Kiln-dried, graded', specification: { species: 'western red cedar', grade: 'clear' }, unit: 'lm', listPrice: { minorUnits: '1500', currency: 'USD' }, options: [],
  availability: { state: 'available', capacity: { value: '5000', unit: 'lm' }, observedAt: '2026-10-31T10:00:00.000Z' }, components,
});
const rfqPayload = (quantity: string, region = 'US-CA', unit = 'm2') => ({
  title: 'Patio pavers and laying', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [], paymentTermsRequested: null, acceptanceCriteria: 'Level within 3 mm per metre',
  deliveryTerms: { location: { region }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  lines: [
    { lineId: 'l1', kind: 'goods', description: 'Concrete pavers', specification: { colour: 'grey' }, quantity: { value: quantity, unit }, alternativesAllowed: true },
    { lineId: 'l2', kind: 'works', description: 'Lay the pavers', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false },
    { lineId: 'l3', kind: 'services', description: 'Site supervision', specification: {}, quantity: { value: '8', unit: 'h' }, alternativesAllowed: false },
  ],
});

test('commerce database: RLS, frozen versions, private records, pinned invitations, staleness and concurrency', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  await withMaintenance(db.admin, (trx) => kernelReference.fromRepository().then((reference) => kernelSync.apply(trx, reference)));
  const { petr, anna, boris, carl, xenia, pure } = seed.people;
  const { mixed, supplier } = seed.companies;
  // Anna (mixed company) may also publish; Boris acts for the supplier company with company.deals.manage only.
  await withMaintenance(db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.publish'] }).where('id', '=', seed.memberships.anna).execute());
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(db.app, await principalFor(db.admin, personId), fn);

  /* ---------- Catalogue ---------- */
  let offeringId = '';
  let v1Id = '';
  await t.test('offerings: only the owner side reads and writes; private knowledge never leaves it', async () => {
    const created = await as(anna, async (trx) => {
      const offering = await offerings.insert(trx, { owner_person_id: null, owner_company_id: mixed, created_by_person_id: anna, kind: 'goods' });
      const v1 = await offeringVersions.insertDraft(trx, { offering_id: offering.id, version: 1, payload: offeringPayload('Cedar decking'), public_fields: ['title', 'unit', 'specification'], drafted_by_person_id: anna });
      await offeringPrivate.upsert(trx, { offering_version_id: v1.id, offering_id: offering.id, cost_basis_minor: '900', cost_basis_currency: 'USD', margin_target: '0.25', notes: 'PRIVATE-supplier-terms', updated_by_person_id: anna });
      return { offering, v1 };
    });
    offeringId = created.offering.id;
    v1Id = created.v1.id;
    for (const outsider of [boris, carl, petr, xenia]) {
      assert.equal(await as(outsider, (trx) => offerings.get(trx, offeringId)), undefined, 'not the owner side: no offering');
      assert.equal(await as(outsider, (trx) => offeringVersions.get(trx, v1Id)), undefined);
      assert.deepEqual(await as(outsider, (trx) => offeringPrivate.listFor(trx, offeringId)), [], 'private knowledge is invisible');
    }
    await fails(as(carl, (trx) => offerings.insert(trx, { owner_person_id: null, owner_company_id: mixed, created_by_person_id: carl, kind: 'goods' })), '42501');
    await fails(as(boris, (trx) => offeringPrivate.upsert(trx, { offering_version_id: v1Id, offering_id: offeringId, cost_basis_minor: '1', cost_basis_currency: 'USD', margin_target: null, notes: null, updated_by_person_id: boris })), '42501');
    assert.deepEqual(await as(carl, (trx) => cataloguePublic.list(trx, { ownerCompanyId: mixed })), [], 'a draft offering is not public');
  });

  await t.test('publication freezes the version for every role; the public sees only allowlisted fields', async () => {
    await as(anna, async (trx) => {
      await offerings.lock(trx, offeringId);
      const v = await offeringVersions.publish(trx, v1Id, { digest: computeDigest(offeringVersionDigestInput(offeringPayload('Cedar decking') as never)).value, personId: anna, via: 'person', mandateId: null, at: new Date() });
      assert.equal(v?.status, 'published');
      await offerings.setCurrent(trx, offeringId, { current_version: 1, current_version_id: v1Id });
    });
    await fails(as(anna, (trx) => trx.updateTable('offering_version').set({ payload: JSON.stringify(offeringPayload('Changed')) }).where('id', '=', v1Id).execute()), 'commercial.version_frozen');
    await fails(as(anna, (trx) => trx.updateTable('offering_version').set({ public_fields: ['title', 'listPrice'] }).where('id', '=', v1Id).execute()), 'commercial.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('offering_version').set({ payload: JSON.stringify(offeringPayload('Owner edit')) }).where('id', '=', v1Id).execute()), 'commercial.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.offering_version WHERE id = ${v1Id}`.execute(trx)), 'commerce.retained');
    const anonymous = await db.app.query('SELECT * FROM trustwork.catalogue_public_offerings(NULL, $1::uuid, NULL, NULL)', [mixed]);
    assert.equal(anonymous.rows.length, 1, 'anonymous callers read the public catalogue');
    const fields = anonymous.rows[0].fields as Record<string, unknown>;
    assert.deepEqual(Object.keys(fields).sort(), ['specification', 'title', 'unit'], 'only allowlisted keys');
    // Ids and timestamps are random; strip them so a number like 900 inside a uuid or a time is not mistaken for a leak.
    const json = JSON.stringify(anonymous.rows)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, '');
    for (const secret of ['1500', 'listPrice', 'PRIVATE-', '900', 'costBasis', 'Kiln-dried']) assert.ok(!json.includes(secret), `${secret} is not public`);
    assert.equal((await db.app.query('SELECT count(*)::int AS n FROM trustwork.offering_version')).rows[0].n, 0, 'raw rows stay closed without identity');
  });

  await t.test('a catalogue edit opens a new version and cannot change a quote snapshot of the old one', async () => {
    const v1 = await as(anna, (trx) => offeringVersions.get(trx, v1Id));
    const cited: OwnerOfferingVersion = { id: v1Id, offeringId, version: 1, status: 'published', payload: v1?.payload as OwnerOfferingVersion['payload'], publicFields: [], privateKnowledge: { costBasis: null, marginTarget: null, notes: null }, publishedAt: null, digest: null };
    const snapshot = offeringQuoteSnapshot({ kind: 'goods' }, cited, 'goods');
    const quotePayload = {
      currency: 'USD', paymentTerms: 'Net 30', validity: { until: '2027-03-01T00:00:00.000Z' }, exclusions: [], attachments: [], deliveryTerms: { milestones: [], location: 'Site' },
      totals: { net: { minorUnits: '150000', currency: 'USD' }, tax: { minorUnits: '0', currency: 'USD' }, gross: { minorUnits: '150000', currency: 'USD' } },
      lines: [{ lineId: 'q1', rfqLineId: null, kind: 'goods' as const, specSnapshot: snapshot.specSnapshot, offeringVersionRef: snapshot.offeringVersionRef, quantity: { value: '100', unit: 'lm' }, unitPrice: { minorUnits: '1500', currency: 'USD' }, tax: { kind: 'none' as const, ratePercent: null, included: false }, taxAmount: { minorUnits: '0', currency: 'USD' }, lineTotal: { minorUnits: '150000', currency: 'USD' }, substitution: null, options: [] }],
    };
    const rfqRef = { id: 'rfq-v1-demo', version: 1, digest: { algorithm: 'trustwork-digest-1' as const, value: 'a'.repeat(64) } };
    const quoteDigest = computeDigest(quoteVersionDigestInput(rfqRef, quotePayload)).value;

    await as(anna, async (trx) => {
      await offerings.lock(trx, offeringId);
      const v2 = await offeringVersions.insertDraft(trx, { offering_id: offeringId, version: 2, payload: offeringPayload('Cedar decking, new grade'), public_fields: ['title'], drafted_by_person_id: anna });
      await trx.updateTable('offering_version').set({ payload: JSON.stringify({ ...offeringPayload('Cedar decking, new grade'), specification: { species: 'pressure-treated pine' } }) }).where('id', '=', v2.id).execute();
      await offeringVersions.supersede(trx, v1Id, new Date());
      await offeringVersions.publish(trx, v2.id, { digest: 'b'.repeat(64), personId: anna, via: 'person', mandateId: null, at: new Date() });
      await offerings.setCurrent(trx, offeringId, { current_version: 2, current_version_id: v2.id });
    });
    const after = await as(anna, (trx) => offeringVersions.get(trx, v1Id));
    assert.equal(after?.status, 'superseded');
    assert.deepEqual(after?.payload, v1?.payload, 'the cited version is byte-for-byte what it was');
    assert.equal(after?.digest, v1?.digest);
    const again = offeringQuoteSnapshot({ kind: 'goods' }, { ...cited, payload: after?.payload as OwnerOfferingVersion['payload'] }, 'goods');
    assert.deepEqual(again, snapshot);
    assert.equal(computeDigest(quoteVersionDigestInput(rfqRef, { ...quotePayload, lines: [{ ...quotePayload.lines[0]!, specSnapshot: again.specSnapshot }] })).value, quoteDigest, 'the sent quote digest is unchanged by the catalogue edit');
    await fails(as(anna, (trx) => trx.updateTable('offering_version').set({ payload: JSON.stringify(offeringPayload('rewrite history')) }).where('id', '=', v1Id).execute()), 'commercial.version_frozen');
    const pub = await as(carl, (trx) => cataloguePublic.list(trx, { offeringId, version: 1 }));
    assert.deepEqual((pub[0]?.fields as { specification: unknown }).specification, { species: 'western red cedar', grade: 'clear' }, 'the public may read the cited version');
  });

  await t.test('bundles pin published component versions; components never change after publication', async () => {
    await fails(as(anna, async (trx) => {
      const unmaterialised = await offerings.insert(trx, { owner_person_id: null, owner_company_id: mixed, created_by_person_id: anna, kind: 'bundle' });
      const draft = await offeringVersions.insertDraft(trx, { offering_id: unmaterialised.id, version: 1, payload: offeringPayload('Deck kit', [{ offeringId, version: 2, quantity: { value: '120', unit: 'lm' } }]), public_fields: ['title'], drafted_by_person_id: anna });
      await offeringVersions.publish(trx, draft.id, { digest: 'c'.repeat(64), personId: anna, via: 'person', mandateId: null, at: new Date() });
    }), 'commerce.parts_missing');
    const kit = await as(anna, async (trx) => {
      const k = await offerings.insert(trx, { owner_person_id: null, owner_company_id: mixed, created_by_person_id: anna, kind: 'bundle' });
      const draft = await offeringVersions.insertDraft(trx, { offering_id: k.id, version: 1, payload: offeringPayload('Deck kit', [{ offeringId, version: 2, quantity: { value: '120', unit: 'lm' } }]), public_fields: ['title'], drafted_by_person_id: anna });
      await bundleComponents.materialise(trx, draft.id, [{ offeringId, version: 2, quantity: { value: '120', unit: 'lm' } }]);
      await offeringVersions.publish(trx, draft.id, { digest: 'c'.repeat(64), personId: anna, via: 'person', mandateId: null, at: new Date() });
      return { id: k.id, versionId: draft.id };
    });
    await fails(as(anna, (trx) => bundleComponents.materialise(trx, kit.versionId, [{ offeringId, version: 1, quantity: { value: '1', unit: 'lm' } }])), 'commerce.version_frozen');
    await fails(as(anna, (trx) => trx.updateTable('bundle_component').set({ quantity_value: '999' }).where('offering_version_id', '=', kit.versionId).execute()), '42501');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('bundle_component').set({ quantity_value: '999' }).where('offering_version_id', '=', kit.versionId).execute()), 'commerce.retained');
    await fails(as(anna, async (trx) => {
      const k = await offerings.insert(trx, { owner_person_id: null, owner_company_id: mixed, created_by_person_id: anna, kind: 'bundle' });
      const draft = await offeringVersions.insertDraft(trx, { offering_id: k.id, version: 1, payload: offeringPayload('Bad kit'), public_fields: [], drafted_by_person_id: anna });
      await bundleComponents.materialise(trx, draft.id, [{ offeringId: kit.id, version: 9, quantity: { value: '1', unit: 'pc' } }]);
    }), 'commerce.component_unpublished');
  });

  /* ---------- Needs ---------- */
  await t.test('needs: owner side only, append-only line sets, a converted need is frozen', async () => {
    const need = await as(petr, async (trx) => {
      const row = await needs.insert(trx, {
        owner_person_id: petr, owner_company_id: null, project_id: seed.project, created_by_person_id: petr, source: 'file', status: 'clarifying', title: 'Patio', description: null, region: 'US-CA',
        window_from: null, window_to: null, window_time_zone: null, window_to_time_zone: null, acceptance_criteria: null, missing_fields: ['window', 'acceptanceCriteria'],
      });
      await needs.insertLines(trx, row.id, row.revision, [{ kind: 'goods', description: 'Pavers', quantity: { value: '30', unit: 'm2' }, specification: {}, alternativesAllowed: true, evidence: { source: 'spreadsheet', ref: 'upload-1', locator: 'B4' } }]);
      return row;
    });
    for (const outsider of [boris, carl, anna]) assert.equal(await as(outsider, (trx) => needs.get(trx, need.id)), undefined);
    await fails(as(petr, (trx) => needs.insertLines(trx, need.id, need.revision + 5, [{ kind: null, description: 'x', quantity: null, specification: {}, alternativesAllowed: false, evidence: null }])), 'commerce.version_frozen');
    await fails(as(petr, (trx) => trx.updateTable('need_line').set({ description: 'edited' }).where('need_id', '=', need.id).execute()), '42501');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('need_line').set({ description: 'edited' }).where('need_id', '=', need.id).execute()), 'audit.append_only');
    await fails(as(petr, (trx) => sql`INSERT INTO trustwork.need_line (need_id, need_revision, position, description, quantity_value, quantity_unit) VALUES (${need.id}, ${need.revision}, 7, 'x', '1', 'furlong')`.execute(trx)), '23503');
    await fails(as(petr, (trx) => trx.updateTable('need').set({ status: 'ready', missing_fields: ['window'] }).where('id', '=', need.id).execute()), '23514');
    await fails(as(petr, (trx) => needs.insert(trx, {
      owner_person_id: petr, owner_company_id: null, project_id: null, created_by_person_id: petr, source: 'manual', status: 'draft', title: 'Somewhere restricted', description: null, region: 'IR',
      window_from: null, window_to: null, window_time_zone: null, window_to_time_zone: null, acceptance_criteria: null, missing_fields: ['lines'],
    })), 'commerce.restricted_place');
    await fails(as(boris, (trx) => needs.insert(trx, {
      owner_person_id: null, owner_company_id: supplier, project_id: seed.project, created_by_person_id: boris, source: 'manual', status: 'draft', title: 'Someone else project', description: null, region: null,
      window_from: null, window_to: null, window_time_zone: null, window_to_time_zone: null, acceptance_criteria: null, missing_fields: ['lines'],
    })), 'commerce.project_mismatch');
  });

  /* ---------- RFQs ---------- */
  let rfqId = '';
  let rv1 = '';
  const publishAs = async (personId: string, id: string, versionId: string, quantity: string, reason: string | null, previous: string | null, region = 'US-CA') => as(personId, async (trx) => {
    const locked = await rfqs.lock(trx, id);
    if (previous) await rfqVersions.supersede(trx, previous, (locked?.current_version ?? 0) + 1, new Date());
    const v = await rfqVersions.publish(trx, versionId, { digest: computeRfqVersionDigest(rfqPayload(quantity, region) as never).value, personId, via: 'person', mandateId: null, amendmentReason: reason, at: new Date() });
    if (!v) throw Object.assign(new Error('the draft was published by someone else'), { code: 'no_rows' });
    return rfqs.setCurrent(trx, id, { current_version: v?.version as number, current_version_id: versionId });
  });

  await t.test('RFQs: the buyer side drafts and publishes; the published version and the private constraint are protected', async () => {
    const created = await as(anna, async (trx) => {
      const rfq = await rfqs.insert(trx, { owner_person_id: null, owner_company_id: mixed, project_id: null, creator_person_id: anna, need_id: null, plan_project_id: null, plan_item_key: null, public_projection_enabled: false, public_projection_fields: [], category: 'landscaping' });
      const v1 = await rfqVersions.insertDraft(trx, { rfq_id: rfq.id, version: 1, payload: rfqPayload('10'), drafted_by_person_id: anna, amendment_reason: null });
      await rfqPrivate.insert(trx, { rfq_id: rfq.id, owner_person_id: null, owner_company_id: mixed, budget_ceiling_minor: '777700', budget_ceiling_currency: 'USD', evaluation_weights: { price: '0.6' }, internal_notes: 'PRIVATE-buyer-note', shortlist: [{ kind: 'company', id: supplier }], updated_by_person_id: anna });
      return { rfq, v1 };
    });
    rfqId = created.rfq.id;
    rv1 = created.v1.id;
    await fails(as(boris, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv1, party_person_id: null, party_company_id: supplier, channel: 'platform', sent_by_person_id: boris, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null })), 'commerce.not_authorised');
    await fails(as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv1, party_person_id: null, party_company_id: supplier, channel: 'platform', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null })), 'commerce.rfq_version_not_current');
    // Units are explicit at publication (the database refuses a unit outside the catalogue even if a caller skipped the contract).
    await as(anna, (trx) => rfqVersions.saveDraft(trx, rv1, rfqPayload('10', 'US-CA', 'bushel')));
    await fails(publishAs(anna, rfqId, rv1, '10', null, null), 'commerce.unknown_unit');
    await as(anna, (trx) => rfqVersions.saveDraft(trx, rv1, rfqPayload('10', 'RU')));
    await fails(publishAs(anna, rfqId, rv1, '10', null, null, 'RU'), 'commerce.restricted_place');
    await as(anna, (trx) => rfqVersions.saveDraft(trx, rv1, rfqPayload('10')));
    assert.equal(await as(xenia, (trx) => rfqVersions.saveDraft(trx, rv1, rfqPayload('11'))), undefined, 'a former member edits nothing');
    assert.equal(await as(boris, (trx) => rfqVersions.saveDraft(trx, rv1, rfqPayload('11'))), undefined, 'another company edits nothing');
    const published = await publishAs(anna, rfqId, rv1, '10', null, null);
    assert.equal(published.status, 'published');
    await fails(as(anna, (trx) => trx.updateTable('rfq_version').set({ payload: JSON.stringify(rfqPayload('99')) }).where('id', '=', rv1).execute()), 'commercial.version_frozen');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('rfq_version').set({ digest: 'f'.repeat(64) }).where('id', '=', rv1).execute()), 'commercial.version_frozen');
    await fails(as(anna, (trx) => trx.updateTable('rfq_version').set({ status: 'draft', published_at: null }).where('id', '=', rv1).execute()), 'commercial.version_frozen');
    await fails(as(anna, (trx) => rfqVersions.insertDraft(trx, { rfq_id: rfqId, version: 3, payload: rfqPayload('10'), drafted_by_person_id: anna, amendment_reason: 'skip' })), 'commerce.invalid_transition');
    await fails(as(anna, (trx) => rfqVersions.insertDraft(trx, { rfq_id: rfqId, version: 2, payload: rfqPayload('10'), drafted_by_person_id: anna, amendment_reason: null })), '23514');
  });

  let invitationId = '';
  await t.test('invitations pin the current version; the invitee reads its own rows and pinned versions only, never the private constraint', async () => {
    const invitation = await as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv1, party_person_id: null, party_company_id: supplier, channel: 'platform', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null }));
    invitationId = invitation.id;
    await as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv1, party_person_id: pure, party_company_id: null, channel: 'email', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null }));
    await fails(as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv1, party_person_id: null, party_company_id: mixed, channel: 'platform', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null })), 'commerce.self_invitation');
    await fails(as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv1, party_person_id: null, party_company_id: supplier, channel: 'email', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null })), '23505');
    // Boris (supplier, company.deals.manage) reads the envelope, the pinned version and his company's invitation only.
    assert.equal((await as(boris, (trx) => rfqs.get(trx, rfqId)))?.id, rfqId);
    assert.deepEqual((await as(boris, (trx) => rfqVersions.listFor(trx, rfqId))).map((v) => v.id), [rv1]);
    assert.deepEqual((await as(boris, (trx) => rfqInvitations.listForRfq(trx, rfqId))).map((i) => i.id), [invitationId], 'never the other invitations');
    assert.equal(await as(boris, (trx) => rfqPrivate.get(trx, rfqId)), undefined, 'the buyer-private constraint is invisible to the invitee');
    for (const outsider of [carl, petr, xenia]) {
      assert.equal(await as(outsider, (trx) => rfqs.get(trx, rfqId)), undefined);
      assert.deepEqual(await as(outsider, (trx) => rfqVersions.listFor(trx, rfqId)), []);
      assert.equal(await as(outsider, (trx) => rfqPrivate.get(trx, rfqId)), undefined);
    }
    assert.equal(await as(anna, (trx) => rfqPublic.read(trx, rfqId)), undefined, 'no public projection unless enabled');
    // The invitee cannot widen, re-pin or withdraw; it may record that it viewed.
    await fails(as(boris, (trx) => trx.updateTable('rfq_invitation').set({ status: 'withdrawn', withdrawn_reason: 'x' }).where('id', '=', invitationId).execute()), 'commerce.not_authorised');
    await fails(as(boris, (trx) => sql`UPDATE trustwork.rfq_invitation SET rfq_version_id = rfq_version_id, channel = 'email' WHERE id = ${invitationId}`.execute(trx)), '42501');
    assert.equal((await as(boris, (trx) => rfqInvitations.setStatus(trx, invitationId, 'sent', { status: 'viewed', withdrawn_reason: null })))?.status, 'viewed');
    const hijack = await as(boris, (trx) => trx.updateTable('rfq_private_constraint').set({ internal_notes: 'hijack' }).where('rfq_id', '=', rfqId).executeTakeFirst());
    assert.equal(Number(hijack.numUpdatedRows), 0, 'an invitee update touches nothing');
    assert.equal((await as(anna, (trx) => rfqPrivate.get(trx, rfqId)))?.internal_notes, 'PRIVATE-buyer-note');
  });

  let rv2 = '';
  await t.test('an amendment flags every earlier invitation stale in the same transaction; the flag is never cleared; the invitee sees only what it was sent', async () => {
    const draft = await as(anna, async (trx) => {
      await rfqs.lock(trx, rfqId);
      return rfqVersions.insertDraft(trx, { rfq_id: rfqId, version: 2, payload: rfqPayload('100'), drafted_by_person_id: anna, amendment_reason: 'Quantity changed from 10 to 100' });
    });
    rv2 = draft.id;
    assert.deepEqual((await as(boris, (trx) => rfqVersions.listFor(trx, rfqId))).map((v) => v.id), [rv1], 'the draft amendment is invisible to the invitee');
    await publishAs(anna, rfqId, rv2, '100', 'Quantity changed from 10 to 100', rv1);
    const flagged = await as(anna, (trx) => rfqInvitations.listForRfq(trx, rfqId));
    assert.equal(flagged.length, 2);
    assert.ok(flagged.every((i) => i.stale_reason === 'rfq_amended' && i.rfq_version_id === rv1), 'every v1 invitation is flagged, and its status is untouched');
    assert.deepEqual(flagged.map((i) => i.status).sort(), ['sent', 'viewed']);
    await fails(as(anna, (trx) => trx.updateTable('rfq_invitation').set({ stale_reason: null, stale_at: null }).where('id', '=', invitationId).execute()), 'commerce.stale_immutable');
    await fails(withMaintenance(db.admin, (trx) => trx.updateTable('rfq_invitation').set({ stale_reason: 'rfq_closed' }).where('id', '=', invitationId).execute()), 'commerce.stale_immutable');
    await fails(as(anna, (trx) => trx.updateTable('rfq_invitation').set({ rfq_version_id: rv2 }).where('id', '=', invitationId).execute()), '42501');
    assert.deepEqual((await as(boris, (trx) => rfqVersions.listFor(trx, rfqId))).map((v) => v.id), [rv1], 'v2 stays invisible until a revalidated invitation pins it');
    await fails(as(boris, (trx) => rfqInvitations.setStatus(trx, invitationId, 'viewed', { status: 'declined', withdrawn_reason: null })), 'commerce.rfq_version_not_current');
    const renewed = await as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv2, party_person_id: null, party_company_id: supplier, channel: 'platform', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: invitationId }));
    assert.equal(renewed.stale_reason, null);
    assert.deepEqual((await as(boris, (trx) => rfqVersions.listFor(trx, rfqId))).map((v) => v.version), [1, 2]);
    await fails(as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv2, party_person_id: pure, party_company_id: null, channel: 'platform', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: renewed.id })), 'commerce.invalid_transition');
  });

  await t.test('concurrency: an invitation racing an amendment is either refused or flagged; never a current-looking pin to an old version', async () => {
    const draft3 = await as(anna, async (trx) => {
      await rfqs.lock(trx, rfqId);
      return rfqVersions.insertDraft(trx, { rfq_id: rfqId, version: 3, payload: rfqPayload('120'), drafted_by_person_id: anna, amendment_reason: 'Quantity changed to 120' });
    });
    // T1 inserts an invitation pinned to v2 and holds its transaction open; T2 publishes v3 meanwhile.
    let releaseInvite: () => void = () => undefined;
    const held = new Promise<void>((r) => { releaseInvite = r; });
    const inviting = as(anna, async (trx) => {
      const row = await rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv2, party_person_id: carl, party_company_id: null, channel: 'platform', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null });
      await held;
      return row;
    });
    await sleep(150);
    const publishing = publishAs(anna, rfqId, draft3.id, '120', 'Quantity changed to 120', rv2);
    await sleep(150);
    releaseInvite();
    const [invited, current] = await Promise.all([inviting, publishing]);
    assert.equal(current.current_version_id, draft3.id);
    const raced = await as(anna, (trx) => rfqInvitations.get(trx, invited.id));
    assert.equal(raced?.stale_reason, 'rfq_amended', 'the publication waited for the invitation and then flagged it');
    // The other order: the publication commits first, then an invitation to the superseded version is refused.
    await fails(as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: rv2, party_person_id: xenia, party_company_id: null, channel: 'platform', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null })), 'commerce.rfq_version_not_current');
    const all = await as(anna, (trx) => rfqInvitations.listForRfq(trx, rfqId));
    assert.ok(all.every((i) => i.rfq_version_id === draft3.id || i.stale_reason !== null), 'invariant: pinned to the current version or flagged');
  });

  await t.test('concurrency: two publications of one draft and two invitations of one party, one wins each', async () => {
    const draft4 = await as(anna, async (trx) => {
      await rfqs.lock(trx, rfqId);
      return rfqVersions.insertDraft(trx, { rfq_id: rfqId, version: 4, payload: rfqPayload('130'), drafted_by_person_id: anna, amendment_reason: 'Quantity changed to 130' });
    });
    const current = (await as(anna, (trx) => rfqs.get(trx, rfqId)))?.current_version_id as string;
    const results = await Promise.allSettled([publishAs(anna, rfqId, draft4.id, '130', 'Quantity changed to 130', current), publishAs(anna, rfqId, draft4.id, '130', 'Quantity changed to 130', current)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one publication commits');
    assert.equal((await as(anna, (trx) => rfqVersions.listFor(trx, rfqId))).filter((v) => v.status === 'published').length, 1, 'one published version');
    const invites = await Promise.allSettled([0, 1, 2].map(() => as(anna, (trx) => rfqInvitations.insert(trx, { rfq_id: rfqId, rfq_version_id: draft4.id, party_person_id: petr, party_company_id: null, channel: 'platform', sent_by_person_id: anna, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null }))));
    assert.equal(invites.filter((r) => r.status === 'fulfilled').length, 1, 'one invitation per party and version');
    const rejected = invites.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as PgError).code, '23505');
  });

  await t.test('closing flags the rest rfq_closed; a closed RFQ takes no version or invitation; the public projection only when enabled', async () => {
    assert.equal(await as(boris, (trx) => rfqs.setProjection(trx, rfqId, 1, { enabled: true, fields: ['title'], category: null })), undefined, 'an invitee cannot publish the projection');
    const before = await as(anna, (trx) => rfqs.get(trx, rfqId));
    const projected = await as(anna, (trx) => rfqs.setProjection(trx, rfqId, before!.revision, { enabled: true, fields: ['title', 'region'], category: 'landscaping' }));
    const pub = await db.app.query('SELECT * FROM trustwork.rfq_public_read($1::uuid)', [rfqId]);
    assert.equal(pub.rows.length, 1, 'anonymous callers read an enabled projection');
    assert.deepEqual(pub.rows[0].public_projection_fields, ['title', 'region']);
    await as(anna, (trx) => rfqs.close(trx, rfqId, projected!.revision, { status: 'closed', personId: anna, reason: 'Awarded offline', at: new Date() }));
    const all = await as(anna, (trx) => rfqInvitations.listForRfq(trx, rfqId));
    assert.ok(all.every((i) => i.stale_reason !== null), 'every invitation is flagged');
    assert.ok(all.some((i) => i.stale_reason === 'rfq_closed'));
    await fails(as(anna, (trx) => rfqVersions.insertDraft(trx, { rfq_id: rfqId, version: 5, payload: rfqPayload('1'), drafted_by_person_id: anna, amendment_reason: 'late' })), 'commerce.invalid_transition');
    await fails(as(anna, (trx) => trx.updateTable('rfq').set({ status: 'published' }).where('id', '=', rfqId).execute()), 'commerce.version_frozen');
    assert.equal((await db.app.query('SELECT * FROM trustwork.rfq_public_read($1::uuid)', [rfqId])).rows.length, 0, 'a closed RFQ is no longer public');
    await fails(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.rfq WHERE id = ${rfqId}`.execute(trx)), 'commerce.retained');
  });

  await t.test('a company member without company.deals.manage sees nothing; a former member sees nothing', async () => {
    await withMaintenance(db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.members.manage'] }).where('id', '=', seed.memberships.boris).execute());
    assert.equal(await as(boris, (trx) => rfqs.get(trx, rfqId)), undefined, 'the supplier company acts only through members holding company.deals.manage');
    assert.deepEqual(await as(boris, (trx) => rfqInvitations.listForRfq(trx, rfqId)), []);
    assert.equal(await as(xenia, (trx) => rfqs.get(trx, rfqId)), undefined);
  });
});
