import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { OAuthService } from './modules/connections/oauth/oauth.service.js';
import { oauthSettingsFromEnv } from './modules/connections/oauth/config.js';
import { legalDocuments } from '../../../packages/data/src/repositories/hubs.js';
import { toAcceptance } from './modules/hubs/views.js';
import { FilesService } from './modules/files/files.service.js';
import { NoFileMandates } from './modules/files/mandates.js';
import type { FilesModuleOptions } from './modules/files/config.js';
import { ConsultationsService } from './modules/consultations/consultations.service.js';
import { NoConsultationMandates } from './modules/consultations/mandates.js';
import { NoPublishedCommission, ScreeningCommitmentGate } from './modules/consultations/ports.js';
import { GoalsService } from './modules/assistant-goals/goals.service.js';
import { reportView, jobSubscriptionView } from './modules/assistant-goals/common.js';
import { ContentService } from './modules/content/content.service.js';
import { ApprovalRoutesService } from './modules/approval-routes/approval-routes.service.js';
import { NoApprovalMandates } from './modules/approval-routes/mandates.js';
import { SupplierBaseService } from './modules/supplier-base/supplier-base.service.js';
import { NoSupplierBaseMandates } from './modules/supplier-base/mandates.js';
import { sanctionsScreening } from './modules/supplier-base/screening.js';
import type { Transaction } from './deps/data.js';
import { toSessionView, type Principal, type ThreadContextRef } from './deps/contracts.js';
import type { RequestState } from './common/request.js';
import type { AppContext } from './modules/identity/context.js';
import type { PrincipalService } from './modules/identity/principal.service.js';
import type { IdentityServices } from './modules/identity/identity.module.js';
import { toPerson, toMembership, toSession } from './modules/identity/serializers.js';
import { persons, emailBindings, credentials, sessions } from '../../../packages/data/src/repositories/identity.js';
import { memberships } from '../../../packages/data/src/repositories/company.js';
import { ExecutionService } from './modules/execution/execution.service.js';
import { NoExecutionMandates } from './modules/execution/mandates.js';
import { TrustService } from './modules/trust/trust.service.js';
import { ReputationService } from './modules/reputation/reputation.service.js';
import { PlansService } from './modules/plans/plans.service.js';
import { NoPlanMandates } from './modules/plans/mandates.js';
import { FileLicensingFacets } from './modules/plans/facets.js';
import { TasksService } from './modules/tasks/tasks.service.js';
import { NoTaskMandates } from './modules/tasks/mandates.js';
import { ConfiguredElectronicRecords } from './modules/transactions/electronic-records.js';
import { CommunicationsService } from './modules/communications/communications.service.js';
import { NoCommsMandates } from './modules/communications/mandates.js';
import { communicationsSettingsFromEnv } from './modules/communications/communications.module.js';
import { exportOwnBilling } from './modules/billing/privacy-export.js';
import type { PrivacySubject } from '../../../packages/contracts/src/privacy.js';

export interface PrivacyOwningPorts {
  compliance(principals: PrincipalService, state: RequestState, subject: PrivacySubject): Promise<unknown>;
  support(principals: PrincipalService): {
    privacyExport(state: RequestState): Promise<unknown>;
  };
}

