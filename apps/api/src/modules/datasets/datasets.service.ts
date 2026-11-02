import type { z } from 'zod';
import { withPrincipal, type Transaction } from '../../deps/data.js';
import type { ConsolePermission, Principal } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import type {
  ActivateDatasetCommandSchema, BatchDecisionCommandSchema, ContactUseCommandSchema, DatasetLicenceCommandSchema, DatasetStatusCommandSchema, DecideLinkCommandSchema,
  DoNotCollectCommandSchema, IngestCommandSchema, MarkContactCommandSchema, MarkDistinctCommandSchema, ProposeDatasetCommandSchema, ProposeLinkCommandSchema, ResolveCommandSchema,
} from './commands.js';
import { adminAudit, datasets, links, type CommandContext, type StaffRole } from './deps.js';
import { datasetsRefusal, isAuthorityRefusal } from './errors.js';
import { toBatch, toDataset, toDistinct, toLicence, toProposal, toRecord, toTombstone } from './views.js';

type Body<S extends z.ZodType> = z.infer<S>;
type Cmd = { idempotencyKey: string; reason: string };
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string; permission: ConsolePermission; action: string; objectType: string; objectId: string }
const NO_OBJECT = '00000000-0000-4000-8000-000000000000';

/**
 * Local data mining use cases (MINE-001). Staff commands run in one `PrincipalService.runAs` transaction through a
 * `datasets_*` SECURITY DEFINER command that checks the permission at the hub and the elevation and writes the audit
 * row (BE-005 completes the idempotency record there too); refusals of authority leave a `denied` audit row in a
 * transaction of their own. Reads check that the object belongs to the hub in the path.
 */
