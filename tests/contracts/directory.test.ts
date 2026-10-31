import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as c from '../../packages/contracts/src/index.js';
import * as d from '../../packages/contracts/src/directory.js';

const load = (name: string) => JSON.parse(readFileSync(new URL(`../../packages/contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const absent = (value: unknown, keys: readonly string[]) => {
  const json = JSON.stringify(value);
  for (const key of keys) assert.ok(!json.includes(`"${key}"`), `${key} must be absent`);
};
const PRIVATE_PROJECT_FIELDS = ['budgets', 'privateFiles', 'privateNotes', 'participantIds', 'baselinePlanId', 'milestones', 'sharedFiles', 'creatorPersonId', 'revision'];

test('handles: lower-case ASCII groups, 3-40 characters, never numeric, UUID-shaped or reserved; input is normalised', () => {
  assert.equal(d.HandleSchema.parse('  Acme-Builders '), 'acme-builders');
  assert.equal(d.HandleSchema.parse('studio-42'), 'studio-42');
  assert.equal(d.HandleSchema.parse('a'.repeat(40)), 'a'.repeat(40));
  const reasons: Record<string, d.HandleProblem> = {
    ab: 'length', [`${'a'.repeat(41)}`]: 'length', 'a--b': 'charset', '-abc': 'charset', 'abc-': 'charset', acme_b: 'charset', 'acme.b': 'charset',
    'stroy-реп': 'charset', '12345': 'numeric', '0190f3a2-1b2c-7d3e-8f40-123456789abc': 'uuid_shaped', admin: 'reserved', 'by-handle': 'reserved', trustwork: 'reserved',
  };
  for (const [value, reason] of Object.entries(reasons)) {
    const result = d.HandleSchema.safeParse(value);
    assert.equal(result.success, false, value);
    assert.equal(d.handleProblem(value.trim().toLowerCase()), reason, value);
  }
  for (const word of d.RESERVED_HANDLES) assert.equal(d.HandleSchema.safeParse(word.toUpperCase()).success, false, `${word} reserved in any case`);
  assert.equal(new Set(d.RESERVED_HANDLES).size, d.RESERVED_HANDLES.length, 'no duplicate reserved words');
});

test('commands are strict: company creation takes name, handle and description only (no status, claim or verification)', () => {
  assert.equal(d.CreateCompanyCommandSchema.safeParse({ name: 'Fixture Builders', handle: 'fixture-builders', publicDescription: null }).success, true);
  assert.equal(d.CreateCompanyCommandSchema.safeParse({ name: 'Fixture Builders', handle: null, publicDescription: 'Roofs' }).success, true);
  for (const extra of [{ claimStatus: 'verified' }, { status: 'claimed' }, { verifiedDomains: ['example.invalid'] }, { origin: 'sourced' }, { ownerPersonId: 'p' }]) {
    const result = d.CreateCompanyCommandSchema.safeParse({ name: 'Fixture Builders', handle: null, publicDescription: null, ...extra });
    assert.equal(result.success, false, JSON.stringify(extra));
  }
  assert.equal(d.CreateCompanyCommandSchema.safeParse({ name: 'Fixture Builders', handle: 'admin', publicDescription: null }).success, false);
  assert.equal(d.SetHandleCommandSchema.safeParse({ handle: 'new-name', subjectId: 'x' }).success, false);
});

test('directory projections are allowlists: private fields never pass, private subjects are not listed', () => {
  const person = c.PersonSchema.parse(load('pure-participant').records.Person[0]);
  const entry = d.toPersonDirectoryEntry({ ...person, profileVisibility: 'public' }, 'pure-participant')!;
  absent(entry, ['emailBindings', 'providerIdentities', 'preferences', 'revision', 'email', 'createdAt']);
  assert.equal(entry.handle, 'pure-participant');
  assert.equal(d.toPersonDirectoryEntry({ ...person, profileVisibility: 'private' }, 'pure-participant'), null, 'a private profile is never a directory entry');

  const company = c.CompanySchema.parse(load('mixed-company').records.Company[0]);
  const wide = { ...company, handle: 'mixed', origin: 'registered' as const, claimStatus: 'claimed' as const };
  const companyEntry = d.toCompanyDirectoryEntry(wide);
  absent(companyEntry, ['membershipRequests', 'billingAccountId', 'internalNotes', 'verifiedDomains', 'revision', 'createdAt']);
  assert.deepEqual(Object.keys(companyEntry).sort(), ['claimStatus', 'handle', 'id', 'legalIdentifiers', 'name', 'origin', 'publicDescription']);
  assert.equal(d.CompanyDirectoryEntrySchema.safeParse({ ...companyEntry, internalNotes: 'x' }).success, false, 'strict schema rejects a leaked field');

  const project = c.ProjectSchema.parse(load('personal-project').records.Project[0]);
  assert.equal(d.toProjectDirectoryEntry(project, 'house'), null, 'an unpublished project is never a directory entry');
  const published = { ...project, publicity: { ...project.publicity, enabled: true, publishedStory: 'Story' } };
  const projectEntry = d.toProjectDirectoryEntry(published, 'house')!;
  absent(projectEntry, [...PRIVATE_PROJECT_FIELDS, 'owner', 'leaderPersonId']);
  assert.equal(projectEntry.handle, 'house');

  const mine = d.toMyProject(project, 'owner', null);
  absent(mine, PRIVATE_PROJECT_FIELDS);
  assert.equal(mine.published, false);
  assert.equal(d.MyProjectSchema.safeParse({ ...mine, privateNotes: 'x' }).success, false);
  assert.equal(d.MyProjectSchema.safeParse({ ...mine, budgets: [] }).success, false);
});

test('cursors: opaque base64url of (sort key with microseconds, UUID); foreign or malformed cursors are rejected', () => {
  const position = { createdAt: '2026-10-31T10:00:00.123456Z', id: '0190f3a2-1b2c-7d3e-8f40-123456789abc' };
  const cursor = d.encodeDirectoryCursor(position);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(d.decodeDirectoryCursor(cursor), position);
  assert.equal(d.decodeDirectoryCursor('not-a-cursor'), null);
  assert.equal(d.decodeDirectoryCursor(c.encodeCursor({ sortKey: 'Acme', id: position.id })), null, 'name sort keys are not directory cursors');
  assert.equal(d.decodeDirectoryCursor(c.encodeCursor({ sortKey: '2026-10-31T10:00:00.123Z', id: position.id })), null, 'millisecond keys would skip rows');
  assert.equal(d.decodeDirectoryCursor(c.encodeCursor({ sortKey: position.createdAt, id: 'project-fixture' })), null);
  assert.deepEqual(d.DirectoryPageQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(d.DirectoryPageQuerySchema.parse({ limit: '5', cursor }), { limit: 5, cursor });
  for (const bad of [{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { limit: '5', sort: 'name' }, { cursor: 'a b' }]) assert.equal(d.DirectoryPageQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
  const page = d.CompanyDirectoryPageSchema.parse({ items: [], nextCursor: null });
  assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor'], 'pages carry no totals');
});

test('lookups and resolutions carry the current handle and a redirect flag', () => {
  assert.equal(d.HandleResolutionSchema.safeParse({ kind: 'company', id: 'c1', handle: 'new-name', requested: 'old-name', redirect: true }).success, true);
  assert.equal(d.HandleResolutionSchema.safeParse({ kind: 'workspace', id: 'c1', handle: 'new-name', requested: 'old-name', redirect: true }).success, false);
  assert.equal(d.CompanyLookupSchema.safeParse({ item: { id: 'c1', handle: 'acme', name: 'Acme', origin: 'registered', claimStatus: 'unclaimed', legalIdentifiers: [], publicDescription: null }, redirect: false }).success, true);
});
