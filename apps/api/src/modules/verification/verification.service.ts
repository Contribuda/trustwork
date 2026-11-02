import type { z } from 'zod';
import { withPrincipal, type Transaction } from '../../deps/data.js';
import type { ConsolePermission, Principal } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import type {
  ActivateRecipeCommandSchema, DraftRecipeCommandSchema, GoLiveCommandSchema, RecordCheckCommandSchema, RecordScreeningCommandSchema, RegisterProviderCommandSchema,
} from './commands.js';
import { adminAudit, verification, type CommandContext, type StaffRole } from './deps.js';
import { isAuthorityRefusal, verificationRefusal } from './errors.js';
import { toCheck, toProvider, toRecipe } from './views.js';

type Body<S extends z.ZodType> = z.infer<S>;
type Cmd = { idempotencyKey: string; reason: string };
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string; permission: ConsolePermission; action: string; objectType: string; objectId: string }
const NO_OBJECT = '00000000-0000-4000-8000-000000000000';

/**
 * Counterparty verification use cases for the hub console (HUB-003). Every staff command runs in one
 * `PrincipalService.runAs` transaction through a `verification_*` SECURITY DEFINER command that checks the permission
 * at the hub and the elevation and writes the audit row in that transaction (BE-005 completes the idempotency record
 * there too). Refusals of authority leave a `denied` audit row in a transaction of their own. Every read checks that
 * the object belongs to the hub in the path; a row of another hub answers "not found".
 */
export class VerificationService {
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
      const refusal = verificationRefusal(error);
      if (refusal && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('verification.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw verificationRefusal(error) ?? error;
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

  overview(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({
      providers: (await verification.providers(trx, hubId)).map(toProvider),
      recipes: (await verification.recipes(trx, hubId)).map(toRecipe),
    }));
  }

  checksOf(state: RequestState, hubId: string, subject: { kind: 'company' | 'person'; id: string }) {
    return this.read(state, async (trx) => ({ items: (await verification.checksOf(trx, hubId, subject)).map(toCheck) }));
  }

  standing(state: RequestState, hubId: string, subject: { kind: 'company' | 'person'; id: string }, recipeId: string) {
    return this.read(state, (trx) => verification.evaluate(trx, hubId, subject, recipeId));
  }

  /** The digest a second person approves (`providers.enable_non_fake`) before the provider goes live with this credential. */
  liveDigest(state: RequestState, hubId: string, providerId: string, credentialRefId: string) {
    return this.read(state, async (trx) => {
      const provider = VerificationService.ofHub((await verification.providers(trx, hubId)).find((p) => p.id === providerId), hubId);
      return { action: 'providers.enable_non_fake', actionDigest: await verification.liveDigest(trx, provider.id, provider.revision, credentialRefId), revision: provider.revision };
    });
  }

  /* ---------- Commands ---------- */

  registerProvider(e: Elevated, hubId: string, body: Body<typeof RegisterProviderCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.policy.edit', action: 'verification.provider_registered', objectType: 'verification_provider', objectId: NO_OBJECT },
      async (trx, cmd) => ({ provider: toProvider(await verification.registerProvider(trx, cmd, hubId, {
        checkType: body.checkType, adapter: body.adapter, mode: body.mode, retentionDays: body.retentionDays, legalBasis: body.legalBasis, costMinor: body.costMinor,
      })) }));
  }

  goLive(e: Elevated, hubId: string, providerId: string, body: Body<typeof GoLiveCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.policy.edit', action: 'verification.provider_live', objectType: 'verification_provider', objectId: providerId },
      async (trx, cmd) => {
        VerificationService.ofHub((await verification.providers(trx, hubId)).find((p) => p.id === providerId), hubId);
        return { provider: toProvider(await verification.goLive(trx, cmd, providerId, body.expectedRevision, body.credentialRefId, body.approvalId)) };
      });
  }

  draftRecipe(e: Elevated, hubId: string, body: Body<typeof DraftRecipeCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.policy.edit', action: 'verification.recipe_drafted', objectType: 'verification_recipe', objectId: NO_OBJECT },
      async (trx, cmd) => ({ recipe: toRecipe(await verification.draftRecipe(trx, cmd, hubId, {
        key: body.key, subjectKind: body.subjectKind, trigger: body.trigger, steps: body.steps, badgeCategories: body.badgeCategories, recheckMonths: body.recheckMonths,
      })) }));
  }

  activateRecipe(e: Elevated, hubId: string, recipeId: string, body: Body<typeof ActivateRecipeCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.policy.edit', action: 'verification.recipe_activated', objectType: 'verification_recipe', objectId: recipeId },
      async (trx, cmd) => {
        VerificationService.ofHub(await verification.recipe(trx, recipeId), hubId);
        return { recipe: toRecipe(await verification.activateRecipe(trx, cmd, recipeId, body.expectedRevision)) };
      });
  }

  recordCheck(e: Elevated, hubId: string, body: Body<typeof RecordCheckCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: 'verification.check_recorded', objectType: 'verification_check', objectId: NO_OBJECT },
      async (trx, cmd) => ({ check: toCheck(await verification.recordCheck(trx, cmd, hubId, body.subject, body.recipeId, body.providerId, body.result, body.evidenceRef)) }));
  }

  recordScreening(e: Elevated, hubId: string, body: Body<typeof RecordScreeningCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: 'verification.screening_recorded', objectType: 'verification_check', objectId: NO_OBJECT },
      async (trx, cmd) => ({ check: toCheck(await verification.recordScreening(trx, cmd, hubId, body.subject, body.recipeId)) }));
  }
}
