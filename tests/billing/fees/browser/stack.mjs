import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createPool, withMaintenance } from '@trustwork/data';
import { catalogue } from '../../../../packages/data/src/repositories/billing.ts';
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
assert.deepEqual(empty.fees, []); assert.equal(empty.unavailable.length, 3);
assert.equal(empty.coverage.sections.fees, 'available');
let published = false;
const control = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200); return res.end('ready'); }
    if (req.method === 'POST' && req.url === '/partial') {
      await db.admin.query('REVOKE SELECT ON trustwork.subscription_plan_version FROM trustwork_app');
      res.writeHead(200); return res.end('partial');
    }
    if (req.method === 'POST' && req.url === '/error') {
      await db.admin.query('REVOKE EXECUTE ON FUNCTION trustwork.billing_fee_hub_available(uuid) FROM trustwork_app');
      res.writeHead(200); return res.end('error');
    }
    if (req.method === 'POST' && req.url === '/restore') {
      await db.admin.query('GRANT SELECT ON trustwork.subscription_plan_version TO trustwork_app');
      await db.admin.query('GRANT EXECUTE ON FUNCTION trustwork.billing_fee_hub_available(uuid) TO trustwork_app');
      res.writeHead(200); return res.end('restored');
    }
    if (req.method === 'POST' && req.url === '/closed') {
      await withMaintenance(db.admin, trx => trx.updateTable('hub').set({lifecycle:'closed'}).where('id','=',w.hubA).execute());
      res.writeHead(200); return res.end('closed');
    }
    if (req.method !== 'POST' || req.url !== '/publish') { res.writeHead(404); return res.end(); }
    if (!published) {
      const fees = [];
      const starts = new Date(Date.now()+5000);
      for (const terms of [
        {kind:'consultation',categoryKey:'drawing_review',fixedMinor:'0',basisPoints:null,effectiveFrom:starts.toISOString()},
        {kind:'consultation',categoryKey:'synthetic_review',fixedMinor:'9223372036854775807',basisPoints:null,effectiveFrom:starts.toISOString()},
        {kind:'task',categoryKey:'work.envelope.roofing'},
      ]) {
        const fee = await w.draft(syntheticTerms({ effectiveFrom: new Date(Date.now()+86400000).toISOString(), fixedMinor:'125', ...terms, effectiveTo: null }));
        await w.activate(fee, await w.approve(fee)); fees.push(fee);
      }
      await withMaintenance(db.admin, async trx => {
        for (const kind of ['plan', 'deliverable']) {
          const offer = await catalogue.createOffer(trx,{hubId:w.hubA,code:`synthetic_${kind}`,name:`Synthetic ${kind}: long public offer name for construction documentation and specialist coordination`,kind,createdBy:w.p.owner,status:'active'});
          const price = await catalogue.draftPriceVersion(trx,{offerId:offer.id,amountMinor:kind==='plan'?'0':'9223372036854775807',currency:'USD',effectiveFrom:starts,effectiveTo:null,acceptanceTextVersion:'synthetic-prices-1',draftedBy:w.p.owner});
          await catalogue.activatePriceVersion(trx,price.id,w.p.officer);
          if(kind==='plan') {
            const id=randomUUID();
            const payload={id,offerId:offer.id,version:1,payerKind:'person',moduleKeys:['consultation'],includedQuota:[{moduleKey:'consultation',meter:'agent_actions',units:'1000',window:'month'}],connections:2,channels:3,representativeIncluded:false,priceVersionId:price.id,status:'draft'};
            await trx.insertInto('subscription_plan_version').values({id,offer_id:offer.id,version:1,payer_kind:'person',payload:JSON.stringify(payload),price_version_id:price.id,drafted_by:w.p.owner}).execute();
            await catalogue.activatePlanVersion(trx,id,w.p.officer);
          }
        }
      });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, starts.getTime()-Date.now()+100)));
      const positive = await data.getPublicPricing();
      assert.deepEqual([...positive.fees].sort((a,b)=>a.id.localeCompare(b.id)), fees.sort((a,b)=>a.id.localeCompare(b.id)));
      assert.ok(!JSON.stringify(positive).includes(w.p.owner));
      assert.equal(positive.prices.length,2);
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
