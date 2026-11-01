import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, type Harness, type RequestOptions, type Response } from '../../backend/helpers/app.js';
import { stateOf } from '../../assistant/helpers.js';
import { PlansService } from '../../../apps/api/src/modules/plans/plans.service.js';
import { FileLicensingFacets } from '../../../apps/api/src/modules/plans/facets.js';
import { NoPlanMandates } from '../../../apps/api/src/modules/plans/mandates.js';
import { TasksService } from '../../../apps/api/src/modules/tasks/tasks.service.js';
import { NoTaskMandates } from '../../../apps/api/src/modules/tasks/mandates.js';
import { ConsultationsService } from '../../../apps/api/src/modules/consultations/consultations.service.js';
import { NoConsultationMandates } from '../../../apps/api/src/modules/consultations/mandates.js';
import { FixedRateCommission, ScreeningCommitmentGate } from '../../../apps/api/src/modules/consultations/ports.js';
import { ConfiguredElectronicRecords } from '../../../apps/api/src/modules/transactions/electronic-records.js';
import * as plans from '../../../packages/contracts/src/plans.js';
import * as tasks from '../../../packages/contracts/src/tasks.js';
import * as consultations from '../../../packages/contracts/src/consultations.js';

/**
 * Explicit pre-fee11 / pre-AGT service construction, only for the historical migration prefix.
 * Actual owning services retain principal RLS, participation, immutable digests and first-party acceptance.
 * The later AGT decorator and fee hooks did not exist at that boundary. No HTTP/product bypass is added.
 * Every intercepted operation asserts the later table is absent, so this client cannot survive the upgrade.
 */
export class PreUpgradeClient extends Client {
  constructor(private readonly h: Harness) { super(h.created); }
  override async request(method: Parameters<Client['request']>[0], url: string, options: RequestOptions = {}): Promise<Response> {
    if (!/^\/v1\/(projects\/[^/]+\/plan|task-|consultation-)/.test(url)) return super.request(method,url,options);
    assert.equal((await this.h.db.admin.query("SELECT to_regclass('trustwork.agent_serving_hub') AS relation")).rows[0].relation,null,'historical construction must stop before upgrade');
    const ctx=this.h.created.ctx!,identity=this.h.services(),state=await stateOf(this.h,this,randomUUID());
    const plan=new PlansService(ctx,identity.principals,identity.participations,new NoPlanMandates(),new FileLicensingFacets());
    const task=new TasksService(ctx,identity.principals,new NoTaskMandates(),new ConfiguredElectronicRecords(),{
      amount:async(_trx,_side,price)=>price,origin:async()=>{},confirm:async()=>{},
    });
    const consultation=new ConsultationsService(ctx,identity.principals,new NoConsultationMandates(),new ConfiguredElectronicRecords(),
      new FixedRateCommission({id:'synthetic-historical-commission',version:1,rateBps:250,fixedFee:null,payer:'expert'}),new ScreeningCommitmentGate());
    const parts=url.split('/'),body=options.body,key=randomUUID();let result:unknown,status=201;
    if(parts[2]==='projects'){
      if(parts.length===5)result=await plan.create(parts[3]!,plans.CreatePlanCommandSchema.parse(body),state);
      else if(parts[7]==='propose'){result=await plan.propose(parts[3]!,parts[6]!,plans.ProposePlanVersionCommandSchema.parse(body),state);status=200;}
      else if(parts[7]==='approve'){result=await plan.approve(parts[3]!,parts[6]!,plans.ApprovePlanVersionCommandSchema.parse(body),state);status=200;}
      else throw new Error('unsupported historical plan operation');
    }else if(parts[2]==='task-requests'){
      if(method==='GET'){result=await task.getRequest(parts[3]!,state);status=200;}
      else if(parts.length===3)result=await task.createRequest(tasks.CreateTaskRequestCommandSchema.parse(body),state);
      else if(parts[4]==='publish'){result=await task.publish(parts[3]!,tasks.PublishTaskRequestCommandSchema.parse(body),state);status=200;}
      else if(parts[4]==='invitations')result=await task.invite(parts[3]!,tasks.InviteTaskOfferorCommandSchema.parse(body),state);
      else if(parts[4]==='acceptances')result=await task.acceptOffer(parts[3]!,tasks.AcceptTaskOfferCommandSchema.parse(body),key,state);
      else throw new Error('unsupported historical task request operation');
    }else if(parts[2]==='task-offers'){
      if(parts.length===3)result=await task.createOffer(tasks.CreateTaskOfferCommandSchema.parse(body),state);
      else if(parts[4]==='send'){result=await task.sendOffer(parts[3]!,tasks.SendTaskOfferCommandSchema.parse(body),state);status=200;}
      else throw new Error('unsupported historical task offer operation');
    }else if(parts[2]==='consultation-offerings')result=await consultation.registerOffering(consultations.RegisterConsultationOfferingCommandSchema.parse(body),state);
    else if(parts[2]==='consultation-requests'){
      if(method==='GET'){result=await consultation.getRequest(parts[3]!,state);status=200;}
      else if(parts.length===3)result=await consultation.createRequest(consultations.CreateConsultationRequestCommandSchema.parse(body),state);
      else if(parts[4]==='proposals')result=await consultation.propose(parts[3]!,consultations.ProposeConsultationCommandSchema.parse(body),state);
      else if(parts[4]==='acceptances')result=await consultation.acceptProposal(parts[3]!,consultations.AcceptProposalCommandSchema.parse(body),key,state);
      else throw new Error('unsupported historical consultation operation');
    }else throw new Error('unsupported historical service operation');
    return {status,body:result,headers:{},cookies:[]};
  }
}
