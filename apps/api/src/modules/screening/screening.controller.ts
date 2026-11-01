import { appealAssignment, reassignScreeningAppeal, ReassignScreeningAppealCommandSchema } from './appeal-assignment.js';
import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { auditEvents } from '../../deps/data.js';
import { PrincipalService } from '../identity/principal.service.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import {
  AppealComplianceDecisionCommandSchema, ConfirmScreeningMatchCommandSchema, DecideScreeningAppealCommandSchema, DecideScreeningProposalCommandSchema, ownComplianceStatus,
  ProposeNotSamePersonCommandSchema, ReviewServiceLevelSchema, REVIEW_SERVICE_LEVEL_BOUNDS, screeningStaff, screeningSubjects, type ScreeningReportDraftRow,
} from './deps.js';
import { screeningRefusal } from './errors.js';

const UuidParams = z.strictObject({ id: z.uuid() });
const OwnQuery = z.strictObject({ companyId: z.uuid().optional() });
const QueueQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(2000).optional() });

/** The hub's review service level in business days (engine bounds one to five; default one). */
export function reviewServiceLevel(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.SCREENING_REVIEW_SERVICE_LEVEL_DAYS?.trim();
  if (!raw) return REVIEW_SERVICE_LEVEL_BOUNDS.default;
  const parsed = ReviewServiceLevelSchema.safeParse(Number(raw));
  if (!parsed.success) throw new Error(`SCREENING_REVIEW_SERVICE_LEVEL_DAYS must be an integer from ${REVIEW_SERVICE_LEVEL_BOUNDS.min} to ${REVIEW_SERVICE_LEVEL_BOUNDS.max}`);
  return parsed.data;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    screeningRefusal(error);
  }
}

/**
 * The subject's own compliance status (`core.compliance_status`) and the appeal (`core.appeal_compliance_decision`,
 * fresh step-up). The answer is status words only: never a list, an entry, a matched name or a reviewer.
 */
@Controller('v1/screening/me')
@Authenticated()
export class ScreeningSelfController {
  constructor(@Inject(PrincipalService) private readonly principals: PrincipalService) {}

  @Get()
  status(@Query(OwnQuery) query: z.infer<typeof OwnQuery>, @ReqState() state: RequestState) {
    return guarded(() => this.principals.runAs(state, async (trx) => {
      const own = await screeningSubjects.own(trx, query.companyId ?? null);
      return ownComplianceStatus(own.state, own.appealable);
    }));
  }

  @Post('appeal') @HttpCode(200) @Authenticated('step_up') @Idempotent('screening.appeal_file')
  appeal(@Body(AppealComplianceDecisionCommandSchema) body: z.infer<typeof AppealComplianceDecisionCommandSchema>, @ReqState() state: RequestState) {
    return guarded(() => this.principals.runAs(state, async (trx, p) => {
      const appealed = await screeningSubjects.appeal(trx, { companyId: body.companyId, reason: body.reason });
      await auditEvents.append(trx, {
        actor_person_id: p.personId, action: 'screening.appeal_filed', object_kind: body.companyId ? 'company' : 'person', object_id: body.companyId ?? p.personId,
        request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { appealed },
      });
      const own = await screeningSubjects.own(trx, body.companyId);
      return ownComplianceStatus(own.state, own.appealable);
    }));
  }
}

const draftView = (r: ScreeningReportDraftRow) => ({
  id: r.id, matchId: r.match_id, subject: r.subject_person_id ? { kind: 'person', id: r.subject_person_id } : { kind: 'company', id: r.subject_company_id },
  listCode: r.list_code, entryUid: r.entry_uid, programs: r.programs, preparedAt: r.prepared_at.toISOString(),
  dueOn: typeof r.due_on === 'string' ? r.due_on : r.due_on.toISOString().slice(0, 10), status: r.status,
});

/**
 * Compliance staff (ADR 014 decision 14): the review queue (one item per subject, late after the hub service level),
 * matches with the entry and the screened name side by side, report drafts, and the decisions. Behind an elevated
 * session; the database checks the compliance-officer role at the node, refuses the subject, members of the subject
 * company and conflicted reviewers, requires a second person for "not the same person" and reversals, serialises
 * concurrent reviewers and writes the audit row in the same transaction.
 */
@Controller('v1/admin/screening')
@Authenticated()
@UseGuards(ElevationGuard)
export class ScreeningStaffController {
  private readonly serviceLevelDays = reviewServiceLevel();
  constructor(@Inject(PrincipalService) private readonly principals: PrincipalService) {}

