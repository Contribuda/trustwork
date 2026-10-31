#!/usr/bin/env node
// Kernel reference-data sync (DATA-003): node packages/data/bin/kernel-sync.mjs [--dry-run]
// Loads the restricted-places list and the country packs (@trustwork/country-packs), the unit catalogue
// (@trustwork/contracts) and the plan-step taxonomy (data/taxonomy) into the kernel tables, as the maintenance identity.
// Connection: DATABASE_URL or TRUSTWORK_DATABASE_* of the migrator (never the API role). Idempotent; exit 0 ok, 1 failure.
import { register } from 'tsx/esm/api';
register();
const { kernelReference, kernelSync } = await import('../src/repositories/kernel.ts');
const { createPool, withMaintenance } = await import('../src/pool.ts');
const { databaseConfigFromEnv } = await import('../src/config.ts');

const data = await kernelReference.fromRepository();
const summary = `restricted=${data.restricted.length} units=${data.units.length} rules=${data.conversionRules.length} jurisdictions=${data.jurisdictions.length} terms=${data.taxonomy.terms.length} relations=${data.taxonomy.relations.length}`;
if (process.argv.includes('--dry-run')) {
  console.log(`kernel-sync (dry run): ${summary}`);
} else {
  const pool = createPool(databaseConfigFromEnv(process.env, 'trustwork-kernel-sync'));
  try {
    const report = await withMaintenance(pool, (trx) => kernelSync.apply(trx, data));
    console.log(`kernel-sync: ${JSON.stringify(report)}`);
  } catch (error) {
    console.error(`kernel-sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
