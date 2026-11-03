#!/usr/bin/env node
// Privacy country-policy sync (PRV-001): node packages/data/bin/privacy-policy-sync.mjs [--dry-run]
// Derives each country's request deadline and retention bound from its country pack's privacy facts
// (@trustwork/country-packs) and writes them to trustwork.privacy_country_policy as the maintenance identity.
// A country without official, sourced facts stays UNKNOWN (null deadline, null retention); nothing is invented here.
// Connection: DATABASE_URL or TRUSTWORK_DATABASE_* of the migrator (never the API role). Idempotent; exit 0 ok, 1 failure.
import { register } from 'tsx/esm/api';
register();
const { privacyPolicies } = await import('../src/repositories/privacy.ts');
const { createPool, withMaintenance } = await import('../src/pool.ts');
const { databaseConfigFromEnv } = await import('../src/config.ts');

const derivations = await privacyPolicies.fromRepository();
const lines = derivations.map((d) => `${d.country} ${d.review} deadlineDays=${d.deadlineDays ?? 'null'} retentionDays=${d.retentionDays ?? 'null'}`
  + `${d.reasons.length ? ` reasons=${d.reasons.join(',')}` : ''} version=${d.version}`);
if (process.argv.includes('--dry-run')) {
  console.log(`privacy-policy-sync (dry run):\n${lines.join('\n')}`);
} else {
  const pool = createPool(databaseConfigFromEnv(process.env, 'trustwork-privacy-policy-sync'));
  try {
    const report = await withMaintenance(pool, (trx) => privacyPolicies.apply(trx, derivations));
    console.log(`privacy-policy-sync: ${JSON.stringify(report)}`);
  } catch (error) {
    console.error(`privacy-policy-sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
