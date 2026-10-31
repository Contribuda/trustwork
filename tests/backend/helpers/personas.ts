import { hash } from '@node-rs/argon2';
import { withMaintenance } from '@trustwork/data';
import { seedFixtures, type Seed } from '../../data/helpers/seed.js';
import type { Client, Harness } from './app.js';

/** Synthetic local-only passwords for the contract fixture personas (never real users). */
export const PASSWORDS = {
  petr: 'fixture-password-petr-0001',
  anna: 'fixture-password-anna-0001',
  pure: 'fixture-password-pure-0001',
  boris: 'fixture-password-boris-001',
  carl: 'fixture-password-carl-0001',
  xenia: 'fixture-password-xenia-001',
} as const;
export type PersonaKey = keyof typeof PASSWORDS;
export const EMAILS: Record<PersonaKey, string> = {
  petr: 'petr@example.invalid', anna: 'anna@example.invalid', pure: 'pure@example.invalid', boris: 'boris@example.invalid', carl: 'carl@example.invalid', xenia: 'xenia@example.invalid',
};

/** Seeds the DATA-001 fixtures plus verified e-mail bindings and password credentials so personas can log in. */
export async function seedPersonas(h: Harness): Promise<Seed> {
  const seed = await seedFixtures(h.db.admin);
  await withMaintenance(h.db.admin, async (trx) => {
    for (const key of Object.keys(PASSWORDS) as PersonaKey[]) {
      const personId = seed.people[key];
      const passwordHash = await hash(PASSWORDS[key], { memoryCost: 19456, timeCost: 2, parallelism: 1 });
      if (key === 'pure') {
        await trx.updateTable('credential').set({ password_hash: passwordHash }).where('person_id', '=', personId).where('kind', '=', 'password').execute();
        continue;
      }
      await trx.insertInto('email_binding').values({ person_id: personId, email_normalized: EMAILS[key], is_primary: true, verified_at: new Date('2026-10-01T09:00:00Z') }).execute();
      await trx.insertInto('credential').values({ person_id: personId, kind: 'password', password_hash: passwordHash }).execute();
    }
  });
  return seed;
}

export async function login(client: Client, key: PersonaKey): Promise<void> {
  const response = await client.post('/v1/auth/login', { email: EMAILS[key], password: PASSWORDS[key] }, { idempotencyKey: null });
  if (response.status !== 200) throw new Error(`login as ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
}
