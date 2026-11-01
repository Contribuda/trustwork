import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createPool } from '@trustwork/data';
import { createApp } from '../../../../apps/api/src/app.ts';
import { provisionTestDatabase } from '../../../data/helpers/postgres.ts';
import { feeWorld, syntheticTerms } from '../helpers.ts';
import { createHttpDataPort } from '../../../../apps/web/app/_lib/data/http/index.ts';
import { createTransport } from '../../../../apps/web/app/_lib/data/http/transport.ts';

const db = await provisionTestDatabase('fee_browser');
if (!db) throw new Error('PostgreSQL is required');
await db.migrate(); await db.createAppLogin();
const pool = createPool({ ...db.appConfig, max: 6 });
const w = await feeWorld(db.admin, pool);
const app = await createApp({
  env: { API_HOST: '127.0.0.1', API_PORT: '3541', PUBLIC_ORIGIN: 'http://127.0.0.1:3540', TRUSTWORK_HUB_ID: w.hubA, MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
  pool, clock: { now: () => new Date() },
});
await app.fastify.listen({ host: '127.0.0.1', port: 3541 });
const transport = createTransport({ origin: () => 'http://127.0.0.1:3541', cookies: async () => { throw new Error('Public pricing must never read the session'); } });
const data = createHttpDataPort(transport);
const empty = await data.getPublicPricing();
assert.deepEqual(empty.fees, []); assert.equal(empty.unavailable.length, 5);
let published = false;
const control = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200); return res.end('ready'); }
    if (req.method !== 'POST' || req.url !== '/publish') { res.writeHead(404); return res.end(); }
    if (!published) {
      const fees = [];
      for (const terms of [
        {kind:'consultation',categoryKey:'drawing_review'},
        {kind:'consultation',categoryKey:'synthetic_review'},
        {kind:'task',categoryKey:'work.envelope.roofing'},
      ]) {
        const fee = await w.draft(syntheticTerms({ ...terms, effectiveFrom: new Date(Date.now()+60000).toISOString(), fixedMinor: '125', effectiveTo: null }));
        await w.activate(fee, await w.approve(fee)); fees.push(fee);
      }
      const positive = await data.getPublicPricing();
      assert.deepEqual([...positive.fees].sort((a,b)=>a.id.localeCompare(b.id)), fees.sort((a,b)=>a.id.localeCompare(b.id)));
      assert.ok(!JSON.stringify(positive).includes(w.p.owner));
      published = true;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ synthetic: true, dataPort: 'passed' }));
  })().catch((error) => { console.error(error); res.writeHead(500); res.end('Synthetic setup failed'); });
});
await new Promise((resolve) => control.listen(3542, '127.0.0.1', resolve));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  control.close(); await app.close(); await pool.end(); await db.close(); process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
console.log('BILL-003 local synthetic browser stack ready; empty DataPort passed');
