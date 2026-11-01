import { createServer } from 'node:http';
import { screeningWorld } from './world.js';
import { installSyntheticListSources } from './list-fixtures.js';
import { withMaintenance } from '@trustwork/data';
import { screen, activateList, SDN_ENTRIES } from '../../../screening/helpers.js';
import { ingestList } from '../../../../apps/worker/src/screening-lists/ingest.js';
import { fakeListSource, fileListSource, liveListSource } from '../../../../apps/worker/src/screening-lists/sources.js';
import { renderOfacSlsXml } from '../../../../packages/compliance/src/lists/index.js';
import { tx } from '../../../worker/helpers/worker-db.js';

const webPort = Number(process.env.SANC006_WEB_PORT ?? 3580);
const apiPort = Number(process.env.SANC006_API_PORT ?? 3581);
const controlPort = Number(process.env.SANC006_CONTROL_PORT ?? 4582);
const w = await screeningWorld('sanc006_browser', `http://127.0.0.1:${webPort}`);
await installSyntheticListSources(w.h.db.admin);
await withMaintenance(w.h.db.admin, (trx) => trx.updateTable('person').set({display_name:'Orla Testworthy'}).where('id','=',w.seed.people.pure).execute());
await screen(w.worker,{kind:'person',id:w.seed.people.pure});
let closing = false;
const control = createServer(async (req, res) => {
  // A fixed local fixture operation only; no caller-selected source, URL, path or list.
  if (req.method === 'POST' && req.url === '/stage-additional-list') {
    try {
      const list = (await w.h.db.admin.query<{id:string}>('SELECT id FROM trustwork.screening_list WHERE hub_id=$1 AND source_id IS NOT NULL',[w.hubId])).rows[0];
      if (!list) { res.writeHead(404).end(); return; }
      await activateList(w.worker,list.id,SDN_ENTRIES);
      const bytes=Buffer.from(renderOfacSlsXml({publishedOn:'2026-10-31',entries:SDN_ENTRIES.slice(0,1)}));
      const file=fileListSource({dir:'/synthetic-test-only',maxBytes:1048576,fs:{stat:async()=>({size:bytes.length,mtime:new Date(),isFile:()=>true}),readFile:async()=>bytes}});
      const result=await tx(w.worker,trx=>ingestList(trx,list.id,{sources:{file,fake:fakeListSource({production:false}),live:liveListSource({fetcher:null,activation:()=>null,maxBytes:1048576})}},new AbortController().signal));
      res.writeHead(result.outcome==='needs_confirmation'?200:500,{'content-type':'application/json'}).end(JSON.stringify({outcome:result.outcome}));
    } catch { res.writeHead(500).end(); }
    return;
  }
  if (req.url !== '/bootstrap') { res.writeHead(404).end(); return; }
  // Isolated loopback test process only: sessions were created through password, TOTP and elevation endpoints.
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ hub: 'synthetic-screening', hubId:w.hubId, appealId:w.seed.people.pure, subjectId: w.seed.people.petr, companyId: w.seed.companies.unrelated, sessions: Object.fromEntries(([['first', w.first], ['second', w.second], ['subject', w.subject], ['otherStaff', w.otherStaff]] as const).map(([key, client]) => [key, [...client.jar].map(([name, value]) => ({ name, value }))])) }));
});
async function close(code = 0) {
  if (closing) return;
  closing = true; control.close(); await w.close(); process.exit(code);
}
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
try {
  await w.h.created.app.listen(apiPort, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(controlPort, '127.0.0.1', resolve); });
  console.log('SANC-006 local API and synthetic screening records ready');
} catch (error) { console.error(error); await close(1); }
