import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../../apps/api/src/app.js';
import { Client, type Harness, type Response } from '../../backend/helpers/app.js';
import { signIn } from '../../admin/helpers.js';
import type { OwnerPlanView, PlanVersion } from '../../../packages/contracts/src/plans.js';
import type { OwnerTaskRequestView, OfferorTaskOfferView } from '../../../packages/contracts/src/tasks.js';

export const taskPerson = { via: 'person' } as const;
export const taskConsent = { consented: true, disclosureKey: 'trustwork.electronic-records.v1' } as const;
export function taskOk<T>(r: Response, status = 200): T { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body as T; }
export async function taskFixture(h: Harness, input: { buyerId: string; sellerId: string; buyerEmail: string; sellerEmail: string; hubA: string; hubB: string; buyerClient?: Client; sellerClient?: Client }) {
  const makeApp = (hub: string) => createApp({ env: { API_HOST:'127.0.0.1',API_PORT:'0',PUBLIC_ORIGIN:`https://${hub}.test`,TRUSTWORK_HUB_ID:hub,MAIL_SECRET_KEY:randomBytes(32).toString('hex') }, pool:h.pool,clock:h.clock,logSink:line=>{ if(line.includes('"level":"error"')) console.error(line); } });
  const buyerApp=await makeApp(input.hubA), sellerApp=await makeApp(input.hubB);
  const buyer=input.buyerClient ?? new Client(buyerApp), seller=input.sellerClient ?? new Client(sellerApp), wrongHub=new Client(sellerApp), anonymous=new Client(buyerApp);
  if (!input.buyerClient) await signIn(buyer,input.buyerEmail);
  if (!input.sellerClient) await signIn(seller,input.sellerEmail);
  if (!input.buyerClient) await signIn(wrongHub,input.buyerEmail);
  const prepare=async()=>{
    const project=taskOk<{id:string}>(await buyer.post('/v1/projects',{owner:{kind:'person',id:input.buyerId},name:'Synthetic fee task '+randomUUID(),summary:null,leaderPersonId:null}),201);
    const path=`/v1/projects/${project.id}/plan`;
    const plan=taskOk<OwnerPlanView>(await buyer.post(path,{timeZone:'UTC',actor:taskPerson,content:{summary:'Synthetic private planning notes',assumptions:[],budget:null,timeline:null,dependencies:[],items:[{
      key:'synthetic-work',kind:'task',parentKey:null,title:'Synthetic work',description:'Synthetic scope',stepTerms:['work.envelope.roofing'],requiredSkills:[],quantity:null,estimate:null,duration:null,window:null,riskLevel:null,
      decisionQuestion:null,sources:[],attachments:[],privateNotes:'Synthetic PRIVATE task note',
    }]}}),201);
    const proposed=taskOk<PlanVersion>(await buyer.post(`${path}/versions/${plan.draft!.id}/propose`,{expectedRevision:plan.draft!.revision,actor:taskPerson}));
    taskOk(await buyer.post(`${path}/versions/${plan.draft!.id}/approve`,{expectedRevision:proposed.revision,digest:proposed.digest}));
    let request=taskOk<OwnerTaskRequestView>(await buyer.post('/v1/task-requests',{source:{projectId:project.id,itemKey:'synthetic-work'},audience:'invited',actor:taskPerson,
      terms:{title:'Synthetic fee task',fields:['scope'],scopeNote:'Synthetic scope',milestoneItemKeys:['synthetic-work'],acceptanceCriteria:['Synthetic completion'],responseDeadline:'2029-02-01T00:00:00Z',currency:'USD'},
      privateConstraint:{budgetCeiling:{minorUnits:'50000',currency:'USD'},ownerNotes:'Synthetic PRIVATE buyer limit'},
    }),201);
    request=taskOk<OwnerTaskRequestView>(await buyer.post(`/v1/task-requests/${request.request.id}/publish`,{version:1,expectedRevision:request.request.revision,amendmentReason:null,actor:taskPerson}));
    taskOk(await buyer.post(`/v1/task-requests/${request.request.id}/invitations`,{party:{kind:'person',id:input.sellerId},actor:taskPerson}),201);
    let offered=taskOk<OfferorTaskOfferView>(await seller.post('/v1/task-offers',{taskRequestId:request.request.id,requestVersionId:request.request.currentVersionId,offeror:{kind:'person',id:input.sellerId},actor:taskPerson,
      privateConstraint:{floorPrice:{minorUnits:'9000',currency:'USD'},offerorNotes:'Synthetic PRIVATE seller limit'},payload:{price:{minorUnits:'10000',currency:'USD'},start:'2029-03-01',durationDays:1,exclusions:[],validUntil:'2029-02-01T00:00:00Z',note:'Synthetic fee offer',
      milestones:[{key:'synthetic-completion',title:'Synthetic completion',planItemKey:'synthetic-work',amount:{minorUnits:'10000',currency:'USD'},due:'2029-03-01'}]},
    }),201);
    offered=taskOk<OfferorTaskOfferView>(await seller.post(`/v1/task-offers/${offered.versions[0]!.id}/send`,{expectedRevision:offered.versions[0]!.revision,actor:taskPerson}));
    request=taskOk<OwnerTaskRequestView>(await buyer.get(`/v1/task-requests/${request.request.id}`));
    const offer=offered.versions[0]!; const version=request.versions[0]!;
    const accept={offer:{id:offer.id,version:offer.version,digest:offer.digest!},requestVersion:{id:version.id,version:version.version,digest:version.digest!},expectedRevision:request.request.revision,electronicRecords:taskConsent,actor:taskPerson};
    return {request,offer,accept,url:`/v1/task-requests/${request.request.id}/acceptances`,disclose:`/v1/billing/fees/task-offers/${offer.id}/disclosures`};
  };
  return {buyer,seller,wrongHub,anonymous,prepare,close:async()=>{await buyerApp.close();await sellerApp.close();}};
}
