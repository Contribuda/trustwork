import { hash } from '@node-rs/argon2';
import { createPool, databaseConfigFromEnv, withMaintenance } from '../deps/data.js';
import { consentRecords } from '../modules/profiles/deps.js';

/**
 * Local development seed (synthetic personas from the contract fixtures; never real users). Runs with the
 * migrator/superuser `DATABASE_URL`, creates the runtime login role for the API when missing and prints the
 * `API_DATABASE_URL` to use with `npm run dev:api`. Idempotent: an already seeded database is left unchanged.
 *
 *   DATABASE_URL=postgresql://trustwork_dev:local_only_change_me@localhost:54329/trustwork_dev npm run seed:dev -w @trustwork/api
 */
const PERSONAS = [
  { key: 'petr', name: 'Пётр (фикстура)', email: 'petr@example.invalid', password: 'fixture-password-petr-0001', visibility: 'private' as const },
  { key: 'anna', name: 'Анна (фикстура)', email: 'anna@example.invalid', password: 'fixture-password-anna-0001', visibility: 'private' as const },
  { key: 'boris', name: 'Борис (фикстура)', email: 'boris@example.invalid', password: 'fixture-password-boris-001', visibility: 'private' as const },
  { key: 'carl', name: 'Карл (фикстура)', email: 'carl@example.invalid', password: 'fixture-password-carl-0001', visibility: 'private' as const },
  { key: 'pure', name: 'Участник без компании (фикстура)', email: 'pure@example.invalid', password: 'fixture-password-pure-0001', visibility: 'public' as const },
];
const COMPANIES = [
  { key: 'mixed', name: 'Fixture Facades LLC', claim: 'claimed' as const, description: 'Buys steel, sells facade installation.' },
  { key: 'supplier', name: 'Fixture Supplier LLC', claim: 'claimed' as const, description: null },
  { key: 'unrelated', name: 'Fixture Unrelated LLC', claim: 'unclaimed' as const, description: null },
];
const MEMBERSHIPS: { person: string; company: string; role: 'member' | 'administrator'; permissions: string[] }[] = [
  { person: 'anna', company: 'mixed', role: 'administrator', permissions: ['company.page.edit', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit'] },
  { person: 'boris', company: 'supplier', role: 'member', permissions: ['company.deals.manage', 'company.members.manage'] },
  { person: 'carl', company: 'unrelated', role: 'administrator', permissions: ['company.members.manage', 'company.deals.manage'] },
];
const OWNER_CAPABILITIES = ['read.shared', 'read.party_private', 'read.owner_private', 'write.draft', 'publish', 'invite', 'negotiate', 'accept', 'commit_order', 'manage_participants', 'transfer_ownership', 'lead', 'export'];

async function main(): Promise<void> {
  const env = process.env;
  const pool = createPool(databaseConfigFromEnv(env, 'trustwork-seed'));
  const loginRole = env.API_DATABASE_ROLE ?? 'trustwork_api_login';
  const loginPassword = env.API_DATABASE_PASSWORD ?? 'local_only_api_password';
  try {
    const exists = (await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [loginRole])).rowCount;
    if (!exists) {
      const { rows } = await pool.query<{ ddl: string }>("SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT IN ROLE trustwork_app', $1::text, $2::text) AS ddl", [loginRole, loginPassword]);
      await pool.query(rows[0]!.ddl);
    }
    const ids: Record<string, string> = {};
    const seeded = await withMaintenance(pool, async (trx) => {
      const existing = await trx.selectFrom('email_binding').select('person_id').where('email_normalized', '=', PERSONAS[0]!.email).executeTakeFirst();
      if (existing) return false;
      for (const p of PERSONAS) {
        const person = await trx.insertInto('person').values({ display_name: p.name, profile_visibility: p.visibility, public_headline: p.visibility === 'public' ? 'Читатель и автор без работодателя' : null, public_expertise: p.visibility === 'public' ? ['facades'] : [] }).returning('id').executeTakeFirstOrThrow();
        ids[p.key] = person.id;
        await trx.insertInto('email_binding').values({ person_id: person.id, email_normalized: p.email, is_primary: true, verified_at: new Date() }).execute();
        await trx.insertInto('credential').values({ person_id: person.id, kind: 'password', password_hash: await hash(p.password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) }).execute();
        // PPL-001: a public profile exists only with the person's profile_public consent (synthetic persona).
        if (p.visibility === 'public') {
          await consentRecords.insert(trx, { subject_person_id: person.id, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: 'profile_public.v1', evidence: { method: 'first_party_form', requestId: 'dev-seed' } });
        }
      }
      for (const c of COMPANIES) {
        const company = await trx.insertInto('company').values({ display_name: c.name, claim_status: c.claim, public_description: c.description, legal_identifiers: JSON.stringify([]) }).returning('id').executeTakeFirstOrThrow();
        ids[c.key] = company.id;
        await trx.insertInto('company_private').values({ company_id: company.id, internal_notes: 'owner_private (synthetic)', billing_account_id: null }).execute();
      }
      for (const m of MEMBERSHIPS) {
        await trx.insertInto('membership').values({ person_id: ids[m.person] as string, company_id: ids[m.company] as string, role: m.role, permissions: m.permissions, status: 'active', valid_from: new Date(Date.now() - 60_000) }).execute();
      }
      const project = await trx.insertInto('project').values({ owner_person_id: ids.petr as string, creator_person_id: ids.petr as string, leader_person_id: ids.petr as string, name: 'Fixture summer house', summary: 'Private personal build.', status: 'active', private_notes: 'owner only' }).returning('id').executeTakeFirstOrThrow();
      ids.project = project.id;
      await trx.insertInto('object_participation').values({ resource_kind: 'project', resource_id: project.id, party_person_id: ids.petr as string, side: 'owner', capabilities: OWNER_CAPABILITIES, audience: 'owner_private', granted_by_person_id: ids.petr as string }).execute();
      await trx.insertInto('object_participation').values({ resource_kind: 'project', resource_id: project.id, party_company_id: ids.supplier as string, side: 'participant', capabilities: ['read.shared', 'negotiate'], audience: 'shared_party', granted_by_person_id: ids.petr as string }).execute();
      return true;
    });
    const url = new URL(env.DATABASE_URL ?? '');
    url.username = loginRole;
    url.password = loginPassword;
    console.log(JSON.stringify({ seeded, loginRole, personas: PERSONAS.map((p) => ({ key: p.key, email: p.email, password: p.password })), ids, apiDatabaseUrl: url.toString() }, null, 2));
  } finally {
    await pool.end();
  }
}

await main();
