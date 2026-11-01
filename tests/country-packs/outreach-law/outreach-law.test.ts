import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { packProblems, validatePack } from '../../../packages/country-packs/src/validate.js';
import { validateLayer } from '../../../packages/country-packs/src/layers.js';
import { outreachLawProblems, outreachPackRules, type OutreachLawFactView } from '../../../packages/country-packs/src/outreach-law.js';
import { resolveOutreach, OutreachPolicySchema } from '../../../packages/contracts/src/outreach-policy.js';

const root = new URL('../../../packages/country-packs/', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as { code: string; facets?: { outreachLaw?: OutreachLawFactView[] & { sources: { url: string }[] }[] } };
const PACKS = ['us', 'uz', 'ge', 'am', 'az'] as const;

test('every outreachLaw fact cites a source and shows counselReview; the packs and the EU layer validate', () => {
  for (const code of PACKS) {
    const raw = read(`packs/${code}.json`);
    const facts = raw.facets?.outreachLaw ?? [];
    assert.ok(facts.length > 0, `${code} records outreach-law facts`);
    assert.deepEqual(packProblems(raw).problems, [], `${code} validates`);
    validatePack(raw);
    for (const fact of facts as unknown as (OutreachLawFactView & { sources: { url: string }[] })[]) {
      assert.ok(fact.sources.length > 0 && fact.sources.every((s) => /^https:\/\//.test(s.url)), `${code}.${fact.id} cites https sources`);
      assert.equal(fact.counselReview, 'pending', `${code}.${fact.id} awaits counsel`);
      assert.notEqual(fact.verification, 'official', `${code}.${fact.id} stays below official before counsel review`);
    }
  }
  const eu = read('layers/eu.json');
  assert.ok((eu.facets?.outreachLaw ?? []).length >= 3);
  assert.doesNotThrow(() => validateLayer(eu as never));
});

test('the validator refuses an official outreach-law fact without counsel review and malformed basis facts', () => {
  const base: OutreachLawFactView = { id: 'x', topic: 'basis', verification: 'official', counselReview: 'pending', recipientClasses: ['business_role'], channels: ['email'], basis: 'opt_out' };
  assert.match(outreachLawProblems(base, 'XX').join('\n'), /counsel review/);
  assert.deepEqual(outreachLawProblems({ ...base, counselReview: 'done' }, 'XX'), []);
  const withoutBasis: OutreachLawFactView = { id: 'x', topic: 'basis', verification: 'secondary', counselReview: 'pending', recipientClasses: ['business_role'], channels: ['email'] };
  assert.match(outreachLawProblems(withoutBasis, 'XX').join('\n'), /names its recipient classes, channels and basis/);
  assert.match(outreachLawProblems({ id: 'y', topic: 'notice', verification: 'secondary', counselReview: 'pending', channels: ['email'] }, 'XX').join('\n'), /only basis facts/);
});

test('pack facts feed the resolver: US e-mail is opt-out, Uzbekistan has no recorded basis so nobody is contacted', () => {
  const facts = (code: string) => (read(`packs/${code}.json`).facets?.outreachLaw ?? []) as unknown as OutreachLawFactView[];
  const us = outreachPackRules('US', facts('us'));
  assert.ok(us.some((r) => r.recipientClass === 'organisation_generic' && r.channel === 'email' && r.basis === 'opt_out'));
  assert.ok(us.filter((r) => r.channel === 'phone_automated').every((r) => r.basis === 'prior_express_written_consent'));
  assert.deepEqual(outreachPackRules('UZ', facts('uz')), [], 'no direct-marketing basis is recorded for Uzbekistan yet');
  const policy = OutreachPolicySchema.parse({
    mode: 'notice_only', packs: ['us@1', 'uz@1'], counselApproval: { reference: 'SYNTHETIC', jurisdictions: ['US', 'UZ'], approvedAt: '2026-11-01T00:00:00Z' },
    secondPersonApprovalId: '00000000-0000-4000-8000-000000000001',
    jurisdictions: ['US', 'UZ'].map((scope) => ({
      scope, recipientClasses: { organisation_generic: { email: { basis: 'opt_out' } } },
      notice: { required: true, timing: 'at_first_communication', maxDays: 30 },
      identification: ['operator_legal_name', 'postal_address', 'hub_name', 'automated_assistant_disclosure', 'data_source_named'],
      optOut: { oneClick: true, replyStop: true, honourWithinHours: 24 },
      volume: { perHubPerDay: 50, perRecipientDomainPerWeek: 1, touchesPerRecipientPerPurpose: 1, minDaysBetweenTouches: 30 },
      quietHours: { timeZone: 'recipient', allowed: 'Mon-Fri 09:00-17:00', holidays: 'pack_calendar' },
    })),
  });
  const ask = (recipientJurisdiction: string) => resolveOutreach({
    recipientClass: 'organisation_generic', channel: 'email', recipientJurisdiction, hubJurisdiction: 'US', policy,
    packRules: [...us, ...outreachPackRules('UZ', facts('uz'))], sourceAllowsOutreach: true, suppressed: false, recordedConsent: false,
  });
  assert.equal(ask('US-NY').contact, true);
  assert.deepEqual(ask('UZ'), { contact: false, reason: 'no_rule' });
});

test('no engine code for outreach branches on a country code', () => {
  for (const path of ['../../../packages/contracts/src/outreach-policy.ts', '../../../packages/country-packs/src/outreach-law.ts']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(source, /['"`](?:US|EU|UZ|GE|AM|AZ|GB|DE|CA)(?:-[A-Z0-9]{1,3})?['"`]/, `${path} names no country`);
  }
});
