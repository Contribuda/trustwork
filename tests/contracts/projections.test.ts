import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as c from '../../packages/contracts/src/index.js';

const load = (name: string) => JSON.parse(readFileSync(new URL(`../../packages/contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const absent = (value: unknown, keys: readonly string[]) => {
  const json = JSON.stringify(value);
  for (const key of keys) assert.ok(!json.includes(`"${key}"`), `${key} must be absent`);
};

test('public project projection exposes no budgets, private files, notes, participants or baseline', () => {
  const project = c.ProjectSchema.parse(load('personal-project').records.Project[0]);
  assert.equal(c.toPublicProject(project), null, 'private project is not found');
  const published = { ...project, publicity: { ...project.publicity, enabled: true, publishedStory: 'Story' } };
  const pub = c.toPublicProject(published)!;
  absent(pub, ['budgets', 'privateFiles', 'privateNotes', 'participantIds', 'baselinePlanId', 'milestones', 'sharedFiles', 'owner', 'creatorPersonId', 'leaderPersonId']);
  assert.equal(pub.publishedStory, 'Story');
  const participant = c.toParticipantProject(project);
  absent(participant, ['budgets', 'budget', 'privateFiles', 'privateNotes', 'participantIds', 'baselinePlanId', 'creatorPersonId']);
  assert.equal(c.ParticipantProjectSchema.safeParse({ ...participant, milestones: [{ ...participant.milestones[0]!, budget: null }] }).success, false, 'milestone budgets are not representable in the participant view');
  assert.deepEqual(
    participant.milestones.map((m) => m.id),
    ['milestone-foundation'],
    'only shared milestones',
  );
  assert.ok(c.PublicProjectSchema.safeParse({ ...pub, budgets: [] }).success === false, 'strict schema rejects a leaked field');
});
test('public company projection exposes no membership requests, billing, notes or domains', () => {
  const company = c.CompanySchema.parse(load('mixed-company').records.Company[0]);
  const pub = c.toPublicCompany(company);
  absent(pub, ['membershipRequests', 'billingAccountId', 'internalNotes', 'verifiedDomains', 'revision']);
  assert.equal(pub.status, 'claimed');
});
test('public person projection requires consent and exposes no bindings, providers or preferences', () => {
  const person = c.PersonSchema.parse(load('pure-participant').records.Person[0]);
  const pub = c.toPublicPerson(person)!;
  absent(pub, ['emailBindings', 'providerIdentities', 'preferences', 'revision', 'email']);
  assert.equal(c.toPublicPerson({ ...person, profileVisibility: 'private' }), null);
  const session = c.SessionSchema.parse(load('pure-participant').records.Session[0]);
  absent(c.toSessionView(session), ['tokenHash', 'personId']);
});
test('public offering projection follows the allowlist and never leaks private knowledge', () => {
  const version = c.OfferingVersionSchema.parse(load('mixed-company').records.OfferingVersion[0]);
  const pub = c.toPublicOfferingVersion(version)!;
  absent(pub, ['privateKnowledge', 'costBasis', 'marginTarget', 'notes', 'listPrice', 'components']);
  assert.deepEqual(Object.keys(pub.fields).sort(), ['availability', 'description', 'title', 'unit']);
  assert.equal(c.toPublicOfferingVersion({ ...version, status: 'draft' }), null);
});
test('projection layer ordering treats staff_case as a sibling subset, not a superset', () => {
  assert.ok(c.layerAtMost('public', 'owner_private'));
  assert.ok(c.layerAtMost('shared_party', 'party_private'));
  assert.equal(c.layerAtMost('party_private', 'shared_party'), false);
  assert.equal(c.layerAtMost('party_private', 'staff_case'), false);
  assert.equal(c.layerAtMost('staff_case', 'owner_private'), false);
  assert.ok(c.layerAtMost('staff_case', 'staff_case'));
  assert.deepEqual(c.pickFields({ a: 1, b: 2 }, ['a']), { a: 1 });
  assert.equal(c.ProjectionLayerSchema.safeParse('shared').success, false);
});