export class DatasetsService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService) {}

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }

  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt, fn: (trx: Transaction, cmd: CommandContext, p: Principal) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, (trx, p) => fn(trx, cmd, p));
    } catch (error) {
      const refusal = datasetsRefusal(error);
      if (refusal && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('datasets.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw datasetsRefusal(error) ?? error;
    });
  }

  private async recordDenied(e: Elevated, cmd: CommandContext, attempt: Attempt, refusal: ApiError): Promise<void> {
    const p = e.state.principal as Principal;
    await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, async (trx) => {
      const role = await trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.personId).where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('scope_kind', 'in', ['platform', 'node']), eb('hub_id', '=', attempt.hubId)]))
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', new Date())])).orderBy('breakglass').limit(1).executeTakeFirst();
      if (!role) return;
      const reason = typeof refusal.details?.reason === 'string' ? refusal.details.reason : refusal.code.replace(/\W/g, '_');
      await adminAudit.append(trx, {
        actorPersonId: p.personId, actorRole: role.role as StaffRole, scope: { kind: 'hub', hubId: attempt.hubId }, permission: attempt.permission, elevationId: cmd.elevationId,
        action: attempt.action, objectType: attempt.objectType, objectId: attempt.objectId, reasonCode: `denied_${reason}`.slice(0, 64).replace(/[^a-z0-9_]/g, '_'), reasonText: cmd.reasonText,
        outcome: 'denied', requestId: cmd.requestId,
      });
    });
  }

  private static ofHub<T extends { hub_id: string }>(row: T | undefined, hubId: string): T {
    if (!row || row.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return row;
  }

  /* ---------- Reads ---------- */

  list(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ items: (await datasets.list(trx, hubId)).map(toDataset) }));
  }

  detail(state: RequestState, hubId: string, datasetId: string) {
    return this.read(state, async (trx) => {
      const dataset = DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
      return { dataset: toDataset(dataset), licences: (await datasets.licences(trx, datasetId)).map(toLicence) };
    });
  }

  records(state: RequestState, hubId: string, datasetId: string) {
    return this.read(state, async (trx) => {
      DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
      return { items: (await datasets.records(trx, datasetId)).map(toRecord), tombstones: (await datasets.tombstones(trx, datasetId)).map(toTombstone) };
    });
  }

  contactPoints(state: RequestState, hubId: string, datasetId: string) {
    return this.read(state, async (trx) => ({
      items: (await datasets.contactPoints(trx, hubId, datasetId)).map((c) => ({
        recordId: c.record_id, externalKey: c.external_key, identifierKind: c.identifier_kind, identifierValue: c.identifier_value, fields: c.fields, provenance: c.provenance,
        observedAt: c.observed_at.toISOString(),
      })),
    }));
  }

  /** The digest a second person approves before a personal-data, court or debt dataset is activated. */
  activationDigest(state: RequestState, hubId: string, datasetId: string) {
    return this.read(state, async (trx) => {
      const dataset = DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
      const action = ['court_cases', 'debts_tax_arrears'].includes(dataset.subject) ? 'datasets.activate_court_or_debt'
        : dataset.personal_present ? 'pipelines.activate_personal_data_dataset' : null;
      return { action, actionDigest: await datasets.activationDigest(trx, dataset.id, dataset.revision), revision: dataset.revision };
    });
  }

  proposals(state: RequestState, hubId: string, linkState?: string) {
    return this.read(state, async (trx) => ({ items: (await links.proposals(trx, hubId, linkState)).map(toProposal) }));
  }

  /* ---------- Commands ---------- */

  propose(e: Elevated, hubId: string, body: Body<typeof ProposeDatasetCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.datasets.edit', action: 'datasets.proposed', objectType: 'dataset', objectId: NO_OBJECT },
      async (trx, cmd) => ({ dataset: toDataset(await datasets.propose(trx, cmd, hubId, {
        subject: body.subject, name: body.name, sourceIds: body.sourceIds, purpose: body.purpose, legalBasis: body.legalBasis, personalData: body.personalData,
        impactAssessmentRef: body.impactAssessmentRef, retention: body.retention, outputs: body.outputs, publicDisplay: body.publicDisplay, subjectNotice: body.subjectNotice,
        refreshScheduleId: body.refreshScheduleId,
      })) }));
  }

  activate(e: Elevated, hubId: string, datasetId: string, body: Body<typeof ActivateDatasetCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.datasets.activate', action: 'datasets.activated', objectType: 'dataset', objectId: datasetId },
      async (trx, cmd) => {
        DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
        return { dataset: toDataset(await datasets.activate(trx, cmd, datasetId, body.expectedRevision, body.approvalId)) };
      });
  }

  setStatus(e: Elevated, hubId: string, datasetId: string, body: Body<typeof DatasetStatusCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.datasets.edit', action: `datasets.${body.to}`, objectType: 'dataset', objectId: datasetId },
      async (trx, cmd) => {
        DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
        return { dataset: toDataset(await datasets.setStatus(trx, cmd, datasetId, body.expectedRevision, body.to)) };
      });
  }

  recordLicence(e: Elevated, hubId: string, datasetId: string, body: Body<typeof DatasetLicenceCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.datasets.edit', action: 'datasets.licence_recorded', objectType: 'dataset_licence', objectId: NO_OBJECT },
      async (trx, cmd) => {
        DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
        return { licence: toLicence(await datasets.recordLicence(trx, cmd, datasetId, {
          supplier: body.supplier, agreementDigest: body.agreementDigest, agreementRef: body.agreementRef, purposes: body.purposes, uses: body.uses, validFrom: body.validFrom,
          validUntil: body.validUntil,
        })) };
      });
  }

  setContactUse(e: Elevated, hubId: string, datasetId: string, body: Body<typeof ContactUseCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.datasets.edit', action: 'datasets.contact_use_set', objectType: 'dataset', objectId: datasetId },
      async (trx, cmd) => {
        DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
        return { dataset: toDataset(await datasets.setContactUse(trx, cmd, datasetId, body.expectedRevision, body.allowed)) };
      });
  }

  markContact(e: Elevated, hubId: string, recordId: string, body: Body<typeof MarkContactCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.datasets.edit', action: 'datasets.contact_marked', objectType: 'dataset_record', objectId: recordId },
      async (trx, cmd) => ({ record: toRecord(DatasetsService.ofHub(await datasets.markContact(trx, cmd, recordId, body.allowed), hubId)) }));
  }

  addDoNotCollect(e: Elevated, hubId: string, body: Body<typeof DoNotCollectCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.datasets.edit', action: 'datasets.do_not_collect_added', objectType: 'dataset_do_not_collect', objectId: NO_OBJECT },
      async (trx, cmd) => ({ buried: await datasets.addDoNotCollect(trx, cmd, hubId, body.kind, body.value, body.entryReason) }));
  }

  ingest(e: Elevated, hubId: string, datasetId: string, body: Body<typeof IngestCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.datasets.edit', action: 'datasets.ingested', objectType: 'dataset', objectId: datasetId },
      async (trx, cmd) => {
        DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
        return { counts: await datasets.ingest(trx, cmd, datasetId, body.records) };
      });
  }

  resolve(e: Elevated, hubId: string, datasetId: string, body: Body<typeof ResolveCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.links.decide', action: 'datasets.resolved', objectType: 'dataset', objectId: datasetId },
      async (trx, cmd) => {
        DatasetsService.ofHub(await datasets.get(trx, datasetId), hubId);
        return { proposals: await links.resolve(trx, cmd, datasetId) };
      });
  }

  proposeLink(e: Elevated, hubId: string, body: Body<typeof ProposeLinkCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.links.decide', action: 'datasets.link_proposed', objectType: 'entity_link_proposal', objectId: NO_OBJECT },
      async (trx, cmd) => ({ proposal: toProposal(DatasetsService.ofHub(await links.propose(trx, cmd, body.recordId, body.targetKind, body.targetId, body.evidence, body.confidence), hubId)) }));
  }

  decideLink(e: Elevated, hubId: string, proposalId: string, body: Body<typeof DecideLinkCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.links.decide', action: `datasets.link_${body.decision}`, objectType: 'entity_link_proposal', objectId: proposalId },
      async (trx, cmd) => {
        DatasetsService.ofHub(await links.proposal(trx, proposalId), hubId);
        return { proposal: toProposal(await links.decide(trx, cmd, proposalId, body.expectedRevision, body.decision)) };
      });
  }

  markDistinct(e: Elevated, hubId: string, body: Body<typeof MarkDistinctCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.links.decide', action: 'datasets.marked_distinct', objectType: 'dataset_record', objectId: body.recordId },
      async (trx, cmd) => ({ distinct: toDistinct(DatasetsService.ofHub(await links.markDistinct(trx, cmd, body.recordId, body.targetKind, body.targetId, body.distinctReason), hubId)) }));
  }

  batchDecide(e: Elevated, hubId: string, body: Body<typeof BatchDecisionCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.links.decide', action: `datasets.links_batch_${body.decision}`, objectType: 'entity_link_batch', objectId: NO_OBJECT },
      async (trx, cmd) => ({ batch: toBatch(await links.batchDecide(trx, cmd, hubId, body.proposalIds, body.sampleIds, body.decision)) }));
  }
}
