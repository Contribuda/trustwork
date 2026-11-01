/** Local-only browser fixture: real API and PostgreSQL, synthetic identities, no external provider or mail send. */
import { createServer } from 'node:http';
import { withMaintenance } from '@trustwork/data';
import { startHarness } from '../../backend/helpers/app.js';
import { login, seedPersonas } from '../../backend/helpers/personas.js';
import { elevate, enrol } from '../../backend/second-factor/helpers.js';
import { workerLogin } from '../../assistant/helpers.js';
import { adminSetup, staffRoleDefinitions } from '../../../packages/data/src/repositories/admin.js';
import { baselineIds } from '../../screening-lists/helpers.js';
import { activateList, CONS_ENTRIES, screen, SDN_ENTRIES } from '../../screening/helpers.js';

const harness = await startHarness('sanc007_browser', { env: {
  API_HOST: '127.0.0.1', API_PORT: '3587', PUBLIC_ORIGIN: 'http://127.0.0.1:3586', AUTH_PROVIDER_MODE: 'fake',
  AUTH_RATE_LIMIT_PER_MINUTE: '10000', AUTH_LOCKOUT_THRESHOLD: '20', API_LOG_LEVEL: 'error',
} });
if (!harness) throw new Error('SANC-007 requires PostgreSQL');
const h = harness;
const workers = await workerLogin(h);
const worker = workers.pool(4);
const seed = await seedPersonas(h);
await withMaintenance(h.db.admin, async (trx) => {
  const node = await adminSetup.createNode(trx, 'Synthetic SANC-007 browser node');
  await staffRoleDefinitions.release(trx, { version: 1, role: 'compliance-officer', scopes: ['node', 'hub'], permissions: ['admin.claims.read', 'admin.claims.decide'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
  for (const key of ['anna', 'boris'] as const) await adminSetup.bootstrapFirstAdmin(trx, { personId: seed.people[key], role: 'compliance-officer', scope: { kind: 'node', nodeId: node.id }, definitionVersion: 1, reason: 'Synthetic fixture setup' });
  await trx.updateTable('screening_list').set({ min_entries: 1, max_drop_share: '0.99' }).where('baseline', '=', true).execute();
  await trx.updateTable('person').set({ display_name: 'Milo Fictivsky' }).where('id', '=', seed.people.petr).execute();
});
const lists = await baselineIds(h.db.admin);
await activateList(worker, lists.sdn, SDN_ENTRIES);
await activateList(worker, lists.cons, CONS_ENTRIES);
await screen(worker, { kind: 'person', id: seed.people.petr });
h.staff.set(seed.people.anna, ['trust-reviewer']);
const reviewer = h.client();
await login(reviewer, 'anna');
const enrolled = await enrol(h, reviewer);
await elevate(h, reviewer, enrolled.secret);
const match = (await h.db.admin.query('SELECT id FROM trustwork.screening_match WHERE subject_person_id = $1', [seed.people.petr])).rows[0];
const confirmed = await reviewer.post(`/v1/admin/screening/matches/${match.id}/confirm`, { reason: 'Synthetic browser fixture decision', evidence: 'identity_document' });
if (confirmed.status !== 200) throw new Error(JSON.stringify(confirmed.body));
const control = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/stale') { h.clock.advance(11 * 60_000); res.writeHead(200).end('{}'); }
  else if (req.url === '/ready') { res.writeHead(200).end('{}'); }
  else { res.writeHead(404).end(); }
});
await new Promise<void>((resolve) => control.listen(4587, '127.0.0.1', resolve));
await h.created.app.listen(3587, '127.0.0.1');
let closing = false;
async function close() { if (closing) return; closing = true; control.close(); await workers.close(); await h.close(); process.exit(0); }
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