/** Only composition-root readers; all calls share the download's real principal and locked transaction. */
export async function composeModuleExports(input: {
  ctx: AppContext; identity: IdentityServices; owningPorts: PrivacyOwningPorts; fileOptions: FilesModuleOptions; trx: Transaction; principals: PrincipalService;
  principal: Principal; state: RequestState; subject: PrivacySubject; projectIds: string[]; agreementIds: string[]; communicationContexts: ThreadContextRef[];
}): Promise<Record<string, unknown>> {
  const { ctx, identity, fileOptions, owningPorts, trx, principals, state, subject, projectIds, agreementIds } = input;
  const data: Record<string, unknown> = {};
  const each = async <T, R>(items: readonly T[], read: (item: T) => Promise<R>) => {
    const result: R[] = [];
    for (const item of items) result.push(await read(item));
    return result;
  };
  if (subject.kind === 'person') {
    const person = await persons.getById(trx, subject.id);
    if (!person) throw new Error('export subject disappeared');
    data.identity = { sessions: (await sessions.listForPerson(trx, subject.id)).map((row) => toSessionView(toSession(row))), person: toPerson(person, await emailBindings.listForPerson(trx, subject.id), await credentials.listForPerson(trx, subject.id)),
      memberships: (await trx.selectFrom('membership').selectAll().where('person_id', '=', subject.id).orderBy('created_at').execute()).map(toMembership) };
    data.support = await owningPorts.support(principals).privacyExport(state);
  } else {
    data.companyMemberships = (await memberships.listForCompany(trx, subject.id)).map(toMembership);
  }
  if (subject.kind === 'person') {
    const oauth = new OAuthService(ctx, { ...identity, principals }, oauthSettingsFromEnv(ctx.config), null);
    data.connections = await oauth.privacyExport(state);
    data.hubs = { legalAcceptances: (await legalDocuments.acceptances(trx)).map(toAcceptance) };
  }
  data.screening = await owningPorts.compliance(principals, state, subject);
  if (fileOptions.store) {
    const files = new FilesService(ctx, principals, identity.participations, { store: fileOptions.store, mandates: new NoFileMandates() });
    const artifacts = await trx.selectFrom('evidence_artifact').selectAll().where(subject.kind === 'person' ? 'owner_person_id' : 'owner_company_id', '=', subject.id).orderBy('id').execute();
    let remainingBytes = 64 * 1024 * 1024;
    data.files = await each(artifacts, async (r) => {
      if (r.scan_state === 'clean') await sql`SELECT trustwork.files_privacy_export_lock(${r.id}::uuid)`.execute(trx);
      const metadata = await files.get(r.id, state);
      if (r.scan_state !== 'clean') return { metadata, binaryStatus: 'scan_unavailable' };
      if (fileOptions.store!.kind !== 'filesystem') return { metadata, binaryStatus: 'external_storage_adapter_required' };
      const size = Number(r.bytes);
      if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || size > remainingBytes) return { metadata, binaryStatus: fileOptions.store!.stream ? 'authenticated_stream_available' : 'streaming_adapter_unavailable', streamFileId: r.id };
      const bytes = await fileOptions.store!.read(r.storage_key, size);
      if (!bytes || bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== r.sha256) throw new Error('privacy file digest verification failed');
      remainingBytes -= size;
      return { metadata, binaryStatus: 'included', encoding: 'base64', bytes: Buffer.from(bytes).toString('base64') };
    });
  } else data.files = { status: 'owning_storage_unavailable' };
  const content = new ContentService(ctx, principals, identity.secondFactors, { hubId: () => null, reviewFormats: [], commentsEnabled: () => false });
  const publications = await trx.selectFrom('publication').select('id').where(subject.kind === 'person' ? 'owner_person_id' : 'owner_company_id', '=', subject.id).orderBy('id').execute();
  data.content = { publications: await each(publications, (r) => content.manage(state, r.id)) };
  if (subject.kind === 'company') {
    const approvalRoutes = new ApprovalRoutesService(ctx, principals, new NoApprovalMandates(), { routeActivationSecondPerson: true });
    const routes = await trx.selectFrom('approval_route_version').select('id').where('owner_company_id', '=', subject.id).orderBy('id').execute();
    const requests = await trx.selectFrom('approval_request').select('id').where('owner_company_id', '=', subject.id).orderBy('id').execute();
    data['approval-routes'] = { routes: await each(routes, (r) => approvalRoutes.getRoute(state, r.id)),
      requests: await each(requests, (r) => approvalRoutes.getRequest(state, r.id)), delegations: await approvalRoutes.listDelegations(state) };
    const suppliers = new SupplierBaseService(ctx, principals, new NoSupplierBaseMandates(), sanctionsScreening);
    const records = await trx.selectFrom('supplier_record').select('id').where('owner_company_id', '=', subject.id).orderBy('id').execute();
    const counterparties = await trx.selectFrom('external_counterparty').select('id').where('owner_company_id', '=', subject.id).orderBy('id').execute();
    data['supplier-base'] = { records: await each(records, async (r) => ({ record: await suppliers.getSupplier(state, r.id), assessments: await suppliers.listAssessments(state, r.id) })),
      counterparties: await each(counterparties, (r) => suppliers.getCounterparty(state, r.id)) };
  }
  const plans = new PlansService(ctx, principals, identity.participations, new NoPlanMandates(), new FileLicensingFacets());
  data.sharedPlans = await plans.privacyShared(state, subject);
  const planRows = projectIds.length ? await trx.selectFrom('plan').select(['id', 'project_id']).where('project_id', 'in', projectIds).orderBy('id').execute() : [];
  data.plans = await each(planRows, async (r) => ({
    current: await plans.get(r.project_id, state),
    versions: await each(await trx.selectFrom('plan_version').select('id').where('plan_id', '=', r.id).orderBy('version').execute(), (v) => plans.getVersion(r.project_id, v.id, state)),
    itemStates: await plans.listItemStates(r.project_id, state), changes: await plans.listChanges(r.project_id, state),
    timing: await plans.timingFacts(r.project_id, state), shares: await plans.listShares(r.project_id, state),
    location: await plans.getLocation(r.project_id, state), permits: await plans.listPermits(r.project_id, state), diary: await plans.listDiary(r.project_id, state),
  }));
  const execution = new ExecutionService(ctx, principals, new NoExecutionMandates(), { hubId: null });
  const trust = new TrustService(ctx, principals, { hubId: null });
  // Execution is defined only for fully confirmed agreements. Retain unconfirmed terms in the agreement export.
  const confirmed = agreementIds.length ? await trx.selectFrom('agreement').select('id').where('id', 'in', agreementIds).where('status', 'in', ['accepted_by_both', 'superseded']).execute() : [];
  data.execution = await each(confirmed, (r) => execution.view(r.id, state));
  data.trust = await each(confirmed, (r) => trust.listReviews(r.id, state));
  const reputation = new ReputationService(ctx, principals, { hubId: null, register: { code: 'unavailable', lookup: async () => { throw new Error('export cannot call a credential register'); } } });
  data.reputation = { own: await reputation.own(subject, state), confirmations: await reputation.inbox(subject, state) };
  const tasks = new TasksService(ctx, principals, new NoTaskMandates(), new ConfiguredElectronicRecords());
  const assignments = agreementIds.length ? await trx.selectFrom('task_assignment').select('id').where('agreement_id', 'in', agreementIds).orderBy('id').execute() : [];
  data.tasks = {
    ...await tasks.privacyExport(state, subject),
    assignments: await each(assignments, (r) => tasks.getAssignment(r.id, state)),
  };
  const comms = new CommunicationsService(ctx, principals, new NoCommsMandates(), { providers: [], send: async () => { throw new Error('export cannot dispatch'); } }, communicationsSettingsFromEnv());
  // Context discovery stays subject-scoped. COMMS performs its current authorizer and complete history projection.
  const communications: Record<string, unknown> = { threads: await comms.privacyContexts(input.communicationContexts, state) };
  if (subject.kind === 'person') {
    const notifications: unknown[] = []; let cursor: string | undefined;
    do {
      const page = await comms.listNotifications({ limit: 100, ...(cursor ? { cursor } : {}) }, state);
      notifications.push(...page.items); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    communications.notifications = notifications;
    communications.preferences = await comms.getPreferences(state);
    communications.channels = await comms.listGrants(state);
  }
  data.communications = communications;
  const consultations = new ConsultationsService(ctx, principals, new NoConsultationMandates(), new ConfiguredElectronicRecords(), new NoPublishedCommission(), new ScreeningCommitmentGate());
  const consultationRequests = await trx.selectFrom('consultation_request').select('id').where((eb) => subject.kind === 'company'
    ? eb('offering_owner_company_id', '=', subject.id)
    : eb.or([eb('requester_person_id', '=', subject.id), eb('offering_owner_person_id', '=', subject.id)])).orderBy('id').execute();
  const bookings = await trx.selectFrom('consultation_booking').select('id').where((eb) => subject.kind === 'company'
    ? eb('seller_company_id', '=', subject.id)
    : eb.or([eb('client_person_id', '=', subject.id), eb('seller_person_id', '=', subject.id)])).orderBy('id').execute();
  data.consultations = { ...await consultations.privacyInventory(state, subject), requests: await each(consultationRequests, (r) => consultations.getRequest(r.id, state)),
    bookings: await each(bookings, (r) => consultations.getBooking(r.id, state)) };
  if (subject.kind === 'person') {
    const goals = new GoalsService(ctx, principals);
    // A person's export never includes an employer's private goals/reports or another agent's internal state.
    const ownGoals = await trx.selectFrom('goal').select('id').where('principal_person_id', '=', subject.id).where('on_behalf_company_id', 'is', null).orderBy('id').execute();
    const reports = await trx.selectFrom('agent_report').selectAll().where('author_person_id', '=', subject.id).where('principal_company_id', 'is', null).orderBy('id').execute();
    const subscriptions = await trx.selectFrom('job_subscription').selectAll().where('principal_person_id', '=', subject.id).where('on_behalf_company_id', 'is', null).orderBy('id').execute();
    data['assistant-goals'] = { goals: await each(ownGoals, (r) => goals.getGoal(r.id, state)), reports: reports.map((r) => reportView(r, subject.id)),
      subscriptions: subscriptions.map(jobSubscriptionView) };
  }
  data.billing = await exportOwnBilling(trx, subject);
  return data;
}
