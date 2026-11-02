import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXPIRY_REMINDER_DAYS, LEI_IDENTIFIER_KIND, REGISTER_ADAPTERS, SOURCED_FACT_KINDS, SourcedFactValueSchemas, SourcedObservationSchema, expiryReminderDue, factDisplay,
  findRegisterAdapter, isStale, normaliseIdentifier, toPublicSourcedFact, wordingProblems, type SourcedFact,
} from '../../packages/contracts/src/sourced-facts.js';
import { ALL_USES, MOST_RESTRICTIVE_USES } from '../../packages/contracts/src/sources.js';
import { fakeObservations } from '../../apps/api/src/modules/registers/fakes.js';

/** REG-001: the sourced-fact contract (value shapes, display, stale, wording, expiry steps) and the adapters catalogue. */

const fact = (over: Partial<SourcedFact> = {}): SourcedFact => ({
  id: '00000000-0000-4000-8000-000000000001', hubId: '00000000-0000-4000-8000-000000000002', adapter: 'us_ca_cslb_licence_file',
  sourceId: '00000000-0000-4000-8000-000000000003', method: 'structured_feed', kind: 'licence_status',
  subject: { identifierKind: 'US-CA-CSLB', identifierValue: '1000123', holderKind: 'organisation' },
  value: { status: 'active', classifications: ['B'], issuedOn: null }, recordRef: '1000123', link: 'https://synthetic-register.invalid/x/1000123',
  licenceSnapshot: { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true }, observedAt: '2026-11-01T10:00:00.000Z', validUntil: '2027-03-31', ...over,
});

test('value shapes are strict: no room for a person\'s name, address, phone or e-mail', () => {
  assert.deepEqual(Object.keys(SourcedFactValueSchemas).sort(), [...SOURCED_FACT_KINDS].sort());
  assert.ok(SourcedFactValueSchemas.licence_status.safeParse({ status: 'active', classifications: ['C-10'], issuedOn: '2020-01-01' }).success);
  assert.ok(!SourcedFactValueSchemas.licence_status.safeParse({ status: 'active', classifications: ['B'], issuedOn: null, qualifier: 'Synthetic Person' }).success);
  assert.ok(!SourcedFactValueSchemas.licence_status.safeParse({ status: 'active', classifications: ['call 555 0100'], issuedOn: null }).success);
  assert.ok(!SourcedFactValueSchemas.entity_status.safeParse({ status: 'active', entityType: 'llc', email: 'person@synthetic.invalid' }).success);
  assert.ok(!SourcedFactValueSchemas.safety_inspection.safeParse({ inspectionRef: 'SYN-1', openedOn: '2026-01-01', inspectionType: 'planned', status: 'closed', citations: 1, address: 'x' }).success);
});

test('an observation carries an identifier kind and value together, or neither', () => {
  const base = fakeObservations('us_ca_cslb_licence_file', [{ identifierValue: '1000123' }], new Date('2026-11-01T10:00:00Z'))[0];
  assert.ok(base);
  assert.ok(!SourcedObservationSchema.safeParse({ ...base, subject: { identifierKind: 'US-CA-CSLB', identifierValue: null, holderKind: 'organisation' } }).success);
  assert.ok(!SourcedObservationSchema.safeParse({ ...base, link: 'http://synthetic-register.invalid/plain' }).success, 'links are https');
});

test('display: organisations only, licence must allow display, stale from the day after valid_until', () => {
  const now = new Date('2027-03-31T23:00:00Z');
  assert.deepEqual(factDisplay(fact(), now), { shown: true, stale: false });
  assert.deepEqual(factDisplay(fact(), new Date('2027-04-01T00:30:00Z')), { shown: true, stale: true });
  assert.deepEqual(factDisplay(fact({ subject: { identifierKind: 'US-CA-CSLB', identifierValue: '1000123', holderKind: 'natural_person' } }), now), { shown: false, reason: 'natural_person' });
  assert.deepEqual(factDisplay(fact({ subject: { identifierKind: 'US-CA-CSLB', identifierValue: '1000123', holderKind: 'unknown' } }), now), { shown: false, reason: 'natural_person' });
  assert.deepEqual(factDisplay(fact({ licenceSnapshot: { ...MOST_RESTRICTIVE_USES } }), now), { shown: false, reason: 'licence' });
  assert.equal(isStale(null, now), false);
  const shown = toPublicSourcedFact(fact({ licenceSnapshot: { ...ALL_USES } }), now);
  assert.ok(shown);
  assert.deepEqual(Object.keys(shown).sort(), ['identifierKind', 'kind', 'link', 'observedAt', 'sourceId', 'stale', 'validUntil', 'value']);
  assert.equal(toPublicSourcedFact(fact({ licenceSnapshot: { ...MOST_RESTRICTIVE_USES } }), now), null);
});

