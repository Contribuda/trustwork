import assert from 'node:assert/strict';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { installSyntheticListSources } from './list-fixtures.js';
import type { Client, Harness } from '../../../backend/helpers/app.js';
import type { CrashContext } from '../../../backend/idempotency/cases.js';
import { activateList, SDN_ENTRIES } from '../../../screening/helpers.js';
import { ingestList } from '../../../../apps/worker/src/screening-lists/ingest.js';
import { fakeListSource, fileListSource, liveListSource } from '../../../../apps/worker/src/screening-lists/sources.js';
import { renderOfacSlsXml } from '../../../../packages/compliance/src/lists/index.js';
import { tx } from '../../../worker/helpers/worker-db.js';

/** Shared per-module crash acceptance, runnable independently and in BE-005's remote full gate. */
export async function listCrashCases(h: Harness, first: Client, second: Client, worker: DataPool, exactlyOnce: CrashContext['exactlyOnce']) {
  await installSyntheticListSources(h.db.admin);
  const node = (await h.db.admin.query<{id:string}>('SELECT id FROM trustwork.admin_node LIMIT 1')).rows[0]!.id;
  const person = (await h.db.admin.query<{person_id:string}>("SELECT person_id FROM trustwork.staff_role_assignment WHERE role='compliance-officer' AND revoked_at IS NULL LIMIT 1")).rows[0]!.person_id;
  const hub = await withMaintenance(h.db.admin,async(trx)=>{
    const row=await trx.insertInto('hub').values({slug:`synthetic-list-${crypto.randomUUID().slice(0,8)}`,lifecycle:'draft',pack_code:null,pack_version:null}).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('hub_profile').values({hub_id:row.id,node_id:node,name:{en:'Synthetic list crash hub'},default_locale:'en',locales:['en'],time_zone:'UTC',currency:'USD',brand_overlay:null,created_by:person}).execute();
    return row.id;
  });
  const source=(await h.db.admin.query<{id:string}>('SELECT id FROM trustwork.screening_list_source WHERE current')).rows[0]!.id;
  const audits=(action:string)=>async()=>(await h.db.admin.query<{n:number}>('SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE action=$1',[action])).rows[0]!.n;
  const proposal=await exactlyOnce({action:'screening.list_propose',client:first,url:'/v1/admin/screening/list-proposals',body:{hubId:hub,sourceId:source,cadenceSeconds:86400,warnAfterSeconds:259200,staleAfterSeconds:604800,reason:'Synthetic crash configuration',evidence:'source_review'},effects:audits('screening.list_configuration_proposed')});
  const id=(proposal.body as {id:string}).id;
  const digest=(await h.db.admin.query<{action_digest:string}>('SELECT action_digest FROM trustwork.screening_list_proposal WHERE id=$1',[id])).rows[0]!.action_digest;
  await exactlyOnce({action:'screening.list_decide',client:second,url:`/v1/admin/screening/list-proposals/${id}/decision`,body:{decision:'approve',actionDigest:digest,reason:'Synthetic crash independent approval'},effects:audits('screening.list_configuration_decided')});
  const list=(await h.db.admin.query<{id:string}>('SELECT id FROM trustwork.screening_list WHERE hub_id=$1',[hub])).rows[0]!.id;
  await exactlyOnce({action:'screening.list_status',client:first,url:`/v1/admin/screening/lists/${list}/status`,body:{status:'paused',reason:'Synthetic crash pause'},effects:audits('screening.list_status_set')});
  assert.equal((await first.post(`/v1/admin/screening/lists/${list}/status`,{status:'active',reason:'Synthetic resume before ingestion'})).status,200);
  await activateList(worker,list,SDN_ENTRIES);
  const bytes=Buffer.from(renderOfacSlsXml({publishedOn:'2026-10-31',entries:SDN_ENTRIES.slice(0,1)}));
  const file=fileListSource({dir:'/synthetic-test-only',maxBytes:1048576,fs:{stat:async()=>({size:bytes.length,mtime:new Date(),isFile:()=>true}),readFile:async()=>bytes}});
  const staged=await tx(worker,trx=>ingestList(trx,list,{sources:{file,fake:fakeListSource({production:false}),live:liveListSource({fetcher:null,activation:()=>null,maxBytes:1048576})}},new AbortController().signal));
  assert.equal(staged.outcome,'needs_confirmation');
  await exactlyOnce({action:'screening.list_confirm',client:second,url:`/v1/admin/screening/list-versions/${staged.versionId}/confirm`,body:{reason:'Synthetic official reduced export checked'},effects:audits('screening.list_version_confirmed')});
}
