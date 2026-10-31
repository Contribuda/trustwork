import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  computeDigest,
  EgressPermitSchema,
  EgressRequestSchema,
  matchesEgressBinding,
  type EgressAdmissionPort,
  type EgressPermit,
  type EgressRequest,
} from '../../../contracts/src/index.js';
import { withPrincipal, type DataPool, type Principal, type Transaction } from '../pool.js';
import type { AdmissionLease, AdmissionOutcome, RevocationEvent } from '../schema.js';

/**
 * Common admission / revocation primitive (docs/architecture/retrieval.md, "Authorization and revocation
 * linearization"). The authoritative state lives in PostgreSQL (`admission_scope`, `admission_lease`,
 * `revocation_event`, migration 20261027120800) so API and worker nodes share one linearization:
 *
 *  - `issue` records a server-issued one-use permit (frozen `EgressPermit` shape) together with the epoch of every
 *    scope it depends on, read under FOR SHARE so an in-progress revocation commits first;
 *  - `admit` consumes the permit once inside a transaction that re-reads the scope epochs under FOR SHARE: a revoke
 *    that committed after the preflight (issue) and before the admission is observed and denies; expiry, replay,
 *    binding / digest / context mismatch and a missing database identity fail closed;
 *  - `revoke` is the exclusive operation (row lock + epoch bump + revocation event) and invalidates unadmitted permits.
 *
 * Admitted bytes are explicitly outside the recall guarantee; the bounded lease only reports the in-flight window.
 *
 * Scope contract for consumers (RAG-201 / RAG-301): every permit MUST include `person:<principalId>` (revoked by
 * membership end and participation revocation of that person) and, when the principal exercises a company party
 * through membership, `company:<companyId>`; add `<kind>:<resourceId>` for the resources whose projections are
 * egressed (revoked on participation revocation and ownership transfer). A permit without the person scope is not
 * fenced by identity revocation.
 */
export type AdmissionDenyReason =
  | 'missing_identity' | 'unknown_permit' | 'principal_mismatch' | 'replayed' | 'revoked' | 'expired'
  | 'binding_mismatch' | 'digest_mismatch' | 'context_mismatch' | 'permit_tampered' | 'request_invalid';

export type AdmissionCheck =
  | { admitted: true; leaseId: string; leaseUntil: Date; scopeEpochs: readonly bigint[] }
  | { admitted: false; reason: AdmissionDenyReason };

export const admissionScopes = {
  person: (personId: string) => `person:${personId}`,
  company: (companyId: string) => `company:${companyId}`,
  resource: (kind: string, id: string) => `${kind}:${id}`,
};

const OPERATION_KEYS = ['binding', 'payloadDigest', 'context', 'dependencies', 'permitId', 'expiresAt', 'issuedAt'] as const;

/** Content digest of the permit: detects transport corruption only; authenticity is the lease row in the database. */
export function permitSignature(permit: Omit<EgressPermit, 'signature'>): string {
  const input: Record<string, unknown> = {};
  for (const key of OPERATION_KEYS) if (permit[key] !== undefined) input[key] = permit[key];
  return computeDigest(input).value;
}

function dependenciesDigest(request: EgressRequest): string {
  return computeDigest(request.dependencies).value;
}

interface AdmitRow { admitted: boolean; reason: AdmissionDenyReason | null; lease_id: string | null; lease_until: Date | null; scope_epochs: string[] | null }

export interface IssueOptions { scopes: readonly string[]; ttlMs: number; now?: Date }
export interface AdmitOptions { leaseMs: number; now?: Date }

