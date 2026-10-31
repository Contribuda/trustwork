import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { ConfigureRepresentativeCommandSchema, ConfirmGoalCommandSchema, CreateGoalCommandSchema, CreateJobSubscriptionCommandSchema, GoalEvidenceCommandSchema, GoalStatusCommandSchema, GrantCompanyMandateCommandSchema, JobSubscriptionStatusCommandSchema, ReconfirmCompanyMandateCommandSchema, ResolveEscalationCommandSchema, RevisionCommandSchema, SendEnvelopeCommandSchema, ShareReportCommandSchema } from './contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import { EnvelopesService } from './envelopes.service.js';
import { GoalsService } from './goals.service.js';
import { RepresentativeService } from './representative.service.js';

type P<T extends z.ZodType> = z.infer<T>;
const IdParams = z.strictObject({ id: IdSchema });
const CompanyMandateParams = z.strictObject({ id: IdSchema, mandateId: IdSchema });

/**
 * Goals, job subscriptions, reports, escalations and agent-to-agent envelopes of the person's one agent, under
 * `/v1/assistant` (AGT-001). Governance (confirming a goal and its mandate changes) is step-up and takes the digest the
 * person was shown; the agent side (envelopes, evidence) acts only under mandates; bodies are strict.
 */
@Controller('v1/assistant')
export class AgentsController {
  constructor(@Inject(GoalsService) private readonly goals: GoalsService, @Inject(EnvelopesService) private readonly envelopes: EnvelopesService,
    @Inject(RepresentativeService) private readonly representatives: RepresentativeService) {}

  @Get('goals') @Authenticated()
  listGoals(@ReqState() state: RequestState) { return this.goals.listGoals(state); }

  @Post('goals') @HttpCode(201) @Authenticated() @Idempotent('agents.goal_create')
  createGoal(@Body(CreateGoalCommandSchema) body: P<typeof CreateGoalCommandSchema>, @ReqState() state: RequestState) { return this.goals.createGoal(body, state); }

  @Get('goals/:id') @Authenticated()
  getGoal(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.goals.getGoal(params.id, state); }

  @Get('goals/:id/confirmation') @Authenticated()
  confirmation(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.goals.getConfirmation(params.id, state); }

  @Post('goals/:id/confirm') @HttpCode(200) @Authenticated('step_up') @Idempotent('agents.goal_confirm', 'id')
  confirmGoal(@Params(IdParams) params: P<typeof IdParams>, @Body(ConfirmGoalCommandSchema) body: P<typeof ConfirmGoalCommandSchema>, @ReqState() state: RequestState) {
    return this.goals.confirmGoal(params.id, body, state);
  }

  @Post('goals/:id/status') @HttpCode(200) @Authenticated() @Idempotent('agents.goal_status', 'id')
  goalStatus(@Params(IdParams) params: P<typeof IdParams>, @Body(GoalStatusCommandSchema) body: P<typeof GoalStatusCommandSchema>, @ReqState() state: RequestState) {
    return this.goals.setGoalStatus(params.id, body, state);
  }

  @Post('goals/:id/progress') @HttpCode(201) @Authenticated() @Idempotent('agents.goal_evidence', 'id')
  evidence(@Params(IdParams) params: P<typeof IdParams>, @Body(GoalEvidenceCommandSchema) body: P<typeof GoalEvidenceCommandSchema>, @ReqState() state: RequestState) {
    return this.goals.recordEvidence(params.id, body, state);
  }

  @Post('goals/:id/report') @HttpCode(201) @Authenticated() @Idempotent('agents.goal_report', 'id')
  report(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.goals.generateReport(params.id, state); }

  @Get('reports') @Authenticated()
  reports(@ReqState() state: RequestState) { return this.goals.listReports(state); }

  @Post('reports/:id/share') @HttpCode(200) @Authenticated() @Idempotent('agents.report_share', 'id')
  share(@Params(IdParams) params: P<typeof IdParams>, @Body(ShareReportCommandSchema) body: P<typeof ShareReportCommandSchema>, @ReqState() state: RequestState) {
    return this.goals.shareReport(params.id, body, state);
  }

  @Get('job-subscriptions') @Authenticated()
  subscriptions(@ReqState() state: RequestState) { return this.goals.listJobSubscriptions(state); }

  @Post('job-subscriptions') @HttpCode(201) @Authenticated() @Idempotent('agents.job_subscription_create')
  subscribe(@Body(CreateJobSubscriptionCommandSchema) body: P<typeof CreateJobSubscriptionCommandSchema>, @ReqState() state: RequestState) { return this.goals.createJobSubscription(body, state); }

  @Post('job-subscriptions/:id/status') @HttpCode(200) @Authenticated() @Idempotent('agents.job_subscription_status', 'id')
  subscriptionStatus(@Params(IdParams) params: P<typeof IdParams>, @Body(JobSubscriptionStatusCommandSchema) body: P<typeof JobSubscriptionStatusCommandSchema>, @ReqState() state: RequestState) {
    return this.goals.setJobSubscriptionStatus(params.id, body, state);
  }

