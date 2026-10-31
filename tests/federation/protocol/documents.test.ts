import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FeedPageSchema,
  FederationTombstoneSchema,
  ForwardedReportSchema,
  InboxDeliverySchema,
  InboxReceiptSchema,
  MeshLinkDecisionSchema,
  MeshLinkProposalSchema,
  PeeringRecordSchema,
  TakedownNoticeSchema,
  defaultDataLicences,
  kindsOfStream,
  peeringLevelAtLeast,
  requiredPeeringLevel,
  signDocument,
} from '../../../packages/contracts/src/federation.js';
import { CITY, NATIONAL, NODE_SIGNERS, NOW, THIRD, TEST_ADDRESSES, computeDigest, dealEnvelope, envelope, gid, tombstone } from './fixtures.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown) => {
  const r = schema.safeParse(value);
  assert.ok(r.success, JSON.stringify(r.error?.issues));
};
const bad = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown, pattern: RegExp) => {
  const r = schema.safeParse(value);
  assert.equal(r.success, false, `expected rejection matching ${pattern}`);
  const found = r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  assert.ok(found.some((m) => pattern.test(m)), `expected ${pattern} in ${JSON.stringify(found)}`);
};
const signed = (purpose: Parameters<typeof signDocument>[0], doc: Record<string, unknown>, node = NATIONAL) => signDocument(purpose, doc, NODE_SIGNERS[node]!.keyId, NODE_SIGNERS[node]!.sign);

const page = (items: unknown[], overrides: Record<string, unknown> = {}) => ({ protocol: 'trustwork-mesh/1', node: NATIONAL, stream: 'publications', after: null, items, next: 'c2', generatedAt: NOW, ...overrides });

