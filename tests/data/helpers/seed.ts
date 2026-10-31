import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { withMaintenance, type DataPool, type Principal, type Transaction } from '@trustwork/data';

/**
 * Seeds the synthetic contract fixtures (packages/contracts/fixtures) into a migrated database through the
 * maintenance identity, mapping the readable fixture ids to database-generated UUIDs. Only data needed by
 * the identity/access slice is loaded; commercial records are referenced as opaque resource ids.
 */
interface FixtureFile { records: Record<string, Record<string, unknown>[]> }
function fixture(name: string): FixtureFile {
  return JSON.parse(readFileSync(resolve(`packages/contracts/fixtures/${name}.json`), 'utf8')) as FixtureFile;
}

/**
 * A public profile needs the person's live profile_public consent (PPL-001; the directory follow-up applies it to every
 * public person listing and lookup). Synthetic fixtures made public through maintenance record that consent here.
 */
export async function consentPublicProfiles(trx: Transaction, personIds: readonly string[]): Promise<void> {
  if (personIds.length === 0) return;
  await sql`INSERT INTO trustwork.consent_record (subject_person_id, purpose, notice_version, evidence)
    SELECT id, 'profile_public', 'profile_public.v1', jsonb_build_object('method', 'first_party_form', 'requestId', 'fixture-seed')
    FROM unnest(${[...personIds]}::uuid[]) AS id`.execute(trx);
}

export interface Seed {
  ids: Record<string, string>;
  /** Fixture identifiers of the people seeded, for readability in tests. */
  people: { petr: string; anna: string; pure: string; boris: string; carl: string; xenia: string };
  companies: { mixed: string; supplier: string; unrelated: string };
  memberships: { anna: string; boris: string; carl: string; xenia: string };
  project: string;
  participations: { ownerOnPersonalProject: string; supplierOnPersonalProject: string; rfqOwner: string; quoteSeller: string };
  sessionTokenHashHex: string;
}

