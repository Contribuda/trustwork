/** Explicit maintenance command: node --import tsx apps/worker/src/screening-lists/sync-sources.ts [--dry-run].
 * Uses the existing deployment pack loader and migrator connection, never an API/worker credential or HTTP payload.
 * Registers authority only; it neither chooses an operational list nor fetches or activates a provider.
 */
import { activateDeployment, loadDeployment } from '../../../../packages/config/src/server.js';
import { registeredListSources } from '../../../../packages/compliance/src/lists/catalog.js';
import { createPool, withMaintenance } from '../../../../packages/data/src/pool.js';
import { databaseConfigFromEnv } from '../../../../packages/data/src/config.js';
import { syncScreeningListSources } from '../../../../packages/data/src/repositories/screening-list-authority.js';

activateDeployment(loadDeployment());
const sources = registeredListSources();
if (!process.argv.includes('--dry-run')) {
  const pool = createPool(databaseConfigFromEnv(process.env, 'screening-source-sync'));
  try { await withMaintenance(pool, (trx) => syncScreeningListSources(trx, sources)); }
  finally { await pool.end(); }
}
console.log(JSON.stringify({ eligibleSources: sources.map((s) => ({ packCode: s.packCode, factId: s.factId, sourceDigest: s.sourceDigest })) }));