/** Transaction-level operations; every call must run inside `withPrincipal` (the database requires the identity). */
export const admission = {
  async issue(trx: Transaction, request: EgressRequest, options: IssueOptions): Promise<EgressPermit> {
    const parsed = EgressRequestSchema.parse(request);
    const now = options.now ?? new Date();
    if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0) throw new Error('permit ttlMs must be a positive integer');
    const expiresAt = new Date(now.getTime() + options.ttlMs);
    const permitId = randomUUID();
    await sql`SELECT trustwork.admission_issue(
      ${permitId}, ${parsed.context.principalId}::uuid, ${[...options.scopes]}::text[], ${JSON.stringify(parsed.binding)}::jsonb, ${parsed.payloadDigest},
      ${parsed.context.policyEpoch}, ${parsed.context.scopeFingerprint}, ${dependenciesDigest(parsed)}, ${expiresAt}
    )`.execute(trx);
    const unsigned = { ...parsed, permitId, expiresAt: expiresAt.toISOString(), issuedAt: now.toISOString() };
    return EgressPermitSchema.parse({ ...unsigned, signature: permitSignature(unsigned) });
  },

  /** Serialized one-use admission check; returns the bounded lease when admitted, a reason otherwise. */
  async admit(trx: Transaction, request: EgressRequest, permit: EgressPermit, options: AdmitOptions): Promise<AdmissionCheck> {
    const now = options.now ?? new Date();
    const parsedRequest = EgressRequestSchema.safeParse(request);
    const parsedPermit = EgressPermitSchema.safeParse(permit);
    if (!parsedRequest.success || !parsedPermit.success) return { admitted: false, reason: 'request_invalid' };
    const { signature, ...unsigned } = parsedPermit.data;
    if (signature !== undefined && signature !== permitSignature(unsigned)) return { admitted: false, reason: 'permit_tampered' };
    if (!matchesEgressBinding(parsedPermit.data, parsedRequest.data, now)) {
      return { admitted: false, reason: Date.parse(parsedPermit.data.expiresAt) <= now.getTime() ? 'expired' : 'binding_mismatch' };
    }
    if (!Number.isInteger(options.leaseMs) || options.leaseMs <= 0) throw new Error('leaseMs must be a positive integer');
    const { rows } = await sql<AdmitRow>`SELECT * FROM trustwork.admission_admit(
      ${parsedPermit.data.permitId}, ${JSON.stringify(parsedRequest.data.binding)}::jsonb, ${parsedRequest.data.payloadDigest},
      ${parsedRequest.data.context.policyEpoch}, ${parsedRequest.data.context.scopeFingerprint}, ${dependenciesDigest(parsedRequest.data)},
      make_interval(secs => ${options.leaseMs / 1000})
    )`.execute(trx);
    const row = rows[0];
    if (!row) return { admitted: false, reason: 'unknown_permit' };
    if (!row.admitted || !row.lease_id || !row.lease_until) return { admitted: false, reason: row.reason ?? 'unknown_permit' };
    return { admitted: true, leaseId: row.lease_id, leaseUntil: row.lease_until, scopeEpochs: (row.scope_epochs ?? []).map(BigInt) };
  },

  async settle(trx: Transaction, leaseId: string, outcome: AdmissionOutcome): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.admission_settle(${leaseId}::uuid, ${outcome}) AS ok`.execute(trx);
    return rows[0]?.ok === true;
  },

  /** Exclusive revocation; returns the scope epoch after the bump. Serialized with every in-flight admission check. */
  async revoke(trx: Transaction, scope: string, reason: string): Promise<bigint> {
    const { rows } = await sql<{ epoch: string }>`SELECT trustwork.admission_revoke(${scope}, ${reason}) AS epoch`.execute(trx);
    return BigInt(rows[0]?.epoch ?? '0');
  },

  async revokeMany(trx: Transaction, scopes: readonly string[], reason: string): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const scope of [...new Set(scopes)].sort()) out.set(scope, await admission.revoke(trx, scope, reason));
    return out;
  },

  async scopeEpochs(trx: Transaction, scopes: readonly string[]): Promise<Map<string, bigint>> {
    const rows = await trx.selectFrom('admission_scope').select(['scope', 'epoch']).where('scope', 'in', [...scopes]).execute();
    return new Map(rows.map((r) => [r.scope, BigInt(r.epoch)]));
  },

  /** Admitted, unsettled leases whose window is still open (best-effort cancellation targets after a revocation). */
  inFlight(trx: Transaction, scope: string, now: Date = new Date()): Promise<AdmissionLease[]> {
    return trx.selectFrom('admission_lease').selectAll()
      .where(sql<boolean>`${scope} = ANY (scopes)`)
      .where('admitted_at', 'is not', null).where('settled_at', 'is', null).where('lease_until', '>', now)
      .execute();
  },

  getLease(trx: Transaction, permitId: string): Promise<AdmissionLease | undefined> {
    return trx.selectFrom('admission_lease').selectAll().where('permit_id', '=', permitId).executeTakeFirst();
  },

  revocations(trx: Transaction, scope: string): Promise<RevocationEvent[]> {
    return trx.selectFrom('revocation_event').selectAll().where('scope', '=', scope).orderBy('id').execute();
  },
};

export class AdmissionLeaseExpiredError extends Error {
  constructor(readonly leaseId: string) {
    super(`admission lease ${leaseId} expired before the dispatch finished; treat the outcome as unknown`);
    this.name = 'AdmissionLeaseExpiredError';
  }
}

export interface GateOptions { leaseMs?: number; ttlMs?: number }
export type GateResult<T> = { admitted: true; value: T; leaseId: string } | { admitted: false; reason: AdmissionDenyReason };

/**
 * Pool-level gate for API and worker nodes: `issue` is the preflight, `admit` consumes the permit in its own
 * transaction, runs the dispatch inside the bounded lease and settles the lease afterwards. A dispatch that outlives
 * its lease raises `AdmissionLeaseExpiredError` (outcome unknown; bytes may already have left).
 */
export class AdmissionGate {
  constructor(private readonly pool: DataPool, private readonly defaults: Required<GateOptions> = { leaseMs: 30_000, ttlMs: 60_000 }) {}

  issue(principal: Principal, request: EgressRequest, scopes: readonly string[], ttlMs = this.defaults.ttlMs): Promise<EgressPermit> {
    return withPrincipal(this.pool, principal, (trx) => admission.issue(trx, request, { scopes, ttlMs }));
  }

  async admit<T>(principal: Principal, request: EgressRequest, permit: EgressPermit, dispatch: () => Promise<T>, leaseMs = this.defaults.leaseMs): Promise<GateResult<T>> {
    const check = await withPrincipal(this.pool, principal, (trx) => admission.admit(trx, request, permit, { leaseMs }));
    if (!check.admitted) return check;
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AdmissionLeaseExpiredError(check.leaseId)), Math.max(0, check.leaseUntil.getTime() - Date.now()));
    });
    try {
      const value = await Promise.race([dispatch(), expiry]);
      await withPrincipal(this.pool, principal, (trx) => admission.settle(trx, check.leaseId, 'dispatched'));
      return { admitted: true, value, leaseId: check.leaseId };
    } catch (error) {
      const outcome: AdmissionOutcome = error instanceof AdmissionLeaseExpiredError ? 'lease_expired' : 'failed';
      await withPrincipal(this.pool, principal, (trx) => admission.settle(trx, check.leaseId, outcome)).catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  revoke(principal: Principal, scope: string, reason: string): Promise<bigint> {
    return withPrincipal(this.pool, principal, (trx) => admission.revoke(trx, scope, reason));
  }

  /** Frozen port shape for RAG-201 / RAG-301 consumers; scopes are derived by the caller's authorization layer. */
  forPrincipal(principal: Principal, scopes: readonly string[]): EgressAdmissionPort {
    return {
      issue: (request) => this.issue(principal, request, scopes),
      admit: async <T>(request: EgressRequest, permit: EgressPermit, dispatch: () => Promise<T>) => {
        const result = await this.admit(principal, request, permit, dispatch);
        return result.admitted ? { admitted: true as const, value: result.value } : { admitted: false as const };
      },
    };
  }
}
