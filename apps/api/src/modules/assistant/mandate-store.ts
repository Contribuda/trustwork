import type { ContextRef, MandateActionV2, Money } from '../../deps/contracts.js';
import { withPrincipal, type DataPool } from '../../deps/data.js';
import type { Clock, MandateRevocationPort } from '../identity/ports.js';
import { actionIntents } from './deps.js';
import { actionDigest, decide, isUuid, type PolicySettings } from './policy.js';

/**
 * The one mandate port behind every module's agent check (ADR 010 decisions 4 and 23). The tasks, sales and
 * transactions, procurement and catalogue, plans, profiles, files and execution modules each declare a structural port
 * (`allows(check) => Promise<boolean>`); this store answers all of them from the confirmed mandates of AST-001:
 *
 * 1. the check runs as the person (their own principal transaction, RLS on every row);
 * 2. `evaluateMandateV2` decides from structured facts only (status, expiry, module, action, context, ceilings, window,
 *    approval policy, human-only verbs, hub kill switches and the person's stop control);
 * 3. `allow` records a mandate use under the mandate row lock (cumulative ceiling and window rechecked there);
 * 4. `ask` records a decision waiting for the person, bound to the action digest. After the person approves it on the
 *    first-party form, the identical retry is allowed once and consumes the approval;
 * 5. anything else, including an unknown, foreign, revoked, suspended, expired or malformed mandate, is refused.
 *
 * Module checks carry no money effect of their own (the module performs the change in its own transaction); amounts
 * still count against the mandate ceiling. A missing or non-UUID mandate id is refused before touching the database.
 */
export interface UniversalMandateCheck {
  personId: string;
  mandateId: string;
  action: MandateActionV2;
  context?: { kind: string; id: string } | null;
  projectId?: string;
  amount?: Money | null;
  at: Date;
}

export type MandateCheckResult = { allowed: true } | { allowed: false; reason: string; decisionId: string | null };

const CONTEXT_KINDS = new Set(['project', 'rfq', 'quote', 'agreement', 'order', 'introduction', 'open_need', 'partner_post', 'event', 'course', 'publication', 'profile', 'catalogue_offering',
  'opportunity', 'company', 'plan_item', 'consultation', 'task_request', 'goal']);

/** Module keys each port speaks for (the capability registry entries of those modules). */
export const MODULE_KEYS = {
  tasks: ['task_marketplace'],
  deals: ['deal_desk', 'quoting'],
  commerce: ['sourcing_desk', 'need_intake', 'quoting', 'discovery'],
  plans: ['project_planner'],
  profiles: ['profile_keeper'],
  files: ['files'],
  execution: ['execution_clerk'],
} as const satisfies Record<string, readonly string[]>;

export class AssistantMandateStore {
  constructor(private readonly pool: DataPool, private readonly settings: PolicySettings, private readonly clock: Clock) {}

  /** Structural port for one module: `{ allows(check) }`, accepted by every module's `<X>MandatePort`. */
  port(moduleKeys: readonly string[]): { allows(check: UniversalMandateCheck): Promise<boolean> } {
    return { allows: async (check) => (await this.check(check, moduleKeys)).allowed };
  }

  async check(check: UniversalMandateCheck, moduleKeys: readonly string[]): Promise<MandateCheckResult> {
    if (!isUuid(check.personId) || !isUuid(check.mandateId)) return { allowed: false, reason: 'not_found', decisionId: null };
    const context = this.contextOf(check);
    if (!context) return { allowed: false, reason: 'context_scope', decisionId: null };
    const epoch = await this.epochOf(check.personId);
    if (epoch === null) return { allowed: false, reason: 'not_found', decisionId: null };
    try {
      return await withPrincipal(this.pool, { personId: check.personId, authzEpoch: epoch }, async (trx) => {
        const at = check.at ?? this.clock.now();
        const { outcome, row } = await decide(trx, {
          personId: check.personId, mandateId: check.mandateId, moduleKeys, action: check.action, context, amount: check.amount ?? null, projectId: check.projectId ?? null, at,
        }, this.settings);
        if (outcome.effect === 'deny' || !row) return { allowed: false, reason: outcome.effect === 'deny' ? outcome.reason : 'not_found', decisionId: null } as const;
        const amount = check.amount ?? null;
        const recorded = await actionIntents.record(trx, {
          runId: null, mandateId: row.id, mandateRevision: row.revision, capabilityId: `${outcome.moduleKey}.${check.action}`, moduleKey: outcome.moduleKey, action: check.action,
          context: outcome.context, resolvedFromSelector: outcome.resolvedFromSelector, amount,
          digest: actionDigest({ mandate: { id: row.id, revision: row.revision }, capabilityId: `${outcome.moduleKey}.${check.action}`, action: check.action, context: outcome.context, amount, effect: null }),
          effect: null, decision: outcome.effect, askReasons: outcome.effect === 'ask' ? outcome.reasons : [],
        });
        if (recorded.state === 'allowed' || recorded.state === 'authorized') return { allowed: true } as const;
        return { allowed: false, reason: 'approval_required', decisionId: recorded.intentId } as const;
      });
    } catch (error) {
      // Limits rechecked under the lock (ceiling, window), a revision that changed meanwhile, a stale epoch: refuse.
      const hint = (error as { hint?: string }).hint;
      return { allowed: false, reason: typeof hint === 'string' ? hint : 'refused', decisionId: null };
    }
  }

  private contextOf(check: UniversalMandateCheck): ContextRef | null {
    const raw = check.context ?? (check.projectId ? { kind: 'project', id: check.projectId } : { kind: 'profile', id: check.personId });
    if (!CONTEXT_KINDS.has(raw.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.id)) return null;
    return raw as ContextRef;
  }

  private async epochOf(personId: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ authz_epoch: number }>('SELECT authz_epoch FROM trustwork.auth_person_epoch($1::uuid)', [personId]);
    return rows[0]?.authz_epoch ?? null;
  }
}

/**
 * The identity hook (membership end, participation revocation) narrows the dependent mandates: company mandates when
 * the membership is really gone, personal mandates whose project context the person no longer owns or participates in.
 * Not yet started actions under those mandates are revoked and their reservations released in the same command.
 */
export class AssistantMandateRevocation implements MandateRevocationPort {
  constructor(private readonly pool: DataPool) {}
  async revokeForPerson(personId: string, companyId: string | null, reason: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT trustwork.assistant_revoke_for_basis($1::uuid, $2::uuid, $3)', [personId, companyId, reason.slice(0, 200)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
