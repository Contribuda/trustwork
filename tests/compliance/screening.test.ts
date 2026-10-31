import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnershipDeclarationSchema, RESTRICTED_PLACES, assessPartner, consolidatedScreeningList, evaluateDeclaration } from '../../packages/compliance/src/index.js';

const declaration = OwnershipDeclarationSchema.parse({
  companyId: 'company-fasad-primer',
  declaredBy: 'person-anna',
  declaredAt: '2026-10-29T12:00:00Z',
  organisedIn: 'UZ',
  operatesIn: ['UZ', 'UZ-TK'],
  listedOwnershipFiftyPercentOrMore: false,
  appearsOnList: false,
  confirmed: true,
});

test('restricted places are exactly the ADR-009 list and never pass the declaration', () => {
  assert.deepEqual([...RESTRICTED_PLACES], ['RU', 'CU', 'IR', 'KP', 'UA-43', 'UA-40', 'UA-14', 'UA-09']);
  assert.deepEqual(evaluateDeclaration(declaration), { ok: true });
  const russian = evaluateDeclaration({ ...declaration, organisedIn: 'RU' });
  assert.equal(russian.ok, false);
  const crimea = evaluateDeclaration({ ...declaration, operatesIn: ['UZ', 'UA-43'] });
  assert.equal(crimea.ok, false);
  const owned = evaluateDeclaration({ ...declaration, listedOwnershipFiftyPercentOrMore: true });
  assert.equal(owned.ok, false);
});

test('the declaration must be confirmed and well-formed', () => {
  assert.throws(() => OwnershipDeclarationSchema.parse({ ...declaration, confirmed: false }));
  assert.throws(() => OwnershipDeclarationSchema.parse({ ...declaration, operatesIn: [] }));
  assert.throws(() => OwnershipDeclarationSchema.parse({ ...declaration, extra: 1 }));
});

test('without a key the screening adapter refuses to run and makes no network call', async () => {
  let calls = 0;
  const adapter = consolidatedScreeningList({ apiKey: '', fetch: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ results: [] }) }; } });
  const result = await adapter.screen({ name: 'Fasad-Namuna' });
  assert.deepEqual(result, { status: 'not_run', reason: 'missing_key' });
  assert.equal(calls, 0);
  const state = await assessPartner(declaration, { name: 'Fasad-Namuna' }, adapter);
  assert.equal(state.requiresReview, true, 'not_run never counts as clear');
});

test('with a key the adapter queries the list, reports matches and keeps errors in review', async () => {
  const seen: string[] = [];
  const adapter = consolidatedScreeningList({
    apiKey: 'k',
    now: () => new Date('2026-10-29T12:00:00Z'),
    fetch: async (url, init) => {
      seen.push(url);
      assert.equal(init?.headers?.['subscription-key'], 'k');
      return { ok: true, status: 200, json: async () => ({ results: [{ source: 'SDN', name: 'Some Listed Entity', score: 92, programs: ['UKRAINE-EO13662'], id: 'abc' }] }) };
    },
  });
  const result = await adapter.screen({ name: 'Some Listed Entity', country: 'RU' });
  assert.equal(result.status, 'screened');
  assert.ok(seen[0]?.includes('name=Some+Listed+Entity'));
  assert.ok(seen[0]?.includes('countries=RU'));
  if (result.status === 'screened') {
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.programs[0], 'UKRAINE-EO13662');
  }
  const state = await assessPartner(declaration, { name: 'Some Listed Entity' }, adapter);
  assert.equal(state.requiresReview, true);

  const clean = consolidatedScreeningList({ apiKey: 'k', fetch: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }) });
  const cleanState = await assessPartner(declaration, { name: 'Fasad-Namuna' }, clean);
  assert.equal(cleanState.requiresReview, false, 'a real empty result with a clean declaration needs no review');

  const failing = consolidatedScreeningList({ apiKey: 'k', fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  const failed = await failing.screen({ name: 'Anyone' });
  assert.equal(failed.status, 'error');
});