test('feed pages carry only the serving node\'s own public envelopes of the stream and tombstones', () => {
  ok(FeedPageSchema, page([{ type: 'envelope', envelope: envelope() }, { type: 'tombstone', tombstone: tombstone() }]));
  bad(FeedPageSchema, page([{ type: 'envelope', envelope: envelope({ homeNode: CITY, id: gid(CITY, 'publication', 'p') }) }]), /feed serves only objects homed on its node/);
  bad(FeedPageSchema, page([{ type: 'envelope', envelope: envelope({ kind: 'event', id: gid(NATIONAL, 'event', 'e1'), dataClass: 'events', syndication: 'redisplay_with_attribution' }) }]), /not a publications kind/);
  bad(FeedPageSchema, page([{ type: 'envelope', envelope: dealEnvelope() }], { node: CITY }), /feeds carry only public envelopes/);
  bad(FeedPageSchema, page([{ type: 'envelope', envelope: envelope({ projection: 'owner_private' }) }]), /never leave their node/);
  bad(FeedPageSchema, page([{ type: 'tombstone', tombstone: tombstone({ id: gid(NATIONAL, 'tombstone', 'ts-q'), target: gid(NATIONAL, 'quote_version', 'q'), targetKind: 'quote_version' }) }], { stream: 'tombstones' }), /tombstones of deal objects go to the parties' inboxes/);
  ok(FeedPageSchema, page([{ type: 'tombstone', tombstone: tombstone() }], { stream: 'tombstones' }));
  bad(FeedPageSchema, page([], { after: '192.0.2.44' }), /after/);
  bad(FeedPageSchema, page(Array.from({ length: 201 }, () => ({ type: 'tombstone', tombstone: tombstone() }))), /items/);
  assert.deepEqual(kindsOfStream('directory'), ['company_profile', 'person_profile', 'catalogue_item']);
  assert.deepEqual(kindsOfStream('tombstones'), []);
});

const delivery = (item: unknown, overrides: Record<string, unknown> = {}) => ({ protocol: 'trustwork-mesh/1', deliveryId: 'dlv-1', senderNode: CITY, recipientNode: NATIONAL, sentAt: NOW, item, ...overrides });

test('inbox deliveries: shared_party envelopes only, only to a party\'s home node, never in transit', () => {
  ok(InboxDeliverySchema, delivery({ type: 'envelope', envelope: dealEnvelope() }));
  bad(InboxDeliverySchema, delivery({ type: 'envelope', envelope: dealEnvelope() }, { recipientNode: THIRD }), /delivered only to a home node of a party/);
  bad(InboxDeliverySchema, delivery({ type: 'envelope', envelope: dealEnvelope() }, { senderNode: THIRD }), /no transit/);
  bad(InboxDeliverySchema, delivery({ type: 'envelope', envelope: envelope() }, { senderNode: NATIONAL, recipientNode: CITY }), /public objects are pulled from feeds, not pushed/);
  bad(InboxDeliverySchema, delivery({ type: 'envelope', envelope: dealEnvelope({ projection: 'party_private' }) }), /never leave their node/);
  bad(InboxDeliverySchema, delivery({ type: 'envelope', envelope: dealEnvelope() }, { recipientNode: CITY }), /does not deliver to itself/);
  bad(InboxDeliverySchema, delivery({ type: 'envelope', envelope: dealEnvelope() }, { recipientNode: '192.0.2.44' }), /recipientNode/);
  bad(InboxDeliverySchema, { ...delivery({ type: 'envelope', envelope: dealEnvelope() }), via: THIRD }, /via|Unrecognized/i);
  ok(InboxDeliverySchema, delivery({ type: 'tombstone', tombstone: tombstone() }, { senderNode: NATIONAL, recipientNode: CITY }));
});

test('inbox receipts: a code exactly when rejected', () => {
  ok(InboxReceiptSchema, { protocol: 'trustwork-mesh/1', deliveryId: 'dlv-1', state: 'accepted', code: null, receivedAt: NOW });
  ok(InboxReceiptSchema, { protocol: 'trustwork-mesh/1', deliveryId: 'dlv-1', state: 'rejected', code: 'federation.delivery_conflict', receivedAt: NOW });
  bad(InboxReceiptSchema, { protocol: 'trustwork-mesh/1', deliveryId: 'dlv-1', state: 'rejected', code: null, receivedAt: NOW }, /code exactly when rejected/);
});

test('tombstones: metadata only, from the home node, applied within 72 hours, purging every derived copy', () => {
  ok(FederationTombstoneSchema, tombstone());
  bad(FederationTombstoneSchema, tombstone({ applyBy: '2026-11-05T08:00:01.000Z' }), /within 72 hours/);
  bad(FederationTombstoneSchema, tombstone({ applyBy: NOW }), /within 72 hours/);
  bad(FederationTombstoneSchema, tombstone({ target: gid(CITY, 'publication', 'p') }), /only the home node tombstones its objects/);
  bad(FederationTombstoneSchema, tombstone({ targetKind: 'event' }), /target identifier names the target kind/);
  bad(FederationTombstoneSchema, tombstone({ purge: ['replica'] }), /purge/);
  bad(FederationTombstoneSchema, { ...tombstone(), payload: { title: 'kept' } }, /payload|Unrecognized/i);
});

test('takedown notices and forwarded reports name categories and clauses, never people', () => {
  const notice = signed('takedown_notice', { protocol: 'trustwork-mesh/1', id: gid(NATIONAL, 'takedown_notice', 'td-1'), target: gid(NATIONAL, 'publication', 'pub-7b0c'), homeNode: NATIONAL, reason: 'licence_ended', legalBasis: null, issuedAt: NOW });
  ok(TakedownNoticeSchema, notice);
  bad(TakedownNoticeSchema, { ...notice, requestedBy: 'person-1' }, /requestedBy|Unrecognized/i);
  const report = signed('moderation_report', { protocol: 'trustwork-mesh/1', id: gid(CITY, 'moderation_report', 'r-1'), target: gid(NATIONAL, 'publication', 'pub-7b0c'), fromNode: CITY, clauseCode: 'misinformation.safety', issuedAt: NOW }, CITY);
  ok(ForwardedReportSchema, report);
  bad(ForwardedReportSchema, { ...report, reporterPersonId: 'p-1' }, /reporterPersonId|Unrecognized/i);
  bad(ForwardedReportSchema, { ...report, target: gid(CITY, 'publication', 'x') }, /forwarded to the target's home node/);
  ok(InboxDeliverySchema, delivery({ type: 'moderation_report', report }));
  bad(InboxDeliverySchema, delivery({ type: 'moderation_report', report: { ...report, target: gid(THIRD, 'publication', 'x') } }), /report goes to the target's home node/);
});

test('entity links: never merges; people only by their own confirmation, companies by identifier or signed statement', () => {
  const base = { protocol: 'trustwork-mesh/1', id: gid(CITY, 'link_proposal', 'lp-1'), fromNode: CITY, local: gid(CITY, 'company', 'co-austin-glazing'), remote: gid(NATIONAL, 'company', 'co-glazing-national'), proposedAt: NOW };
  const company = signed('link_proposal', { ...base, evidence: { kind: 'identifier_match', country: 'US', identifierKind: 'us_ein', value: '00-0000000' } }, CITY);
  ok(MeshLinkProposalSchema, company);
  ok(MeshLinkProposalSchema, { ...company, evidence: { kind: 'admin_signed_statement', statementDigest: computeDigest({ statement: 'same company' }) } });
  bad(MeshLinkProposalSchema, { ...company, evidence: { kind: 'person_confirmed', confirmedLocalAt: NOW, confirmedRemoteAt: NOW } }, /company is linked by an identifier match or a signed statement/);
  const person = { ...company, local: gid(CITY, 'person', 'p-a'), remote: gid(NATIONAL, 'person', 'p-b') };
  bad(MeshLinkProposalSchema, person, /person is linked only by their own confirmation/);
  bad(MeshLinkProposalSchema, { ...person, evidence: { kind: 'email_match', email: 'synthetic@example.org' } }, /evidence/);
  ok(MeshLinkProposalSchema, { ...person, evidence: { kind: 'person_confirmed', confirmedLocalAt: NOW, confirmedRemoteAt: NOW } });
  bad(MeshLinkProposalSchema, { ...company, remote: gid(CITY, 'company', 'other') }, /records on two nodes/);
  bad(MeshLinkProposalSchema, { ...company, remote: gid(NATIONAL, 'person', 'p') }, /same kind/);
  bad(MeshLinkProposalSchema, { ...company, merge: true }, /merge|Unrecognized/i);
  ok(InboxDeliverySchema, delivery({ type: 'link_proposal', proposal: company }));
  bad(InboxDeliverySchema, delivery({ type: 'link_proposal', proposal: company }, { recipientNode: THIRD }), /link proposal goes to the remote record's node/);
  const decision = signed('link_decision', { protocol: 'trustwork-mesh/1', proposal: company.id, fromNode: NATIONAL, decision: 'accepted', decidedAt: NOW });
  ok(MeshLinkDecisionSchema, decision);
  bad(MeshLinkDecisionSchema, { ...decision, decision: 'merged' }, /decision/);
  bad(MeshLinkDecisionSchema, { ...decision, decidedBy: 'steward-1' }, /decidedBy|Unrecognized/i);
});

const peering = (overrides: Record<string, unknown> = {}) => ({
  id: 'peer-1', localNode: NATIONAL, localHubId: 'us', peerNode: CITY, peerHubId: 'us-tx-austin', level: 'syndicate', state: 'active', licences: defaultDataLicences(), tombstoneHours: 72,
  agentEnvelopesPerHour: 60, peerManifestDigest: computeDigest({ m: 1 }), peerKeyId: 'a1', admission: { outcome: 'admitted', decidedAt: NOW, judged: ['declared', 'attested', 'observed'] },
  requestedBy: 'staff-1', secondApproverId: null, startedAt: NOW, endedAt: null, revision: 1, ...overrides,
});

test('peering records: second approver above syndicate, distinct people, admitted on all three kinds of evidence, no address', () => {
  ok(PeeringRecordSchema, peering());
  bad(PeeringRecordSchema, peering({ level: 'deal_routing' }), /deal_routing and identity need a second approver/);
  bad(PeeringRecordSchema, peering({ level: 'identity' }), /second approver/);
  ok(PeeringRecordSchema, peering({ level: 'deal_routing', state: 'pending_approval' }));
  ok(PeeringRecordSchema, peering({ level: 'deal_routing', secondApproverId: 'staff-2' }));
  bad(PeeringRecordSchema, peering({ level: 'deal_routing', secondApproverId: 'staff-1' }), /second approver is another person/);
  bad(PeeringRecordSchema, peering({ admission: { outcome: 'refused', decidedAt: NOW, judged: ['declared', 'attested', 'observed'] } }), /admission/);
  bad(PeeringRecordSchema, peering({ admission: { outcome: 'admitted', decidedAt: NOW, judged: ['declared'] } }), /admission/);
  bad(PeeringRecordSchema, peering({ state: 'ended' }), /endedAt is set exactly when ended/);
  bad(PeeringRecordSchema, peering({ tombstoneHours: 96 }), /tombstoneHours/);
  for (const address of TEST_ADDRESSES) bad(PeeringRecordSchema, peering({ peerAddress: address }), /peerAddress|Unrecognized/i);
  bad(PeeringRecordSchema, peering({ peerNode: '203.0.113.10' }), /peerNode/);
});

test('peering levels are ordered and deal objects need deal_routing', () => {
  assert.ok(peeringLevelAtLeast('identity', 'deal_routing'));
  assert.ok(!peeringLevelAtLeast('syndicate', 'trust_verifications'));
  assert.equal(requiredPeeringLevel({ type: 'feed' }), 'syndicate');
  assert.equal(requiredPeeringLevel({ type: 'badge' }), 'trust_verifications');
  assert.equal(requiredPeeringLevel({ type: 'sign_in' }), 'identity');
  assert.equal(requiredPeeringLevel({ type: 'envelope', envelope: dealEnvelope() as never }), 'deal_routing');
  assert.equal(requiredPeeringLevel({ type: 'tombstone', tombstone: tombstone() as never }), 'syndicate');
});
