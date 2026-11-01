import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, type DataPool } from '@trustwork/data';

/**
 * Synthetic answers for the HUB-004 suites: the decided United States reference hub (ADR 012 decision 31: English
 * default with Spanish, USD, San Diego as home territory, demo data), operated by a synthetic Delaware LLC hosted in
 * the United States. Every name, address and identifier is synthetic and labelled so.
 */
export const ANSWERS = {
  install_check: () => ({ clientTime: new Date().toISOString() }),
  node_identity: { nodeName: 'Synthetic reference node', domain: 'build.example.org', jurisdiction: 'US' },
  hub_identity: {
    country: 'US', startingPoint: 'generic', slug: 'synthetic-us',
    territories: [{ level: 'country', code: 'US' }, { level: 'region', code: 'US-CA' }, { level: 'place', code: 'US-CA:san-diego' }],
    name: { en: 'Synthetic Trustwork United States', es: 'Trustwork Estados Unidos sintético' }, locales: ['en', 'es'], defaultLocale: 'en', currency: 'USD', timeZone: 'America/Los_Angeles',
  },
  operator: {
    legalName: 'Synthetic Builders Cooperative LLC', form: 'llc', identifier: '00-0000000', address: '1 Synthetic Way, Wilmington, DE (synthetic)',
    legalContact: 'legal@example.org (synthetic)', abuseContact: 'abuse@example.org (synthetic)', ownershipDeclared: true,
    entityCountry: 'US', entityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null, gateMode: 'upstream_gate',
  },
  storage_residency: { personalDataCountry: 'US', privacyRegime: 'us_state_privacy' },
  providers: {
    capabilities: { llm: 'later', email: 'fake', sms: 'fake', payments: 'fake', maps_geocoding: 'fake', register_lookup: 'manual', e_signature: 'fake', tax_calculation: 'later' },
    models: 'openrouter', directModelAdapter: null,
  },
  modes: { dataMode: 'demo' },
} as const;

/** A person with a verified primary address (maintenance path), for the data suite. */
export async function person(admin: DataPool, name: string, email: string): Promise<string> {
  return withMaintenance(admin, async (trx) => {
    const id = (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    await trx.insertInto('email_binding').values({ person_id: id, email_normalized: email, is_primary: true, verified_at: new Date() }).execute();
    return id;
  });
}

/** An active authenticator app and ten unused recovery codes, as BE-004 leaves them after confirmation (maintenance path). */
export async function enrolSecondFactor(admin: DataPool, personId: string, recoveryCodes = true): Promise<void> {
  await withMaintenance(admin, async (trx) => {
    await trx.insertInto('second_factor').values({ id: randomUUID(), person_id: personId, kind: 'totp', state: 'active', secret_sealed: randomBytes(64), activated_at: new Date() }).execute();
    if (recoveryCodes) {
      const batch = randomUUID();
      for (let i = 0; i < 10; i += 1) await trx.insertInto('recovery_code').values({ person_id: personId, batch_id: batch, code_hash: randomBytes(32) }).execute();
    }
  });
}