  @Get('escalations') @Authenticated()
  escalations(@ReqState() state: RequestState) { return this.goals.listEscalations(state); }

  @Post('escalations/:id/resolve') @HttpCode(200) @Authenticated() @Idempotent('agents.escalation_resolve', 'id')
  resolve(@Params(IdParams) params: P<typeof IdParams>, @Body(ResolveEscalationCommandSchema) body: P<typeof ResolveEscalationCommandSchema>, @ReqState() state: RequestState) {
    return this.goals.resolveEscalation(params.id, body, state);
  }

  @Get('envelopes') @Authenticated()
  listEnvelopes(@ReqState() state: RequestState) { return this.envelopes.listEnvelopes(state); }

  @Post('envelopes') @HttpCode(200) @Authenticated() @Idempotent('agents.envelope_send')
  send(@Body(SendEnvelopeCommandSchema) body: P<typeof SendEnvelopeCommandSchema>, @ReqState() state: RequestState) { return this.envelopes.send(body, state); }

  @Get('negotiations') @Authenticated()
  negotiations(@ReqState() state: RequestState) { return this.envelopes.listNegotiations(state); }

  @Get('negotiations/:id') @Authenticated()
  negotiation(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.envelopes.getNegotiation(params.id, state); }

  @Get('company-mandates') @Authenticated()
  myCompanyMandates(@ReqState() state: RequestState) { return this.representatives.myCompanyMandates(state); }
}

/**
 * The company's one representative and its company mandates on the company page, under `/v1/companies/:id`. Enabling,
 * accepting, resuming, granting and re-confirming are step-up; suspending is instant and never needs step-up.
 */
@Controller('v1/companies')
export class CompanyRepresentativeController {
  constructor(@Inject(RepresentativeService) private readonly representatives: RepresentativeService) {}

  @Get(':id/representative') @Authenticated()
  view(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.representatives.view(params.id, state); }

  @Post(':id/representative') @HttpCode(200) @Authenticated('step_up') @Idempotent('agents.representative_configure', 'id')
  configure(@Params(IdParams) params: P<typeof IdParams>, @Body(ConfigureRepresentativeCommandSchema) body: P<typeof ConfigureRepresentativeCommandSchema>, @ReqState() state: RequestState) {
    return this.representatives.configure(params.id, body, state);
  }

  @Post(':id/representative/accept') @HttpCode(200) @Authenticated('step_up') @Idempotent('agents.representative_accept', 'id')
  accept(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.representatives.accept(params.id, state); }

  @Post(':id/representative/suspend') @HttpCode(200) @Authenticated() @Idempotent('agents.representative_suspend', 'id')
  suspend(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.representatives.suspend(params.id, state); }

  @Post(':id/representative/resume') @HttpCode(200) @Authenticated('step_up') @Idempotent('agents.representative_resume', 'id')
  resume(@Params(IdParams) params: P<typeof IdParams>, @Body(RevisionCommandSchema) body: P<typeof RevisionCommandSchema>, @ReqState() state: RequestState) {
    return this.representatives.resume(params.id, body, state);
  }

  @Post(':id/representative/disable') @HttpCode(200) @Authenticated('step_up') @Idempotent('agents.representative_disable', 'id')
  disable(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.representatives.disable(params.id, state); }

  @Get(':id/agent-mandates') @Authenticated()
  list(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) { return this.representatives.listCompanyMandates(params.id, state); }

  @Post(':id/agent-mandates') @HttpCode(201) @Authenticated('step_up') @Idempotent('agents.company_mandate_grant', 'id')
  grant(@Params(IdParams) params: P<typeof IdParams>, @Body(GrantCompanyMandateCommandSchema) body: P<typeof GrantCompanyMandateCommandSchema>, @ReqState() state: RequestState) {
    return this.representatives.grant(params.id, body, state);
  }

  @Post(':id/agent-mandates/:mandateId/reconfirm') @HttpCode(200) @Authenticated('step_up') @Idempotent('agents.company_mandate_reconfirm', 'mandateId')
  reconfirm(@Params(CompanyMandateParams) params: P<typeof CompanyMandateParams>, @Body(ReconfirmCompanyMandateCommandSchema) body: P<typeof ReconfirmCompanyMandateCommandSchema>, @ReqState() state: RequestState) {
    return this.representatives.reconfirm(params.id, params.mandateId, body, state);
  }

  @Post(':id/agent-mandates/:mandateId/revoke') @HttpCode(200) @Authenticated() @Idempotent('agents.company_mandate_revoke', 'mandateId')
  revoke(@Params(CompanyMandateParams) params: P<typeof CompanyMandateParams>, @Body(RevisionCommandSchema) body: P<typeof RevisionCommandSchema>, @ReqState() state: RequestState) {
    return this.representatives.revoke(params.id, params.mandateId, body, state);
  }
}
