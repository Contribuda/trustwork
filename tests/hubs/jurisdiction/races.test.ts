import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { approvals } from '../../../packages/data/src/repositories/admin.js';
import { hubConfig, hubs } from '../../../packages/data/src/repositories/hubs.js';
import { jurisdictionEvidence, jurisdictionAuthority } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { provisionTestDatabase } from '../../data/helpers/postgres.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** Wait for PostgreSQL to report the competing transaction actually waiting, never rely on a guessed race delay. */
async function waitForLock(admin:DataPool) {
  for(let n=0;n<200;n++) {
    const r=await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' LIMIT 1");
    if(r.rowCount)return;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.fail('competing transaction never reached a database lock');
}
const db=await provisionTestDatabase('jurisdiction_races',{weight:2});
test('ADR022 races in both database lock orders',{skip:db?false:'PostgreSQL unavailable'},async t=>{
 if(!db)return;t.after(()=>db.close());await db.migrate();await db.createAppLogin();
 const f=await authorityFixture(db.admin,db.app);const {a,p,hubId}=f;
 const changeLanguages=async(locales:string[],hold?:()=>Promise<void>)=>a.cmd(p.owner,async(trx,ctx)=>{
   const hp=await hubs.profile(trx,hubId);assert.ok(hp);
   await hubs.updateProfile(trx,ctx,hubId,hp.revision,{name:Object.fromEntries(locales.map(l=>[l,'Synthetic race hub'])),locales,defaultLocale:'en',timeZone:hp.time_zone,currency:hp.currency,brandOverlay:null});
   await hold?.();
 });
 await t.test('language change wins: pending exact approval cannot activate incomplete legal languages',async()=>{
   const v=await f.draft();const ap=await f.approvalFor(v);
   const entered=barrier();const release=barrier();
   const first=changeLanguages(['en','es','ka'],async()=>{entered.resolve();await release.promise;});
   await entered.promise;
   const second=a.cmd(p.officer,(trx,ctx)=>hubConfig.activate(trx,ctx,v.id,v.revision,ap)).then(()=>null,e=>e as {code:string});
   try{await waitForLock(db.admin);}finally{release.resolve();}
   await first;assert.equal((await second)?.code,'23514');
   await changeLanguages(['en','es']);
 });
 await t.test('activation wins: racing language change cannot leave an active incomplete policy',async()=>{
   const v=await f.draft();const ap=await f.approvalFor(v);
   const entered=barrier();const release=barrier();
   const first=a.cmd(p.officer,async(trx,ctx)=>{await hubConfig.activate(trx,ctx,v.id,v.revision,ap);entered.resolve();await release.promise;});
   await entered.promise;
   const second=changeLanguages(['en','es','ka']).then(()=>null,e=>e as {code:string});
   try{await waitForLock(db.admin);}finally{release.resolve();}
   await first;assert.equal((await second)?.code,'23514');
 });
 await t.test('approval withdrawal wins: waiting activation cannot consume it',async()=>{
   const v=await f.draft();const ap=await f.approvalFor(v);
   const entered=barrier();const release=barrier();
   const first=a.as(p.officer,async trx=>{await approvals.withdraw(trx,ap);entered.resolve();await release.promise;});
   await entered.promise;
   const second=a.cmd(p.officer,(trx,ctx)=>hubConfig.activate(trx,ctx,v.id,v.revision,ap)).then(()=>null,e=>e as {code:string});
   try{await waitForLock(db.admin);}finally{release.resolve();}
   await first;assert.ok(await second);
 });
 await t.test('approval consumption wins: racing withdrawal cannot undo the committed activation',async()=>{
   const v=await f.draft();const ap=await f.approvalFor(v);
   const entered=barrier();const release=barrier();
   const first=a.cmd(p.officer,async(trx,ctx)=>{await hubConfig.activate(trx,ctx,v.id,v.revision,ap);entered.resolve();await release.promise;});
   await entered.promise;
   const second=a.as(p.officer,trx=>approvals.withdraw(trx,ap)).then(()=>null,e=>e as {code:string});
   try{await waitForLock(db.admin);}finally{release.resolve();}
   await first;assert.ok(await second);
 });
 const deal=await createQuote(a.as,p.outsider,p.moderator);
 await f.attest('person',p.outsider);await f.attest('person',p.moderator);await f.attest('project',deal.projectId);
 await t.test('source change wins: stale exact source digest refuses activation',async()=>{
   const v=await f.draft();const ap=await f.approvalFor(v);
   const entered=barrier();const release=barrier();
   const first=withMaintenance(db.admin,async trx=>{const source=await jurisdictionEvidence.importSource(trx,sourceDocument('US','synthetic-2'));entered.resolve();await release.promise;return source;});
   await entered.promise;
   const second=a.cmd(p.officer,(trx,ctx)=>hubConfig.activate(trx,ctx,v.id,v.revision,ap)).then(()=>null,e=>e as {code:string});
   try{await waitForLock(db.admin);}finally{release.resolve();}
   const src=await first;assert.equal((await second)?.code,'23514');
   f.payload.agentSettings.jurisdictions[0]!.sourceId=src.id;f.payload.agentSettings.jurisdictions[0]!.sourceRevision=src.revision;f.payload.agentSettings.jurisdictions[0]!.sourceDigest=src.digest;
 });
 await t.test('activation wins: later source change invalidates projection before any effect',async()=>{
   const v=await f.draft();const ap=await f.approvalFor(v);
   const entered=barrier();const release=barrier();
   const first=a.cmd(p.officer,async(trx,ctx)=>{await hubConfig.activate(trx,ctx,v.id,v.revision,ap);entered.resolve();await release.promise;});
   await entered.promise;
   const second=withMaintenance(db.admin,trx=>jurisdictionEvidence.importSource(trx,sourceDocument('US','synthetic-3')));
   try{await waitForLock(db.admin);}finally{release.resolve();}
   await first;await second;
   assert.equal((await a.as(p.moderator,trx=>jurisdictionAuthority.limits(trx,deal.quoteId,'send_quote'))).status,'unknown');
 });
 await t.test('source head round trip cannot revive a stale source approval',async()=>{
   await withMaintenance(db.admin,trx=>trx.updateTable('jurisdiction_source_current').set({source_id:f.payload.agentSettings.jurisdictions[0]!.sourceId}).where('jurisdiction','=','US').execute());
   await assert.rejects(f.activate(await f.draft()),{code:'23514'});
 });

});
