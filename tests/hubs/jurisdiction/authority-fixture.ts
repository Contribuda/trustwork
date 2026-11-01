import { syntheticSourceAuthority } from './source-fixture.js';
import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import { computeDigest, computeRfqVersionDigest } from '@trustwork/contracts';
import { legalActivationDigestInput, configActivationDigestInput } from '../../../packages/contracts/src/hub-core.js';
import { JurisdictionSourceSchema, type ExecutableJurisdictionPayload } from '../../../packages/contracts/src/jurisdiction.js';
import { jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { hubConfig, legalDocuments } from '../../../packages/data/src/repositories/hubs.js';
import { rfqs, rfqVersions, rfqInvitations } from '../../../packages/data/src/repositories/commerce.js';
import { quotes } from '../../../packages/data/src/repositories/transactions.js';
import { actors, buildHubWorld, syncKernel, US_HUB, type HubWorld } from '../helpers.js';
import { LOCALES, syntheticSettings } from './fixtures.js';

export function sourceDocument(jurisdiction = 'US', version = 'synthetic-1') {
  return JurisdictionSourceSchema.parse({
    schemaVersion: 2, jurisdiction, ancestors: [], version, effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: '2099-01-01T00:00:00.000Z',
    verification: 'official', counsel: { status: 'reviewed', reviewId: 'synthetic.review', evidenceDigest: 'a'.repeat(64), reviewedAt: '2020-01-01T00:00:00.000Z' },
    provenance: [{ packCode: jurisdiction.slice(0,2), packVersion: version, factKey: 'synthetic.rule', url: 'https://example.invalid/synthetic-only', accessed: '2020-01-01', contentDigest: 'b'.repeat(64) }],
    mandatoryAreas: ['agent_disclosure','liability_allocation','consent','record_keeping','action_limits','legal_texts'], advisoryAreas: [],
    policy: syntheticSettings(jurisdiction).policy,
  });
}
export async function authorityFixture(admin: DataPool, runtime: DataPool, shared?: { world: HubWorld; a: ReturnType<typeof actors> }, completeLanguages = false) {
  await syncKernel(admin);
  const world = shared?.world ?? await buildHubWorld(admin); const p = world.people; const base = shared?.a ?? actors(admin,runtime,world);
  const sessionOf = (person: string) => world.sessions[(Object.keys(p) as Array<keyof typeof p>).find(k => p[k] === person)!];
  const a = { ...base,
    elevate: async (person: string, seconds?: number) => ({ ...await base.elevate(person, seconds), sessionId: sessionOf(person) }),
    cmd: <T>(person: string, fn: Parameters<typeof base.cmd<T>>[1]) => base.cmd(person, (trx, ctx) => fn(trx, Object.assign(ctx, { sessionId: sessionOf(person) }))),
  };
  await a.assignSensitive({ personId:p.operator,role:'node-operator',scope:{kind:'node',nodeId:world.nodeId} });
  const hubId=(await a.createHub('synthetic-authority',completeLanguages ? { ...US_HUB, locales: LOCALES, name: Object.fromEntries(LOCALES.map(locale => [locale, 'Synthetic authority hub'])) } : US_HUB)).hub_id;
  const otherHubId=(await a.createHub('synthetic-foreign-authority',US_HUB)).hub_id;
  await a.assignSensitive({ personId:p.owner,role:'hub-owner',scope:{kind:'hub',hubId} });
  await a.assignSensitive({ personId:p.officer,role:'compliance-officer',scope:{kind:'hub',hubId} });
  await a.assignSensitive({ personId:p.otherOwner,role:'hub-owner',scope:{kind:'hub',hubId:otherHubId} });
  await a.assign({personId:p.moderator,role:'moderator',scope:{kind:'hub',hubId}});
  const legal = async (locale: string) => {
    const d=await a.cmd(p.owner,(trx,ctx)=>legalDocuments.draft(trx,ctx,hubId,{kind:'agent_jurisdiction',locale,body:`Synthetic machinery fixture only; no legal advice or country policy (${locale}).`}));
    const c=await a.cmd(p.owner,(trx,ctx)=>legalDocuments.recordCounselApproval(trx,ctx,hubId,{documentVersionIds:[d.id],counselName:'Synthetic test counsel',firm:'Synthetic test firm',approvedOn:'2020-01-01',scopeNote:'Synthetic machinery fixture only'}));
    const approval=await a.approve(p.officer,p.owner,'legal.activate_document_version',hubId,legalActivationDigestInput({id:d.id,hubId,kind:'agent_jurisdiction',locale,version:d.version,bodyDigest:d.body_digest,counselApprovalId:c.id}));
    return a.cmd(p.officer,(trx,ctx)=>legalDocuments.activate(trx,ctx,d.id,d.revision,approval));
  };
  const docs=[];
  for (const locale of completeLanguages ? LOCALES : ['en', 'es']) docs.push(await legal(locale));
  const document=sourceDocument();
  const source=await withMaintenance(admin,trx=>jurisdictionEvidence.importSource(trx,document));
  const payload: ExecutableJurisdictionPayload={addedRestrictedPlaces:[],agentSettings:{schemaVersion:2,jurisdictions:[{
    jurisdiction:'US',sourceId:source.id,sourceRevision:source.revision,sourceDigest:source.digest,policy:document.policy,
    legalBindings:docs.flatMap(d=>['synthetic.agentDisclosure','synthetic.agentTerms','synthetic.principalLiability','synthetic.electronicRecords'].map(key=>({key,locale:d.locale,documentId:d.id,bodyDigest:d.body_digest,counselApprovalId:d.counsel_approval_id!}))),
  }]}};
  const draft=(body: ExecutableJurisdictionPayload|Record<string,unknown> = payload)=>a.cmd(p.owner,(trx,ctx)=>hubConfig.draft(trx,ctx,hubId,'jurisdiction',body));
  const approvalFor=async(v:Awaited<ReturnType<typeof draft>>)=>a.approve(p.officer,p.owner,'jurisdiction.activate_settings',hubId,configActivationDigestInput({id:v.id,hubId,domain:'jurisdiction',version:v.version,payloadDigest:v.payload_digest}));
  const activate=async(v:Awaited<ReturnType<typeof draft>>)=>{const ap=await approvalFor(v);return a.cmd(p.officer,(trx,ctx)=>hubConfig.activate(trx,ctx,v.id,v.revision,ap));};
  let producer: ReturnType<typeof syntheticSourceAuthority> | undefined;
  const attest = async (kind: 'person' | 'company' | 'project', id: string, jurisdictions = ['US'], hub = hubId) => {
    if (hub !== hubId) throw new Error('synthetic source fixture requires its registered exact hub');
    producer ??= syntheticSourceAuthority(admin, { a, p, world, hubId });
    const sourceAuthority = await producer;
    const contexts = await admin.query<{ id: string }>(`SELECT q.id FROM trustwork.quote q JOIN trustwork.rfq r ON r.id=q.rfq_id
      WHERE ($1='project' AND r.project_id=$2::uuid) OR ($1='person' AND $2::uuid IN(q.buyer_person_id,q.seller_person_id))
        OR ($1='company' AND $2::uuid IN(q.buyer_company_id,q.seller_company_id)) ORDER BY q.id`, [kind, id]);
    if (!contexts.rowCount) throw new Error('synthetic source fixture requires a real owning quote');
    const results = [];
    for (const context of contexts.rows) results.push(await sourceAuthority.issue(kind, id, context.id, jurisdictions));
    return results[0]!;
  };
  return {a,p,world,hubId,otherHubId,source,document,payload,docs,legal,draft,activate,approvalFor,attest};
}

/** Real project -> published RFQ -> invitation -> draft quote; no trigger disabling or mocked party authority. */
export async function createQuote(as:<T>(personId:string,fn:(trx:Transaction)=>Promise<T>)=>Promise<T>,buyer:string,seller:string) {
  const project=await as(buyer,trx=>trx.insertInto('project').values({owner_person_id:buyer,owner_company_id:null,creator_person_id:buyer,leader_person_id:null,name:'Synthetic jurisdiction project',summary:null,publicity_enabled:false,published_story:null,private_notes:null}).returning('id').executeTakeFirstOrThrow());
  const published=await as(buyer,async trx=>{
    const rfq=await rfqs.insert(trx,{owner_person_id:buyer,owner_company_id:null,project_id:project.id,creator_person_id:buyer,need_id:null,plan_project_id:null,plan_item_key:null,public_projection_enabled:false,public_projection_fields:[],category:null});
    const payload={title:'Synthetic jurisdiction RFQ',currency:'USD',responseDeadline:'2099-02-15T17:00:00.000Z',attachments:[],paymentTermsRequested:null,acceptanceCriteria:'Synthetic acceptance',deliveryTerms:{location:{region:'US-CA'},window:{from:{date:'2099-03-01',timeZone:'America/Los_Angeles'},to:{date:'2099-03-31',timeZone:'America/Los_Angeles'}}},lines:[{lineId:'synthetic',kind:'goods',description:'Synthetic goods',specification:{},quantity:{value:'1',unit:'m2'},alternativesAllowed:false}]};
    const v=await rfqVersions.insertDraft(trx,{rfq_id:rfq.id,version:1,payload,drafted_by_person_id:buyer,amendment_reason:null});
    await rfqVersions.publish(trx,v.id,{digest:computeRfqVersionDigest(payload as never).value,personId:buyer,via:'person',mandateId:null,amendmentReason:null,at:new Date()});
    await rfqs.setCurrent(trx,rfq.id,{current_version:1,current_version_id:v.id});
    const inv=await rfqInvitations.insert(trx,{rfq_id:rfq.id,rfq_version_id:v.id,party_person_id:seller,party_company_id:null,channel:'platform',sent_by_person_id:buyer,sent_via:'person',sent_by_mandate_id:null,revalidates_invitation_id:null});
    return {rfq,inv};
  });
  const quote=await as(seller,trx=>quotes.insert(trx,{rfq_id:published.rfq.id,seller_person_id:seller,seller_company_id:null,invitation_id:published.inv.id,creator_person_id:seller}));
  return {quoteId:quote.id,projectId:project.id};
}
export { computeDigest };
