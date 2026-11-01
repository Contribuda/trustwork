import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { buildContentWorld, credit, draft, refused } from '../content/helpers.js';
import { publications, issues, digests, publicContent, contentWorker } from '../../packages/data/src/repositories/content.js';
const db=await provisionTestDatabase('provenance_legacy_bundles');
test('legacy stored content cannot bypass real bundle and scheduled-release guards', {skip:db?false:SKIP_REASON},async t=>{
  if(!db)return;t.after(()=>db.close());await db.migrate();await db.createAppLogin();
  const w=await buildContentWorld(db.admin,db.app),p=w.people;
  const a=await w.act.elevate(p.editorA),chief=await w.act.elevate(p.chief);
  const create=()=>w.act.as(p.writer,trx=>publications.create(trx,null,{hubId:w.hubId,owner:{kind:'person'},format:'article',articleFormat:'practice',language:'en',licence:'cc_by',requiresReview:false,draft:draft({title:'Synthetic pre-provenance stored publication'}),authorship:credit(p.writer)}));
  const legacy=await create();
  // Test-only simulation of data published before the additive migration; runtime roles cannot perform these writes.
  await withMaintenance(db.admin,async trx=>{
    const version=(await sql<{id:string}>`UPDATE trustwork.publication_version v SET status='published',published_at=now(),published_by=${p.writer}::uuid,content_digest=trustwork.content_version_digest(v) WHERE publication_id=${legacy.id}::uuid RETURNING id`.execute(trx)).rows[0]!;
    await trx.updateTable('publication').set({status:'published',current_version:1,current_version_id:version.id,first_published_at:new Date()}).where('id','=',legacy.id).execute();
  });
  const version=(await w.act.as(p.writer,trx=>publications.versions(trx,legacy.id)))[0]!;
  const visible=await withMaintenance(db.admin,trx=>publicContent.publication(trx,w.hubId,legacy.id)) as {current:{provenance:{availability:string}}};
  assert.equal(visible.current.provenance.availability,'unavailable','no retroactive declaration is manufactured');
  let issue=await w.act.as(p.editorA,trx=>issues.create(trx,a,{hubId:w.hubId,number:27,date:'2026-11-01',theme:'Synthetic legacy bundle',coverAssetId:null,editorLetterId:null}));
  issue=await w.act.as(p.editorA,trx=>issues.curate(trx,a,issue.id,issue.revision,{items:[{position:1,section:'practice',publicationId:legacy.id,publicationVersionId:version.id}],theme:null,coverAssetId:null,editorLetterId:null}));
  issue=await w.act.as(p.editorA,trx=>issues.transition(trx,a,issue.id,issue.revision,'curated'));
  issue=await w.act.as(p.editorA,trx=>issues.transition(trx,a,issue.id,issue.revision,'review'));
  await refused(w.act.as(p.chief,trx=>issues.release(trx,chief,issue.id,issue.revision)),'23514','content.provenance_required');
  const digest=await w.act.as(p.editorA,trx=>digests.create(trx,a,{hubId:w.hubId,title:'Synthetic legacy digest',period:'2026-11',publicationIds:[legacy.id]}));
  await refused(w.act.as(p.chief,trx=>digests.release(trx,chief,digest.id,digest.revision)),'23514','content.provenance_required');
  const scheduled=await create();
  await withMaintenance(db.admin,trx=>trx.updateTable('publication').set({status:'scheduled',scheduled_for:new Date(Date.now()-1000)}).where('id','=',scheduled.id).execute());
  await refused(withMaintenance(db.admin,trx=>contentWorker.publishDue(trx)),'23514','content.provenance_required');
  assert.equal((await w.act.as(p.writer,trx=>publications.get(trx,scheduled.id)))!.status,'scheduled');
  assert.equal((await w.act.as(p.writer,trx=>publications.versions(trx,legacy.id)))[0]!.content_digest,version.content_digest);
});