export async function seedFixtures(admin: DataPool): Promise<Seed> {
  const personal = fixture('personal-project');
  const mixed = fixture('mixed-company');
  const pure = fixture('pure-participant');
  const ids: Record<string, string> = {};
  await withMaintenance(admin, async (trx) => {
    const person = async (fixtureId: string, displayName: string, visibility: 'private' | 'public' = 'private') => {
      const row = await trx.insertInto('person').values({ display_name: displayName, profile_visibility: visibility }).returning('id').executeTakeFirstOrThrow();
      ids[fixtureId] = row.id;
      if (visibility === 'public') await consentPublicProfiles(trx, [row.id]);
      return row.id;
    };
    const company = async (fixtureId: string, displayName: string, claim: 'unclaimed' | 'claimed' | 'verified', legal: unknown[] = []) => {
      const row = await trx.insertInto('company').values({ display_name: displayName, claim_status: claim, legal_identifiers: JSON.stringify(legal) }).returning('id').executeTakeFirstOrThrow();
      ids[fixtureId] = row.id;
      return row.id;
    };
    const purePerson = pure.records.Person?.[0] as { id: string; displayName: string; profileVisibility: 'private' | 'public'; emailBindings: { email: string; verifiedAt: string | null; isPrimary: boolean }[] };
    const mixedCompany = mixed.records.Company?.[0] as { id: string; name: string; status: 'sourced' | 'claimed' | 'verified'; legalIdentifiers: unknown[] };
    const annaMembership = mixed.records.Membership?.[0] as { id: string; personId: string; companyId: string; role: 'member' | 'administrator'; permissions: string[]; validFrom: string };
    const project = personal.records.Project?.[0] as { id: string; owner: { id: string }; creatorPersonId: string; leaderPersonId: string; name: string; summary: string | null; status: 'planned' | 'active' | 'suspended' | 'completed' | 'cancelled'; privateNotes: string | null };
    const session = pure.records.Session?.[0] as { tokenHash: string; idleExpiresAt: string; absoluteExpiresAt: string; authMethod: 'password' };

    await person('person-petr', 'Fixture Petr');
    await person(annaMembership.personId, 'Fixture Anna');
    await person(purePerson.id, purePerson.displayName, purePerson.profileVisibility);
    await person('person-boris', 'Fixture Boris');
    await person('person-carl', 'Fixture Carl');
    await person('person-xenia', 'Fixture Xenia');

    await company(mixedCompany.id, mixedCompany.name, mixedCompany.status === 'sourced' ? 'unclaimed' : mixedCompany.status, mixedCompany.legalIdentifiers);
    await trx.insertInto('company_private').values({ company_id: ids[mixedCompany.id] as string, internal_notes: (mixedCompany as { internalNotes?: string | null }).internalNotes ?? 'owner_private', billing_account_id: null }).execute();
    await company('company-supplier-1', 'Fixture Supplier LLC', 'claimed');
    await company('company-unrelated', 'Fixture Unrelated LLC', 'unclaimed');

    for (const binding of purePerson.emailBindings) {
      await trx.insertInto('email_binding').values({ person_id: ids[purePerson.id] as string, email_normalized: binding.email.toLowerCase(), is_primary: binding.isPrimary, verified_at: binding.verifiedAt }).execute();
    }
    await trx.insertInto('credential').values({ person_id: ids[purePerson.id] as string, kind: 'password', password_hash: '$argon2id$v=19$m=65536,t=3,p=4$Zml4dHVyZS1zYWx0$Zml4dHVyZS1oYXNo' }).execute();
    await trx.insertInto('session').values({
      person_id: ids[purePerson.id] as string, token_hash: Buffer.from(session.tokenHash, 'hex'), idle_expires_at: session.idleExpiresAt, absolute_expires_at: session.absoluteExpiresAt, auth_method: session.authMethod,
    }).execute();

    const membership = async (fixtureId: string, personId: string, companyId: string, role: 'member' | 'administrator', permissions: string[], ended = false) => {
      const row = await trx.insertInto('membership').values({
        person_id: personId, company_id: companyId, role, permissions, status: ended ? 'ended' : 'active', valid_from: new Date('2026-10-01T09:00:00Z'),
        ...(ended ? { ended_at: new Date('2026-10-20T09:00:00Z'), ended_by: personId, ended_reason: 'fixture: left the company' } : {}),
      }).returning('id').executeTakeFirstOrThrow();
      ids[fixtureId] = row.id;
    };
    await membership(annaMembership.id, ids[annaMembership.personId] as string, ids[annaMembership.companyId] as string, annaMembership.role, annaMembership.permissions);
    await membership('membership-boris', ids['person-boris'] as string, ids['company-supplier-1'] as string, 'member', ['company.deals.manage', 'company.members.manage']);
    await membership('membership-carl', ids['person-carl'] as string, ids['company-unrelated'] as string, 'administrator', ['company.members.manage']);
    await membership('membership-xenia', ids['person-xenia'] as string, ids[mixedCompany.id] as string, 'member', [], true);

    const projectRow = await trx.insertInto('project').values({
      owner_person_id: ids[project.owner.id] as string, creator_person_id: ids[project.creatorPersonId] as string, leader_person_id: ids[project.leaderPersonId] as string,
      name: project.name, summary: project.summary, status: project.status, private_notes: project.privateNotes,
    }).returning('id').executeTakeFirstOrThrow();
    ids[project.id] = projectRow.id;

    const participation = async (record: Record<string, unknown>) => {
      const r = record as { id: string; resource: { kind: 'project' | 'rfq' | 'quote'; id: string }; party: { kind: 'person' | 'company'; id: string }; side: 'owner' | 'participant' | 'seller'; capabilities: string[]; audience: 'shared_party' | 'party_private' | 'owner_private'; validFrom: string; validUntil: string | null; grantedBy: { personId: string } };
      ids[r.resource.id] ??= (await sql<{ id: string }>`SELECT trustwork.new_uuid() AS id`.execute(trx)).rows[0]?.id as string;
      const row = await trx.insertInto('object_participation').values({
        resource_kind: r.resource.kind, resource_id: ids[r.resource.id] as string,
        party_person_id: r.party.kind === 'person' ? (ids[r.party.id] as string) : null,
        party_company_id: r.party.kind === 'company' ? (ids[r.party.id] as string) : null,
        side: r.side, capabilities: r.capabilities, audience: r.audience, valid_from: r.validFrom, valid_until: r.validUntil,
        granted_by_person_id: ids[r.grantedBy.personId] as string,
      }).returning('id').executeTakeFirstOrThrow();
      ids[r.id] = row.id;
    };
    // Derived owner row (materialised by the application per the access policy); the fixture lists only the supplier.
    await participation({ id: 'participation-owner-petr', resource: { kind: 'project', id: project.id }, party: { kind: 'person', id: project.owner.id }, side: 'owner',
      capabilities: ['read.shared', 'read.owner_private', 'write.draft', 'publish', 'invite', 'manage_participants', 'transfer_ownership', 'export'], audience: 'owner_private', validFrom: '2026-10-01T09:00:00Z', validUntil: null, grantedBy: { personId: project.owner.id } });
    for (const record of personal.records.ObjectParticipation ?? []) await participation(record);
    for (const record of mixed.records.ObjectParticipation ?? []) await participation(record);
  });
  const sessionRecord = pure.records.Session?.[0] as { tokenHash: string };
  const id = (key: string) => ids[key] as string;
  return {
    ids,
    people: { petr: id('person-petr'), anna: id('person-anna'), pure: id('person-pure-1'), boris: id('person-boris'), carl: id('person-carl'), xenia: id('person-xenia') },
    companies: { mixed: id('company-mixed-1'), supplier: id('company-supplier-1'), unrelated: id('company-unrelated') },
    memberships: { anna: id('membership-anna'), boris: id('membership-boris'), carl: id('membership-carl'), xenia: id('membership-xenia') },
    project: id('project-personal-1'),
    participations: { ownerOnPersonalProject: id('participation-owner-petr'), supplierOnPersonalProject: id('participation-supplier'), rfqOwner: id('participation-rfq-owner'), quoteSeller: id('participation-quote-seller') },
    sessionTokenHashHex: sessionRecord.tokenHash,
  };
}

/** Reads the current authorization epoch (as the owner) so tests build a fresh principal. */
export async function principalFor(admin: DataPool, personId: string): Promise<Principal> {
  const row = await withMaintenance(admin, (trx) => trx.selectFrom('person').select('authz_epoch').where('id', '=', personId).executeTakeFirst());
  if (!row) throw new Error(`unknown person ${personId}`);
  return { personId, authzEpoch: row.authz_epoch };
}
