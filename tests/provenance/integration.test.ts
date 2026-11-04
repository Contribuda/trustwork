import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { contentWorker } from '../../packages/data/src/repositories/content.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { buildContentHttpWorld, ok, expectRefusal } from '../content/http.js';
import { draft } from '../content/helpers.js';
import { ProvenanceWorkspaceSchema, PublicPublicationSchema, isMachineCredit } from '../../packages/contracts/src/client.js';
const h=await startHarness('provenance_integration');
test('PROV actual CNT commands and channel-scoped public delivery', {skip:h?false:SKIP_REASON}, async t=>{
  if(!h)return;
  const world=await buildContentHttpWorld(h);const {c,w,anonymous}=world;
  t.after(async()=>{await world.close();await h.close();});
  async function create(language='en') {
    return ok<{publication:{id:string;revision:number}}>(await c.writer.post('/v1/publications',{
      owner:{kind:'person'},format:'article',articleFormat:'practice',originalLanguage:language,licence:'cc_by',draft:draft({language,assistantAssisted:true}),
      authorship:[{kind:'person',id:w.people.writer,credit:'Synthetic Writer',assistantAssisted:true}],
    }),201).publication;
  }
  const workspace=async(id:string)=>ProvenanceWorkspaceSchema.parse(ok(await c.writer.get(`/v1/provenance/publications/${id}`)));
  async function declare(id:string,original: ReturnType<typeof ProvenanceWorkspaceSchema.parse>['binding']|null=null) {
    const v=await workspace(id);
    ok(await c.writer.post('/v1/provenance/declarations',{declaration:{binding:v.binding,expectedRevision:v.record?.revision??0,kind:original?'machine_translation':'ai_assisted',roles:[original?'editorial_translator':'editorial_writer'],evidence:'human_declaration',original,reason:'Synthetic declaration'}}),201);
    return workspace(id);
  }
  const credit=(provenanceId:string,channels:string[]=['web'])=>c.writer.post('/v1/provenance/consents',{provenanceId,role:'responsible_editor',credit:'Synthetic Writer',channels,noticeVersion:'provenance.credit.v1',informedConsent:true});
  const original=await create();
  await t.test('a tool is never a credit, in any case or spacing and for any author kind',async()=>{
    for(const name of ['AI',' ai ','A.I.','Artificial Intelligence','ChatGPT','GPT','Claude','Codex','Gemini','Copilot','\u0418\u0418']) {
      assert.equal(isMachineCredit(name),true,name);
      expectRefusal(await c.writer.post('/v1/publications',{owner:{kind:'person'},format:'article',articleFormat:'practice',originalLanguage:'en',licence:'cc_by',draft:draft({language:'en'}),
        authorship:[{kind:'person',id:w.people.writer,credit:name,assistantAssisted:true}]}),422,'validation.schema','credit_names_a_tool');
    }
    assert.equal(isMachineCredit('Claudette Synthetic'),false);
    ok(await c.writer.post('/v1/publications',{owner:{kind:'person'},format:'article',articleFormat:'practice',originalLanguage:'en',licence:'cc_by',draft:draft({language:'en'}),
      authorship:[{kind:'person',id:w.people.writer,credit:'Claudette Synthetic',assistantAssisted:false}]}),201);
  });
  await t.test('declared assistance reaches readers even when the draft flag is off',async()=>{
    const quiet=ok<{publication:{id:string;revision:number}}>(await c.writer.post('/v1/publications',{owner:{kind:'person'},format:'article',articleFormat:'practice',originalLanguage:'en',licence:'cc_by',draft:draft({language:'en',assistantAssisted:false}),
      authorship:[{kind:'person',id:w.people.writer,credit:'Synthetic Writer',assistantAssisted:false}]}),201).publication;
    const view=await declare(quiet.id);
    ok(await credit(view.record!.id),201);
    ok(await c.writer.post(`/v1/publications/${quiet.id}/publish`,{expectedRevision:quiet.revision,scheduledFor:null}));
    const current=PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${quiet.id}`))).current;
    assert.equal(current.assistantAssisted,false);
    assert.equal(current.provenance?.machineAssisted,true);
  });
  await t.test('legacy publish and schedule refuse absent provenance',async()=>{
    for(const scheduledFor of [null,'2099-01-01T00:00:00.000Z']) expectRefusal(await c.writer.post(`/v1/publications/${original.id}/publish`,{expectedRevision:original.revision,scheduledFor}),422,'validation.schema','provenance_required');
    expectRefusal(await c.outsider.get(`/v1/provenance/publications/${original.id}`),404,'access.not_found');
  });
  let originalView=await declare(original.id);
  let webConsent='';
  await t.test('a disclosed piece publishes only under its named responsible person, never by inference',async()=>{
    expectRefusal(await c.writer.post(`/v1/publications/${original.id}/publish`,{expectedRevision:original.revision,scheduledFor:null}),422,'validation.schema','provenance_credit_required');
    expectRefusal(await c.coauthor.post('/v1/provenance/consents',{provenanceId:originalView.record!.id,role:'responsible_editor',credit:'Synthetic Writer',channels:['web'],noticeVersion:'provenance.credit.v1',informedConsent:true}),404,'access.not_found');
    expectRefusal(await credit(originalView.record!.id,['feed']).then(async r=>{webConsent=ok<{consentId:string}>(r,201).consentId;return c.writer.post(`/v1/publications/${original.id}/publish`,{expectedRevision:original.revision,scheduledFor:null});}),422,'validation.schema','provenance_credit_required');
    ok(await c.writer.post('/v1/provenance/revocations',{consentId:webConsent,reason:'Synthetic narrower credit'}));
    webConsent=ok<{consentId:string}>(await credit(originalView.record!.id),201).consentId;
    ok(await c.writer.post(`/v1/publications/${original.id}/publish`,{expectedRevision:original.revision,scheduledFor:null}));
    const publicView=PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${original.id}`)));
    assert.equal(publicView.current.contentDigest,originalView.binding.digest.value);
    assert.equal(publicView.current.provenance?.availability,'recorded');
    if(publicView.current.provenance?.availability==='recorded')assert.deepEqual(publicView.current.provenance.credits,{responsible_editor:'Synthetic Writer'});
  });
  await t.test('web-only consent never appears in feed or PDF channel; withdrawal is immediate and keeps the label',async()=>{
    for(const channel of ['web','feed']) {
      const response=await anonymous.get(`/v1/publications/${original.id}?channel=${channel}`);
      const p=PublicPublicationSchema.parse(ok(response)).current.provenance;
      assert.equal(p?.availability,'recorded');if(p?.availability==='recorded')assert.equal(p.credits.responsible_editor,channel==='web'?'Synthetic Writer':undefined);
      assert.match(String(response.headers['cache-control']??''),/no-store/);
    }
    expectRefusal(await anonymous.get(`/v1/publications/${original.id}?channel=pdf`),422,'validation.schema');
    expectRefusal(await anonymous.get(`/v1/publications/${original.id}/versions/1?channel=pdf`),422,'validation.schema');
    expectRefusal(await c.coauthor.post('/v1/provenance/revocations',{consentId:webConsent,reason:'Synthetic withdrawal'}),404,'access.not_found');
    ok(await c.writer.post('/v1/provenance/revocations',{consentId:webConsent,reason:'Synthetic withdrawal'}));
    const p=PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${original.id}`))).current.provenance;
    assert.equal(p?.availability,'recorded');
    if(p?.availability==='recorded'){assert.deepEqual(p.credits,{});assert.equal(p.kind,'ai_assisted');assert.equal(p.machineAssisted,true);}
  });
  await t.test('public JSON cannot request a PDF-only identity',async()=>{
    ok(await credit(originalView.record!.id,['pdf']),201);
    for(const suffix of ['', '/versions/1'])expectRefusal(await anonymous.get(`/v1/publications/${original.id}${suffix}?channel=pdf`),422,'validation.schema');
    const p=PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${original.id}`))).current.provenance;
    if(p?.availability==='recorded')assert.deepEqual(p.credits,{});
  });
  const translation=await create('es');let translationView=await declare(translation.id,originalView.binding);
  await t.test('translation legacy publish cannot bypass distinct authorized exact review',async()=>{
    expectRefusal(await c.writer.post(`/v1/publications/${translation.id}/publish`,{expectedRevision:translation.revision,scheduledFor:null}),422,'validation.schema','provenance_review_required');
    const review={provenanceId:translationView.record!.id,binding:translationView.binding,original:originalView.binding,reason:'Synthetic review'};
    expectRefusal(await c.writer.post('/v1/provenance/reviews',{review}),403,'access.forbidden');
    expectRefusal(await c.coauthor.post('/v1/provenance/reviews',{review}),403,'access.forbidden');
    ok(await c.writer.post(`/v1/publications/${translation.id}/editors`,{personId:w.people.coauthor,rights:'publish'}));
    ok(await c.coauthor.post('/v1/provenance/reviews',{review}),201);
    ok(await credit(translationView.record!.id),201);
    translationView=await workspace(translation.id);
    ok(await c.writer.post(`/v1/publications/${translation.id}/publish`,{expectedRevision:translationView.publicationRevision,scheduledFor:null}));
  });
  await t.test('published translation disclosure cannot erase its immutable original',async()=>{
    expectRefusal(await c.writer.post('/v1/provenance/declarations',{declaration:{binding:translationView.binding,expectedRevision:translationView.record!.revision,kind:'ai_assisted',roles:['editorial_writer'],evidence:'human_declaration',original:null,reason:'Synthetic downgrade attempt'}}),422,'validation.schema');
  });
  const scheduled=await create('ka');
  const scheduledView=await declare(scheduled.id,originalView.binding);
  ok(await c.writer.post(`/v1/publications/${scheduled.id}/editors`,{personId:w.people.coauthor,rights:'publish'}));
  ok(await c.coauthor.post('/v1/provenance/reviews',{review:{provenanceId:scheduledView.record!.id,binding:scheduledView.binding,original:originalView.binding,reason:'Synthetic scheduled review'}}),201);
  ok(await credit(scheduledView.record!.id),201);
  ok(await c.writer.post(`/v1/publications/${scheduled.id}/publish`,{expectedRevision:(await workspace(scheduled.id)).publicationRevision,scheduledFor:'2099-01-01T00:00:00Z'}));
  const unaffected=await create();
  const unaffectedView=await declare(unaffected.id);
  ok(await credit(unaffectedView.record!.id),201);
  ok(await c.writer.post(`/v1/publications/${unaffected.id}/publish`,{expectedRevision:unaffected.revision,scheduledFor:'2099-01-01T00:00:00Z'}));
  await t.test('correction prepares, declares and releases exact content without mutating original digest',async()=>{
    originalView=await workspace(original.id);const corrected=draft({body:'Synthetic corrected body.',assistantAssisted:true});
    expectRefusal(await c.writer.post(`/v1/publications/${original.id}/corrections`,{expectedRevision:originalView.publicationRevision,draft:corrected,note:'Synthetic correction',reason:'Synthetic correction'}),422,'validation.schema','provenance_required');
    ok(await c.writer.post(`/v1/provenance/publications/${original.id}/correction-draft`,{expectedRevision:originalView.publicationRevision,draft:corrected,note:'Synthetic correction'}));
    originalView=await declare(original.id);
    expectRefusal(await c.writer.post(`/v1/publications/${original.id}/corrections`,{expectedRevision:originalView.publicationRevision,draft:corrected,note:'Synthetic correction',reason:'Synthetic correction'}),422,'validation.schema','provenance_credit_required');
    ok(await credit(originalView.record!.id),201);
    ok(await c.writer.post(`/v1/publications/${original.id}/corrections`,{expectedRevision:originalView.publicationRevision,draft:corrected,note:'Synthetic correction',reason:'Synthetic correction'}),201);
    const pinned=ok<{contentDigest:string}>(await anonymous.get(`/v1/publications/${original.id}/versions/1`));
    assert.equal(pinned.contentDigest,translationView.record!.original!.digest.value);
    const p=PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${translation.id}`))).current.provenance;
    assert.equal(p?.availability,'recorded');if(p?.availability==='recorded'){assert.equal(p.translation?.stale,true);assert.equal(p.translation?.originalDigest,pinned.contentDigest);}
  });
  await t.test('a correction keeps the disclosure of the version it corrects',async()=>{
    // No author row carries the flag, so only the record of version 1 knows about the assistance.
    const piece=ok<{publication:{id:string;revision:number}}>(await c.writer.post('/v1/publications',{owner:{kind:'person'},format:'article',articleFormat:'practice',originalLanguage:'en',licence:'cc_by',draft:draft({language:'en',assistantAssisted:true}),
      authorship:[{kind:'person',id:w.people.writer,credit:'Synthetic Writer',assistantAssisted:false}]}),201).publication;
    const first=await declare(piece.id);ok(await credit(first.record!.id),201);
    ok(await c.writer.post(`/v1/publications/${piece.id}/publish`,{expectedRevision:piece.revision,scheduledFor:null}));
    const corrected=draft({body:'Synthetic body with the flag cleared.',assistantAssisted:false});
    ok(await c.writer.post(`/v1/provenance/publications/${piece.id}/correction-draft`,{expectedRevision:(await workspace(piece.id)).publicationRevision,draft:corrected,note:'Synthetic correction'}));
    let view=await workspace(piece.id);
    const removal={declaration:{binding:view.binding,expectedRevision:0,kind:'none',roles:[],evidence:'human_declaration',original:null,reason:'Synthetic removal attempt'}};
    expectRefusal(await c.writer.post('/v1/provenance/declarations',removal),422,'validation.schema','disclosure_required');
    // The release is the rule, not the declaration: a record that reached the draft some other way is refused there too.
    await withMaintenance(h.db.admin,trx=>sql`INSERT INTO trustwork.provenance_record(publication_id,version_id,version_digest,version_revision,revision,responsible_person_id,kind,roles,evidence,reason)
      SELECT v.publication_id,v.id,trustwork.content_version_digest(v),v.revision,1,${w.people.writer}::uuid,'none','{}','human_declaration','Synthetic record the command refuses'
      FROM trustwork.publication_version v WHERE v.publication_id=${piece.id}::uuid AND v.status='draft'`.execute(trx));
    view=await workspace(piece.id);
    const release={expectedRevision:view.publicationRevision,draft:corrected,note:'Synthetic correction',reason:'Synthetic correction'};
    expectRefusal(await c.writer.post(`/v1/publications/${piece.id}/corrections`,release),422,'validation.schema','provenance_disclosure_required');
    // Keeping the disclosure also brings back the named responsible person the kind `none` would have dropped.
    ok(await c.writer.post('/v1/provenance/declarations',{declaration:{binding:view.binding,expectedRevision:1,kind:'ai_assisted',roles:['editorial_writer'],evidence:'human_declaration',original:null,reason:'Synthetic kept disclosure'}}),201);
    view=await workspace(piece.id);
    expectRefusal(await c.writer.post(`/v1/publications/${piece.id}/corrections`,{...release,expectedRevision:view.publicationRevision}),422,'validation.schema','provenance_credit_required');
    ok(await credit(view.record!.id),201);
    view=await workspace(piece.id);
    ok(await c.writer.post(`/v1/publications/${piece.id}/corrections`,{...release,expectedRevision:view.publicationRevision}),201);
    const current=PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${piece.id}`))).current;
    assert.equal(current.assistantAssisted,false);
    assert.equal(current.provenance?.machineAssisted,true);
    if(current.provenance?.availability!=='recorded')assert.fail('the corrected version keeps its record');
    assert.equal(current.provenance.kind,'ai_assisted');
    assert.deepEqual(current.provenance.credits,{responsible_editor:'Synthetic Writer'});
  });
  await t.test('a version published before records existed still passes on its assistance flag',async()=>{
    const legacy=ok<{publication:{id:string;revision:number}}>(await c.writer.post('/v1/publications',{owner:{kind:'person'},format:'article',articleFormat:'practice',originalLanguage:'en',licence:'cc_by',draft:draft({language:'en',assistantAssisted:true}),
      authorship:[{kind:'person',id:w.people.writer,credit:'Synthetic Writer',assistantAssisted:false}]}),201).publication;
    // Test-only simulation of data published before the provenance migrations; runtime roles cannot perform these writes.
    await withMaintenance(h.db.admin,async trx=>{
      const version=(await sql<{id:string}>`UPDATE trustwork.publication_version v SET status='published',published_at=now(),published_by=${w.people.writer}::uuid,content_digest=trustwork.content_version_digest(v) WHERE publication_id=${legacy.id}::uuid RETURNING id`.execute(trx)).rows[0]!;
      await trx.updateTable('publication').set({status:'published',current_version:1,current_version_id:version.id,first_published_at:new Date()}).where('id','=',legacy.id).execute();
    });
    ok(await c.writer.post(`/v1/provenance/publications/${legacy.id}/correction-draft`,{expectedRevision:(await workspace(legacy.id)).publicationRevision,draft:draft({body:'Synthetic corrected legacy body.',assistantAssisted:false}),note:'Synthetic correction'}));
    const view=await workspace(legacy.id);
    expectRefusal(await c.writer.post('/v1/provenance/declarations',{declaration:{binding:view.binding,expectedRevision:0,kind:'none',roles:[],evidence:'human_declaration',original:null,reason:'Synthetic removal attempt'}}),422,'validation.schema','disclosure_required');
  });
  await t.test('a published label is never lowered, in place or through a correction',async()=>{
    const piece=await create();
    const first=await declare(piece.id);ok(await credit(first.record!.id),201);
    ok(await c.writer.post(`/v1/publications/${piece.id}/publish`,{expectedRevision:piece.revision,scheduledFor:null}));
    const redeclare=(kind:string,view:Awaited<ReturnType<typeof workspace>>,expectedRevision:number)=>c.writer.post('/v1/provenance/declarations',{declaration:{binding:view.binding,expectedRevision,kind,roles:['editorial_illustrator'],evidence:'human_declaration',original:null,reason:'Synthetic redeclaration'}});
    // A label may rise on a published version; a generated image needs no new record to be shown here.
    let view=await workspace(piece.id);
    ok(await redeclare('generated',view,1),201);
    view=await workspace(piece.id);
    expectRefusal(await redeclare('ai_assisted',view,2),422,'validation.schema','disclosure_required');
    // The same route with the weaker record already in place, as data written before this rule: the correction still sees the label readers had.
    await withMaintenance(h.db.admin,trx=>sql`INSERT INTO trustwork.provenance_record(publication_id,version_id,version_digest,version_revision,revision,responsible_person_id,kind,roles,evidence,reason)
      SELECT r.publication_id,r.version_id,r.version_digest,r.version_revision,3,r.responsible_person_id,'ai_assisted',ARRAY['editorial_writer'],'human_declaration','Synthetic earlier weakening'
      FROM trustwork.provenance_record r WHERE r.publication_id=${piece.id}::uuid AND r.revision=2`.execute(trx));
    const corrected=draft({body:'Synthetic body after the label was lowered.',assistantAssisted:true});
    ok(await c.writer.post(`/v1/provenance/publications/${piece.id}/correction-draft`,{expectedRevision:(await workspace(piece.id)).publicationRevision,draft:corrected,note:'Synthetic correction'}));
    view=await workspace(piece.id);
    expectRefusal(await redeclare('ai_assisted',view,0),422,'validation.schema','disclosure_required');
    await withMaintenance(h.db.admin,trx=>sql`INSERT INTO trustwork.provenance_record(publication_id,version_id,version_digest,version_revision,revision,responsible_person_id,kind,roles,evidence,reason)
      SELECT v.publication_id,v.id,trustwork.content_version_digest(v),v.revision,1,${w.people.writer}::uuid,'ai_assisted',ARRAY['editorial_writer'],'human_declaration','Synthetic record the command refuses'
      FROM trustwork.publication_version v WHERE v.publication_id=${piece.id}::uuid AND v.status='draft'`.execute(trx));
    view=await workspace(piece.id);
    expectRefusal(await c.writer.post(`/v1/publications/${piece.id}/corrections`,{expectedRevision:view.publicationRevision,draft:corrected,note:'Synthetic correction',reason:'Synthetic correction'}),422,'validation.schema','provenance_disclosure_required');
  });
  await t.test('a kind changed before release binds nothing: the floor is what readers were shown',async()=>{
    const piece=await create();
    const view=await workspace(piece.id);
    ok(await c.writer.post('/v1/provenance/declarations',{declaration:{binding:view.binding,expectedRevision:0,kind:'generated',roles:['editorial_illustrator'],evidence:'human_declaration',original:null,reason:'Synthetic first thought'}}),201);
    const second=await declare(piece.id);ok(await credit(second.record!.id),201);
    ok(await c.writer.post(`/v1/publications/${piece.id}/publish`,{expectedRevision:piece.revision,scheduledFor:null}));
    const corrected=draft({body:'Synthetic body corrected under the released kind.',assistantAssisted:true});
    ok(await c.writer.post(`/v1/provenance/publications/${piece.id}/correction-draft`,{expectedRevision:(await workspace(piece.id)).publicationRevision,draft:corrected,note:'Synthetic correction'}));
    const prepared=await declare(piece.id);
    assert.equal(prepared.record?.kind,'ai_assisted');
  });
  await t.test('what counts as keeping a disclosure, over every pair of kinds',async()=>{
    const kinds=['none','ai_assisted','machine_translation','generated'];
    const kept:Record<string,string[]>={none:kinds,ai_assisted:['ai_assisted','machine_translation','generated'],machine_translation:['machine_translation'],generated:['generated']};
    for(const prior of kinds)for(const next of kinds){
      const answer:{rows:{kept:boolean}[]}=await h.db.admin.query('SELECT trustwork.provenance_disclosure_kept($1,$2) AS kept',[prior,next]);
      assert.equal(answer.rows[0]!.kept,kept[prior]!.includes(next),`${prior} -> ${next}`);
    }
  });
  await t.test('a blocked scheduled piece stays unpublished, is recorded once and holds nothing else back',async()=>{
    await withMaintenance(h.db.admin,trx=>trx.updateTable('publication').set({scheduled_for:new Date(Date.now()-1000)}).where('id','in',[scheduled.id,unaffected.id]).execute());
    assert.equal(await withMaintenance(h.db.admin,trx=>contentWorker.publishDue(trx)),1);
    assert.equal(await withMaintenance(h.db.admin,trx=>contentWorker.publishDue(trx)),0);
    assert.equal((await workspace(scheduled.id)).status,'scheduled');
    expectRefusal(await anonymous.get(`/v1/publications/${scheduled.id}`),404,'access.not_found');
    ok(await anonymous.get(`/v1/publications/${unaffected.id}`));
    const blocked=await withMaintenance(h.db.admin,trx=>trx.selectFrom('audit_event').select(['reason']).where('object_id','=',scheduled.id).where('action','=','publication.schedule_blocked').execute());
    assert.deepEqual(blocked.map(b=>b.reason),['content.provenance_original_unavailable']);
  });
  await t.test('retracted original withholds translation on detail, pinned version and feed',async()=>{
    originalView=await workspace(original.id);
    ok(await c.writer.post(`/v1/publications/${original.id}/retract`,{expectedRevision:originalView.publicationRevision,note:'Synthetic retraction'}));
    expectRefusal(await anonymous.get(`/v1/publications/${translation.id}`),404,'access.not_found');
    expectRefusal(await anonymous.get(`/v1/publications/${translation.id}/versions/1`),404,'access.not_found');
    const feed=ok<{items:{id:string}[]}>(await anonymous.get('/v1/publications'));assert.equal(feed.items.some(i=>i.id===translation.id),false);
  });
});
