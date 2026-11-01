import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { buildContentHttpWorld, ok, expectRefusal } from '../content/http.js';
import { draft } from '../content/helpers.js';
import { ProvenanceWorkspaceSchema, PublicPublicationSchema } from '../../packages/contracts/src/client.js';
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
  const original=await create();
  await t.test('legacy publish and schedule refuse absent provenance',async()=>{
    for(const scheduledFor of [null,'2099-01-01T00:00:00.000Z']) expectRefusal(await c.writer.post(`/v1/publications/${original.id}/publish`,{expectedRevision:original.revision,scheduledFor}),422,'validation.schema','provenance_required');
    expectRefusal(await c.outsider.get(`/v1/provenance/publications/${original.id}`),404,'access.not_found');
  });
  let originalView=await declare(original.id);
  await t.test('actual publish preserves exact immutable binding and no inferred credit',async()=>{
    ok(await c.writer.post(`/v1/publications/${original.id}/publish`,{expectedRevision:original.revision,scheduledFor:null}));
    const publicView=PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${original.id}`)));
    assert.equal(publicView.current.contentDigest,originalView.binding.digest.value);
    assert.equal(publicView.current.provenance?.availability,'recorded');
    if(publicView.current.provenance?.availability==='recorded')assert.deepEqual(publicView.current.provenance.credits,{});
  });
  await t.test('web-only consent never appears in feed or PDF channel; withdrawal is immediate',async()=>{
    const body={provenanceId:originalView.record!.id,role:'responsible_editor',credit:'Synthetic Writer',channels:['web'],noticeVersion:'provenance.credit.v1',informedConsent:true};
    expectRefusal(await c.coauthor.post('/v1/provenance/consents',body),404,'access.not_found');
    const consent=ok<{consentId:string}>(await c.writer.post('/v1/provenance/consents',body),201);
    for(const channel of ['web','feed','pdf']) {
      const response=await anonymous.get(`/v1/publications/${original.id}?channel=${channel}`);
      const p=PublicPublicationSchema.parse(ok(response)).current.provenance;
      assert.equal(p?.availability,'recorded');if(p?.availability==='recorded')assert.equal(p.credits.responsible_editor,channel==='web'?'Synthetic Writer':undefined);
      assert.match(response.headers['cache-control']??'',/no-store/);
    }
    expectRefusal(await c.coauthor.post('/v1/provenance/revocations',{consentId:consent.consentId,reason:'Synthetic withdrawal'}),404,'access.not_found');
    ok(await c.writer.post('/v1/provenance/revocations',{consentId:consent.consentId,reason:'Synthetic withdrawal'}));
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
    translationView=await workspace(translation.id);
    ok(await c.writer.post(`/v1/publications/${translation.id}/publish`,{expectedRevision:translationView.publicationRevision,scheduledFor:null}));
  });
  await t.test('correction prepares, declares and releases exact content without mutating original digest',async()=>{
    originalView=await workspace(original.id);const corrected=draft({body:'Synthetic corrected body.',assistantAssisted:true});
    expectRefusal(await c.writer.post(`/v1/publications/${original.id}/corrections`,{expectedRevision:originalView.publicationRevision,draft:corrected,note:'Synthetic correction',reason:'Synthetic correction'}),422,'validation.schema','provenance_required');
    ok(await c.writer.post(`/v1/provenance/publications/${original.id}/correction-draft`,{expectedRevision:originalView.publicationRevision,draft:corrected,note:'Synthetic correction'}));
    originalView=await declare(original.id);
    ok(await c.writer.post(`/v1/publications/${original.id}/corrections`,{expectedRevision:originalView.publicationRevision,draft:corrected,note:'Synthetic correction',reason:'Synthetic correction'}),201);
    const pinned=ok<{contentDigest:string}>(await anonymous.get(`/v1/publications/${original.id}/versions/1`));
    assert.equal(pinned.contentDigest,translationView.record!.original!.digest.value);
    const p=PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${translation.id}`))).current.provenance;
    assert.equal(p?.availability,'recorded');if(p?.availability==='recorded'){assert.equal(p.translation?.stale,true);assert.equal(p.translation?.originalDigest,pinned.contentDigest);}
  });
  await t.test('retracted original withholds translation on detail, pinned version and feed',async()=>{
    originalView=await workspace(original.id);
    ok(await c.writer.post(`/v1/publications/${original.id}/retract`,{expectedRevision:originalView.publicationRevision,note:'Synthetic retraction'}));
    expectRefusal(await anonymous.get(`/v1/publications/${translation.id}`),404,'access.not_found');
    expectRefusal(await anonymous.get(`/v1/publications/${translation.id}/versions/1`),404,'access.not_found');
    const feed=ok<{items:{id:string}[]}>(await anonymous.get('/v1/publications'));assert.equal(feed.items.some(i=>i.id===translation.id),false);
  });
});