  @Get('queue')
  queue(@Query(QueueQuery) query: z.infer<typeof QueueQuery>, @ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => ({
      serviceLevelDays: this.serviceLevelDays,
      items: await screeningStaff.queue(trx, { serviceLevelDays: this.serviceLevelDays, now: new Date(), ...(query.limit ? { limit: query.limit } : {}) }),
    }));
  }

  @Get('subjects/:id')
  subject(@Params(UuidParams) params: z.infer<typeof UuidParams>, @ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => {
      const row = await screeningStaff.subjectState(trx, params.id);
      if (!row) throw new ApiError('access.not_found');
      const subject = row.subject_person_id ? { kind: 'person' as const, id: row.subject_person_id } : { kind: 'company' as const, id: row.subject_company_id as string };
      return {
        subjectStateId: row.id, subject, moneyHeld: row.money_held, suspended: row.suspended, lastOutcome: row.last_outcome,
        lastScreenedAt: row.last_screened_at?.toISOString() ?? null, matches: await screeningStaff.matchesOf(trx, subject),
      };
    });
  }

  @Get('matches/:id')
  match(@Params(UuidParams) params: z.infer<typeof UuidParams>, @ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => {
      const view = await screeningStaff.match(trx, params.id);
      if (!view) throw new ApiError('access.not_found');
      const decisions = await screeningStaff.decisions(trx, params.id);
      return { match: view, decisions: decisions.map((d) => ({ id: d.id, kind: d.kind, decidedBy: d.decided_by, reason: d.reason, evidence: d.evidence_category, decidedAt: d.decided_at.toISOString() })) };
    });
  }

  @Get('matches/:id/appeal-assignment')
  assignment(@Params(UuidParams) params: z.infer<typeof UuidParams>, @ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => {
      if (!await screeningStaff.match(trx, params.id)) throw new ApiError('access.not_found');
      return { assignment: await appealAssignment(trx, params.id) };
    });
  }

  @Get('report-drafts')
  drafts(@ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => ({ items: (await screeningStaff.reportDrafts(trx)).map(draftView) }));
  }

  @Post('matches/:id/appeal-assignment') @HttpCode(200) @Idempotent('screening.appeal_reassign', 'id')
  reassign(@Params(UuidParams) params: z.infer<typeof UuidParams>, @Body(ReassignScreeningAppealCommandSchema) body: z.infer<typeof ReassignScreeningAppealCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return guarded(() => this.principals.runAs(state, async (trx) => ({
      assignment: await reassignScreeningAppeal(trx, this.ctx(state, elevation, 'screening_appeal_reassigned', body.reason), { matchId: params.id, ...body }),
    })));
  }

  private ctx(state: RequestState, elevation: SessionElevationRow, reasonCode: string, reasonText: string) {
    return { elevationId: elevation.id, requestId: state.requestId, reasonCode, reasonText };
  }

  @Post('matches/:id/confirm') @HttpCode(200) @Idempotent('screening.match_confirm', 'id')
  confirm(@Params(UuidParams) params: z.infer<typeof UuidParams>, @Body(ConfirmScreeningMatchCommandSchema) body: z.infer<typeof ConfirmScreeningMatchCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return guarded(() => this.principals.runAs(state, async (trx) => {
      await screeningStaff.confirm(trx, this.ctx(state, elevation, 'screening_match_confirmed', body.reason), { matchId: params.id, reason: body.reason, evidence: body.evidence });
      return { match: await screeningStaff.match(trx, params.id) };
    }));
  }

  @Post('matches/:id/propose-not-same-person') @HttpCode(200) @Idempotent('screening.match_propose', 'id')
  propose(@Params(UuidParams) params: z.infer<typeof UuidParams>, @Body(ProposeNotSamePersonCommandSchema) body: z.infer<typeof ProposeNotSamePersonCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return guarded(() => this.principals.runAs(state, async (trx) => {
      await screeningStaff.proposeNotSamePerson(trx, this.ctx(state, elevation, 'screening_not_same_person_proposed', body.reason), { matchId: params.id, reason: body.reason, evidence: body.evidence });
      return { match: await screeningStaff.match(trx, params.id) };
    }));
  }

  @Post('matches/:id/proposal-decision') @HttpCode(200) @Idempotent('screening.proposal_decide', 'id')
  decideProposal(@Params(UuidParams) params: z.infer<typeof UuidParams>, @Body(DecideScreeningProposalCommandSchema) body: z.infer<typeof DecideScreeningProposalCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return guarded(() => this.principals.runAs(state, async (trx) => {
      await screeningStaff.decideProposal(trx, this.ctx(state, elevation, `screening_proposal_${body.decision}`, body.reason), { matchId: params.id, decision: body.decision, actionDigest: body.actionDigest, reason: body.reason });
      return { match: await screeningStaff.match(trx, params.id) };
    }));
  }

  @Post('matches/:id/appeal-decision') @HttpCode(200) @Idempotent('screening.appeal_decide', 'id')
  decideAppeal(@Params(UuidParams) params: z.infer<typeof UuidParams>, @Body(DecideScreeningAppealCommandSchema) body: z.infer<typeof DecideScreeningAppealCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return guarded(() => this.principals.runAs(state, async (trx) => {
      await screeningStaff.decideAppeal(trx, this.ctx(state, elevation, `screening_appeal_${body.decision}`, body.reason), { matchId: params.id, decision: body.decision, reason: body.reason, evidence: body.evidence });
      return { match: await screeningStaff.match(trx, params.id) };
    }));
  }
}