test('wording never claims the hub certified, licensed, verified or approved anyone', () => {
  assert.deepEqual(wordingProblems('Licence status as shown by the state board on {date}'), []);
  for (const bad of ['Certified contractor', 'Licensed by Trustwork', 'Verified by the hub', 'Approved by our team', 'We guarantee this licence', 'Endorsed builder', 'Accredited by the hub']) {
    assert.ok(wordingProblems(bad).length > 0, bad);
  }
});

test('expiry reminders: 60, 30 and 7 days before, never after expiry', () => {
  assert.deepEqual([...EXPIRY_REMINDER_DAYS], [60, 30, 7]);
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
  assert.equal(expiryReminderDue('2027-03-31', at('2027-01-01')), null);
  assert.equal(expiryReminderDue('2027-03-31', at('2027-01-30')), 60);
  assert.equal(expiryReminderDue('2027-03-31', at('2027-03-01')), 30);
  assert.equal(expiryReminderDue('2027-03-31', at('2027-03-24')), 7);
  assert.equal(expiryReminderDue('2027-03-31', at('2027-03-31')), 7);
  assert.equal(expiryReminderDue('2027-03-31', at('2027-04-01')), null);
  assert.equal(expiryReminderDue(null, at('2027-03-01')), null);
});

test('identifiers compare without case, spaces, dots, slashes or dashes', () => {
  assert.equal(normaliseIdentifier('1 000-123'), '1000123');
  assert.equal(normaliseIdentifier('5299syn.thetic/42'), '5299SYNTHETIC42');
});

test('the catalogue names pack registers and identifier kinds that exist; every adapter runs as a fake without credentials', () => {
  const us = JSON.parse(readFileSync(new URL('../../packages/country-packs/packs/us.json', import.meta.url), 'utf8')) as { facets?: Record<string, unknown>; regions?: Array<{ facets?: Record<string, unknown> }> };
  const facets = [us.facets ?? {}, ...(us.regions ?? []).map((r) => r.facets ?? {})];
  const ids = (facet: string) => facets.flatMap((f) => ((f[facet] as Array<{ id: string; kind?: string; covers?: string[] }> | undefined) ?? []));
  const registers = ids('registers');
  const identifierKinds = new Set(ids('identifiers').map((i) => i.kind));
  for (const adapter of REGISTER_ADAPTERS) {
    assert.equal(findRegisterAdapter(adapter.id), adapter);
    assert.equal(adapter.withoutCredentials, 'fake');
    assert.ok(adapter.refreshDays >= 1 && adapter.refreshDays <= 30);
    if (adapter.packRegister !== null) {
      const register = registers.find((r) => r.id === adapter.packRegister);
      assert.ok(register, `${adapter.id}: pack register ${adapter.packRegister}`);
      assert.ok(register.covers?.includes(adapter.identifierKind as string), `${adapter.id}: the register covers ${adapter.identifierKind}`);
    }
    if (adapter.identifierKind !== null && adapter.identifierKind !== LEI_IDENTIFIER_KIND) assert.ok(identifierKinds.has(adapter.identifierKind), adapter.identifierKind);
  }
  assert.equal(findRegisterAdapter('scraped_reviews'), null);
});

test('fake adapters are deterministic, schema-valid and link only to the reserved .invalid domain', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  for (const adapter of REGISTER_ADAPTERS) {
    const subjects = adapter.identifierKind === null ? [{ identifierValue: null, recordRef: 'SYN-OSHA-1' }, { identifierValue: null, recordRef: 'SYN-OSHA-2' }]
      : [{ identifierValue: 'SYN0001' }, { identifierValue: 'SYN0002' }, { identifierValue: 'syn-0001' }];
    const a = fakeObservations(adapter.id, subjects, now);
    const b = fakeObservations(adapter.id, subjects, now);
    assert.deepEqual(a, b);
    for (const o of a) {
      assert.ok(adapter.kinds.includes(o.kind));
      assert.ok(new URL(o.link).hostname.endsWith('.invalid'));
      assert.equal(o.subject.identifierKind, adapter.identifierKind);
    }
  }
  const [x, , z] = fakeObservations('gleif_lei', [{ identifierValue: 'SYN0001' }, { identifierValue: 'SYN0002' }, { identifierValue: 'syn-0001' }], now);
  assert.deepEqual(x?.value, z?.value, 'the same identifier, however written, gives the same answer');
  assert.throws(() => fakeObservations('scraped_reviews', [{ identifierValue: 'SYN0001' }], now));
});
