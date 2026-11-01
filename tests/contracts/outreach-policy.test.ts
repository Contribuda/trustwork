import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_OUTREACH_POLICY, OUTREACH_BASES, OUTREACH_CHANNELS, OutreachPolicySchema, RECIPIENT_CLASSES, floorViolations, moreProtective, resolveOutreach,
  type OutreachJurisdictionPolicy, type OutreachPackRule, type OutreachPolicy, type OutreachRequest,
} from '../../packages/contracts/src/outreach-policy.js';

const jurisdiction = (scope: string, overrides: Partial<OutreachJurisdictionPolicy> = {}): OutreachJurisdictionPolicy => ({
  scope,
  recipientClasses: {
    organisation_generic: { email: { basis: 'opt_out', honourOptOutWithinDays: 10 }, postal: { basis: 'opt_out' }, phone_automated: { basis: 'prohibited' } },
    business_role: { email: { basis: 'opt_out' } },
    consumer: { email: { basis: 'prohibited' } },
  },
  notice: { required: true, timing: 'at_first_communication', maxDays: 30 },
  identification: ['operator_legal_name', 'postal_address', 'hub_name', 'automated_assistant_disclosure', 'data_source_named'],
  optOut: { oneClick: true, replyStop: true, honourWithinHours: 24 },
  volume: { perHubPerDay: 200, perRecipientDomainPerWeek: 1, touchesPerRecipientPerPurpose: 2, minDaysBetweenTouches: 14 },
  quietHours: { timeZone: 'recipient', allowed: 'Mon-Fri 09:00-17:00', holidays: 'pack_calendar' },
  openTracking: false,
  ...overrides,
});

const governed = (jurisdictions: OutreachJurisdictionPolicy[]): OutreachPolicy => OutreachPolicySchema.parse({
  mode: 'notice_only', packs: ['us@2026-11-01', 'eu@2026-11-01'],
  counselApproval: { reference: 'COUNSEL-SYNTHETIC-1', jurisdictions: jurisdictions.map((j) => j.scope), approvedAt: '2026-11-01T00:00:00Z' },
  secondPersonApprovalId: '00000000-0000-4000-8000-000000000001', jurisdictions,
});

const rule = (scope: string, recipientClass: OutreachPackRule['recipientClass'], channel: OutreachPackRule['channel'], basis: OutreachPackRule['basis']): OutreachPackRule => ({ scope, recipientClass, channel, basis, factIds: [`${scope.toLowerCase()}-${channel}`] });

const request = (overrides: Partial<OutreachRequest>): OutreachRequest => ({
  recipientClass: 'organisation_generic', channel: 'email', recipientJurisdiction: 'US-CA', hubJurisdiction: 'US',
  policy: governed([jurisdiction('US')]), packRules: [rule('US', 'organisation_generic', 'email', 'opt_out')],
  sourceAllowsOutreach: true, suppressed: false, recordedConsent: false, ...overrides,
});

test('a hub with no outreach configuration resolves every recipient to no contact', () => {
  for (const policy of [null, DEFAULT_OUTREACH_POLICY]) for (const recipientClass of RECIPIENT_CLASSES) for (const channel of OUTREACH_CHANNELS) {
    const decision = resolveOutreach(request({ policy, recipientClass, channel, recordedConsent: true }));
    assert.deepEqual(decision, { contact: false, reason: 'strict_mode' }, `${recipientClass}/${channel}`);
  }
  assert.equal(OutreachPolicySchema.safeParse({ ...DEFAULT_OUTREACH_POLICY, jurisdictions: [jurisdiction('US')] }).success, false, 'strict carries no rules');
});

