import type { z } from 'zod';
import { withPrincipal, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import type { ConsolePermission, Principal } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import type { BindAdapterCommandSchema, EndLinkCommandSchema, FakeRunCommandSchema, GoLiveCommandSchema, LinkRecordCommandSchema, RetireAdapterCommandSchema } from './commands.js';
import { adminAudit, REGISTER_ADAPTERS, registers, type CommandContext, type StaffRole } from './deps.js';
import { isAuthorityRefusal, registersRefusal } from './errors.js';
import { fakeObservations } from './fakes.js';
import { toAdapter, toFact, toLink, toPublicFact, toReminder } from './views.js';

type Body<S extends z.ZodType> = z.infer<S>;
type Cmd = { idempotencyKey: string; reason: string };
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string; permission: ConsolePermission; action: string; objectType: string; objectId: string }
const NO_OBJECT = '00000000-0000-4000-8000-000000000000';

/**
 * Register facts use cases (REG-001). Staff commands run in one `PrincipalService.runAs` transaction through a
 * `registers_*` SECURITY DEFINER command that checks the permission at the hub and the elevation and writes the audit
 * row (BE-005 completes the idempotency record there too); refusals of authority leave a `denied` audit row in a
 * transaction of their own. Reads check that the object belongs to the hub in the path. The public read uses the hub
 * this API serves and returns only PublicSourcedFactSchema rows.
 */
export class RegistersService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly now: () => Date = () => new Date()) {}

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }

  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt, fn: (trx: Transaction, cmd: CommandContext, p: Principal) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, (trx, p) => fn(trx, cmd, p));
    } catch (error) {
      const refusal = registersRefusal(error);
      if (refusal && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('registers.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw registersRefusal(error) ?? error;
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

  /** The engine catalogue and the hub's adapters (staff of the hub with a sources or claims permission). */
  overview(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({
      catalogue: REGISTER_ADAPTERS.map((a) => ({ ...a, kinds: [...a.kinds] })),
      adapters: (await registers.adapters(trx, hubId)).map(toAdapter),
      links: (await registers.links(trx, hubId)).map(toLink),
    }));
  }

  adapterFacts(state: RequestState, hubId: string, adapterId: string) {
    return this.read(state, async (trx) => {
      RegistersService.ofHub(await registers.adapter(trx, adapterId), hubId);
      return { items: (await registers.currentFacts(trx, adapterId)).map(toFact) };
    });
  }

  companyFacts(state: RequestState, hubId: string, companyId: string) {
    return this.read(state, async (trx) => ({ items: (await registers.companyFacts(trx, hubId, companyId)).map(toFact) }));
  }

  /** The digest a second person approves (`providers.enable_non_fake`) before the adapter goes live with this credential. */
  liveDigest(state: RequestState, hubId: string, adapterId: string, credentialRefId: string) {
    return this.read(state, async (trx) => {
      const adapter = RegistersService.ofHub(await registers.adapter(trx, adapterId), hubId);
      return { action: 'providers.enable_non_fake', actionDigest: await registers.liveDigest(trx, adapter.id, adapter.revision, credentialRefId), revision: adapter.revision };
    });
  }

  /** An active administrator of the company: its expiry reminders. */
  ownReminders(state: RequestState, companyId: string) {
    return this.read(state, async (trx) => ({ items: (await registers.ownReminders(trx, companyId)).map(toReminder) }));
  }

  /** Anyone: what the served hub may show about a company. Without a configured hub there is nothing to show. */
  async publicFacts(companyId: string, hubId: string | null = staffHubFromEnv(process.env)) {
    if (!hubId) return { hubConfigured: false, items: [] };
    const rows = await withoutPrincipal(this.ctx.pool, (trx) => registers.publicFacts(trx, hubId, companyId));
    return { hubConfigured: true, items: rows.map(toPublicFact) };
  }

  /* ---------- Commands ---------- */

  bindAdapter(e: Elevated, hubId: string, body: Body<typeof BindAdapterCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'registers.adapter_bound', objectType: 'register_adapter', objectId: NO_OBJECT },
      async (trx, cmd) => ({ adapter: toAdapter(await registers.bindAdapter(trx, cmd, hubId, body.adapter, body.sourceId, body.refreshDays)) }));
  }

  goLive(e: Elevated, hubId: string, adapterId: string, body: Body<typeof GoLiveCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'registers.adapter_live', objectType: 'register_adapter', objectId: adapterId },
      async (trx, cmd) => {
        RegistersService.ofHub(await registers.adapter(trx, adapterId), hubId);
        return { adapter: toAdapter(await registers.goLive(trx, cmd, adapterId, body.expectedRevision, body.credentialRefId, body.approvalId)) };
      });
  }

  retireAdapter(e: Elevated, hubId: string, adapterId: string, body: Body<typeof RetireAdapterCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'registers.adapter_retired', objectType: 'register_adapter', objectId: adapterId },
      async (trx, cmd) => {
        RegistersService.ofHub(await registers.adapter(trx, adapterId), hubId);
        return { adapter: toAdapter(await registers.retireAdapter(trx, cmd, adapterId, body.expectedRevision)) };
      });
  }

  /** A staff run of a fake adapter: the deterministic observations are computed here, never typed by a person. */
  fakeRun(e: Elevated, hubId: string, adapterId: string, body: Body<typeof FakeRunCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'registers.fake_run_recorded', objectType: 'register_adapter', objectId: adapterId },
      async (trx, cmd) => {
        const adapter = RegistersService.ofHub(await registers.adapter(trx, adapterId), hubId);
        let observations;
        try {
          observations = fakeObservations(adapter.adapter, body.subjects, this.now());
        } catch {
          throw new ApiError('validation.schema', 'the subjects do not fit the adapter', { reason: 'invalid_subjects' });
        }
        return { items: (await registers.recordFakeRun(trx, cmd, adapterId, observations)).map(toFact) };
      });
  }

  linkRecord(e: Elevated, hubId: string, body: Body<typeof LinkRecordCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.dedupe.decide', action: 'registers.record_linked', objectType: 'register_fact_link', objectId: NO_OBJECT },
      async (trx, cmd) => {
        RegistersService.ofHub(await registers.adapter(trx, body.adapterId), hubId);
        return { link: toLink(await registers.linkRecord(trx, cmd, body.adapterId, body.recordRef, body.companyId, body.reason)) };
      });
  }

  endLink(e: Elevated, hubId: string, linkId: string, body: Body<typeof EndLinkCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.dedupe.decide', action: 'registers.link_ended', objectType: 'register_fact_link', objectId: linkId },
      async (trx, cmd) => {
        RegistersService.ofHub((await registers.links(trx, hubId)).find((l) => l.id === linkId), hubId);
        return { link: toLink(await registers.endLink(trx, cmd, linkId)) };
      });
  }
}
