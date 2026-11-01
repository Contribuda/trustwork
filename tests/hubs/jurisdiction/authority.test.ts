import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import { configActivationDigestInput } from '../../../packages/contracts/src/hub-core.js';
import { approvals } from '../../../packages/data/src/repositories/admin.js';
import { hubConfig, hubs } from '../../../packages/data/src/repositories/hubs.js';
import { jurisdictionAuthority, jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { provisionTestDatabase } from '../../data/helpers/postgres.js';
import { rejects } from '../helpers.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';

const db=await provisionTestDatabase('jurisdiction_authority',{weight:2});
test('ADR022 every-writer activation and audience authority on embedded PostgreSQL',{skip:db?false:'PostgreSQL unavailable'},async t=>{
  if(!db)return;
  t.after(()=>db.close()); await db.migrate();await db.createAppLogin();
  const f=await authorityFixture(db.admin,db.app);const {a,p,payload,hubId}=f;
  await t.test('source assertions require owner-module import; immutable even for maintenance',async()=>{
    await rejects(a.as(p.owner,trx=>jurisdictionEvidence.importSource(trx,sourceDocument('US','unauthorized'))),'42501');
    await rejects(withMaintenance(db.admin,trx=>trx.updateTable('jurisdiction_source').set({digest:'d'.repeat(64)}).where('id','=',f.source.id).execute()),'23000');
  });
  const version=await f.draft();
  assert.equal((await a.as(p.owner,trx=>jurisdictionAuthority.preflight(trx,version.id))).status,'ready');
  await rejects(a.as(p.outsider,trx=>jurisdictionAuthority.preflight(trx,version.id)),'42501');
  await t.test('outsider, foreign staff, self, missing and mismatched digest approvals refuse',async()=>{
    for(const person of [p.outsider,p.otherOwner,p.moderator,p.owner,p.officer])await rejects(a.cmd(person,(trx,ctx)=>hubConfig.activate(trx,ctx,version.id,version.revision,null)),'42501');
    const wrong=await f.draft();const approval=await f.approvalFor(wrong);
    await assert.rejects(a.cmd(p.officer,(trx,ctx)=>hubConfig.activate(trx,ctx,version.id,version.revision,approval)));
  });
  await t.test('mandatory consent, retention, liability, threshold and immutable legal digest cannot weaken',async()=>{
    const mutations=[
      (x:typeof payload)=>{x.agentSettings.jurisdictions[0]!.policy.consentRequirements=[];},
      (x:typeof payload)=>{x.agentSettings.jurisdictions[0]!.policy.recordKeeping[0]!.minimumDays=0;},
      (x:typeof payload)=>{x.agentSettings.jurisdictions[0]!.policy.liabilityAllocationKey='synthetic.changed';},
      (x:typeof payload)=>{x.agentSettings.jurisdictions[0]!.policy.actionLimits[0]!.approvalAbove!.minorUnits='10001';},
      (x:typeof payload)=>{x.agentSettings.jurisdictions[0]!.legalBindings[0]!.bodyDigest='e'.repeat(64);},
      (x:typeof payload)=>{x.agentSettings.jurisdictions[0]!.legalBindings=x.agentSettings.jurisdictions[0]!.legalBindings.filter(b=>b.locale!=='es');},
    ];
    for(const mutate of mutations){const x=structuredClone(payload);mutate(x);await rejects(f.activate(await f.draft(x)),'23514');}
  });
  await t.test('one exact approval is consumed once by concurrent activations',async()=>{
    const approved=await f.approvalFor(version);
    const results=await Promise.allSettled([1,2].map(()=>a.cmd(p.officer,(trx,ctx)=>hubConfig.activate(trx,ctx,version.id,version.revision,approved))));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  });
  await t.test('legacy removal and direct database writer cannot bypass activation validation',async()=>{
    await rejects(f.activate(await f.draft({addedRestrictedPlaces:[]})),'23514');
    const bad=structuredClone(payload);bad.agentSettings.jurisdictions[0]!.policy.consentRequirements=[];
    const v=await f.draft(bad);const ap=await f.approvalFor(v);
    // Real approval consumption is needed even for maintenance; the attempted direct status write cannot skip it.
    await rejects(withMaintenance(db.admin,trx=>trx.updateTable('hub_config_version').set({status:'active',activated_by:p.officer,activated_at:new Date(),effective_from:new Date(),approval_id:ap}).where('id','=',v.id).execute()),'42501');
    await a.as(p.officer,trx=>approvals.consume(trx,{approvalId:ap,action:'jurisdiction.activate_settings',scope:{kind:'hub',hubId},actionDigest:computeDigest(configActivationDigestInput({id:v.id,hubId,domain:'jurisdiction',version:v.version,payloadDigest:v.payload_digest})).value,ref:v.id}));
    await rejects(withMaintenance(db.admin,trx=>trx.updateTable('hub_config_version').set({status:'active',activated_by:p.officer,activated_at:new Date(),effective_from:new Date(),approval_id:ap}).where('id','=',v.id).execute()),'23514');
  });
  const deal=await createQuote(a.as,p.outsider,p.moderator);
  await t.test('projection does not infer law from address, locale, staff scope or caller default',async()=>{
    assert.equal((await a.as(p.moderator,trx=>jurisdictionAuthority.limits(trx,deal.quoteId,'send_quote'))).status,'unknown');
    for(const actor of [p.owner,p.officer,p.otherOwner,p.outsider])await rejects(a.as(actor,trx=>jurisdictionAuthority.limits(trx,deal.quoteId,'send_quote')),'42501');
    await f.attest('person',p.moderator);await f.attest('person',p.outsider);
    assert.equal((await a.as(p.moderator,trx=>jurisdictionAuthority.limits(trx,deal.quoteId,'send_quote'))).status,'unknown');
    await f.attest('project',deal.projectId);
    const limits=await a.as(p.moderator,trx=>jurisdictionAuthority.limits(trx,deal.quoteId,'send_quote'));
    assert.equal(limits.status,'resolved');assert.equal(limits.approvalAbove[0]!.minorUnits,'10000');
    for(const privateValue of [p.outsider,p.moderator,deal.projectId,'example.invalid','Synthetic test counsel','US-CA'])assert.ok(!JSON.stringify(limits).includes(privateValue));
    await rejects(a.as(p.moderator,trx=>trx.selectFrom('jurisdiction_applicability').selectAll().execute()),'42501');
  });
  await t.test('both parties and project contribute protective limits; incompatible liability refuses',async()=>{
    const gb=sourceDocument('GB');gb.policy.actionLimits[0]!.approvalAbove!.minorUnits='50';
    const src=await withMaintenance(db.admin,trx=>jurisdictionEvidence.importSource(trx,gb));
    const cross=structuredClone(payload);cross.agentSettings.jurisdictions.push({...structuredClone(cross.agentSettings.jurisdictions[0]!),jurisdiction:'GB',sourceId:src.id,sourceRevision:src.revision,sourceDigest:src.digest,policy:gb.policy});
    await f.activate(await f.draft(cross));await f.attest('person',p.outsider,['GB']);
    const limits=await a.as(p.moderator,trx=>jurisdictionAuthority.limits(trx,deal.quoteId,'send_quote'));assert.equal(limits.status,'resolved');assert.equal(limits.approvalAbove[0]!.minorUnits,'50');
    gb.version='synthetic-liability';gb.policy.liabilityAllocationKey='synthetic.differentLiability';
    const changed=await withMaintenance(db.admin,trx=>jurisdictionEvidence.importSource(trx,gb));
    const setting=cross.agentSettings.jurisdictions[1]!;setting.sourceId=changed.id;setting.sourceRevision=changed.revision;setting.sourceDigest=changed.digest;setting.policy=gb.policy;
    setting.legalBindings.push(...setting.legalBindings.filter(b=>b.key==='synthetic.principalLiability').map(b=>({...b,key:'synthetic.differentLiability'})));
    await f.activate(await f.draft(cross));
    assert.equal((await a.as(p.moderator,trx=>jurisdictionAuthority.limits(trx,deal.quoteId,'send_quote'))).status,'unknown');
  });
  await t.test('active settings prevent adding an unbound hub language through the normal profile writer',async()=>{
    const profile=await a.as(p.owner,trx=>hubs.profile(trx,hubId));assert.ok(profile);
    await rejects(a.cmd(p.owner,(trx,ctx)=>hubs.updateProfile(trx,ctx,hubId,profile.revision,{name:{...profile.name,ka:'Synthetic Georgian name'},defaultLocale:'en',locales:['en','es','ka'],currency:'USD',timeZone:profile.time_zone,brandOverlay:null})),'23514');
  });
});