test('no configuration can enable consumer outreach or automated calls, AI voice, SMS or messenger without prior consent', () => {
  const refused: [string, OutreachJurisdictionPolicy][] = [
    ['consumer e-mail', jurisdiction('US', { recipientClasses: { consumer: { email: { basis: 'opt_out' } } } })],
    ['automated calls on opt-out', jurisdiction('US', { recipientClasses: { business_role: { phone_automated: { basis: 'opt_out' } } } })],
    ['SMS on legitimate interest', jurisdiction('US', { recipientClasses: { business_role: { sms_messenger: { basis: 'legitimate_interest_assessed', assessmentRef: 'LIA-1' } } } })],
    ['contact forms', jurisdiction('US', { recipientClasses: { organisation_generic: { contact_form: { basis: 'opt_out' } } } })],
    ['social messages', jurisdiction('US', { recipientClasses: { organisation_generic: { social_message: { basis: 'prior_consent' } } } })],
    ['missing identification', jurisdiction('US', { identification: ['operator_legal_name', 'postal_address'] })],
    ['four touches', jurisdiction('US', { volume: { perHubPerDay: 10, perRecipientDomainPerWeek: 1, touchesPerRecipientPerPurpose: 4, minDaysBetweenTouches: 14 } })],
    ['open tracking', jurisdiction('US', { openTracking: true })],
    ['no one-click unsubscribe', jurisdiction('US', { optOut: { oneClick: false, replyStop: true, honourWithinHours: 24 } })],
    ['legitimate interest without assessment', jurisdiction('US', { recipientClasses: { business_named_contact: { email: { basis: 'legitimate_interest_assessed' } } } })],
  ];
  for (const [name, j] of refused) {
    assert.ok(floorViolations(j).length > 0, name);
    assert.throws(() => governed([j]), /./, name);
  }
  // Automated channels with recorded consent are expressible, and still need the consent at send time.
  const consented = jurisdiction('US', { recipientClasses: { business_role: { sms_messenger: { basis: 'prior_express_written_consent' } } } });
  const policy = governed([consented]);
  const sms = (recordedConsent: boolean) => resolveOutreach(request({ policy, recipientClass: 'business_role', channel: 'sms_messenger', recordedConsent, packRules: [rule('US', 'business_role', 'sms_messenger', 'prior_express_written_consent')] }));
  assert.deepEqual(sms(false), { contact: false, reason: 'consent_missing' });
  assert.equal(sms(true).contact, true);
  // Every mode other than strict needs counsel and a second person.
  const base = { mode: 'governed', packs: ['us@1'], jurisdictions: [jurisdiction('US')] };
  assert.equal(OutreachPolicySchema.safeParse({ ...base, counselApproval: null, secondPersonApprovalId: '00000000-0000-4000-8000-000000000001' }).success, false);
  assert.equal(OutreachPolicySchema.safeParse({ ...base, counselApproval: { reference: 'C', jurisdictions: ['US'], approvedAt: '2026-11-01T00:00:00Z' }, secondPersonApprovalId: null }).success, false);
  assert.equal(OutreachPolicySchema.safeParse({ ...base, counselApproval: { reference: 'C', jurisdictions: ['CA'], approvedAt: '2026-11-01T00:00:00Z' }, secondPersonApprovalId: '00000000-0000-4000-8000-000000000001' }).success, false, 'a scope outside the counsel approval');
});

test('when two jurisdictions apply, the most protective rule wins', () => {
  assert.equal(moreProtective('opt_out', 'prior_consent'), 'prior_consent');
  assert.equal(moreProtective('prohibited', 'opt_out'), 'prohibited');
  assert.deepEqual([...OUTREACH_BASES].sort((a, b) => OUTREACH_BASES.indexOf(a) - OUTREACH_BASES.indexOf(b))[0], 'prohibited');
  // Worked example: a US hub e-mailing a sole proprietor in Germany. The US rule allows opt-out e-mail; the EU layer
  // applied to DE requires prior consent: consent is needed.
  const policy = governed([jurisdiction('US'), jurisdiction('DE', { recipientClasses: { sole_proprietor: { email: { basis: 'opt_out' } } } })]);
  const packRules = [rule('US', 'sole_proprietor', 'email', 'opt_out'), rule('DE', 'sole_proprietor', 'email', 'prior_consent')];
  const toDe = (recordedConsent: boolean) => resolveOutreach(request({ policy, packRules, recipientClass: 'sole_proprietor', recipientJurisdiction: 'DE', recordedConsent }));
  assert.deepEqual(toDe(false), { contact: false, reason: 'consent_missing' });
  const allowed = toDe(true);
  assert.ok(allowed.contact && allowed.basis === 'prior_consent');
  // The hub policy may be stricter than the packs, never weaker: a hub prohibition wins over a pack opt-out.
  const strictHub = governed([jurisdiction('US', { recipientClasses: { organisation_generic: { email: { basis: 'prohibited' } } } })]);
  assert.deepEqual(resolveOutreach(request({ policy: strictHub })), { contact: false, reason: 'prohibited' });
  // A pack prohibition in either jurisdiction wins over the hub's opt-out.
  assert.deepEqual(resolveOutreach(request({ packRules: [rule('US', 'organisation_generic', 'email', 'opt_out'), rule('US-CA', 'organisation_generic', 'email', 'prohibited')] })), { contact: false, reason: 'prohibited' });
  // Unknown recipient jurisdiction or class, or a jurisdiction the packs say nothing about: no contact.
  assert.deepEqual(resolveOutreach(request({ recipientJurisdiction: null })), { contact: false, reason: 'unknown_jurisdiction' });
  assert.deepEqual(resolveOutreach(request({ recipientClass: null })), { contact: false, reason: 'unknown_recipient_class' });
  assert.deepEqual(resolveOutreach(request({ recipientJurisdiction: 'BR', policy: governed([jurisdiction('US'), jurisdiction('BR')]) })), { contact: false, reason: 'no_rule' });
  // Suppression and the source's allowed uses close the door whatever the rules say.
  assert.deepEqual(resolveOutreach(request({ suppressed: true })), { contact: false, reason: 'suppressed' });
  assert.deepEqual(resolveOutreach(request({ sourceAllowsOutreach: false })), { contact: false, reason: 'source_disallows' });
  const ok = resolveOutreach(request({}));
  assert.ok(ok.contact && ok.basis === 'opt_out' && ok.packFacts.includes('us-email'));
});
