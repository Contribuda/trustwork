import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type {
  ConnectionTestRow, EgressRuleRow, ModelPricingRow, ModelRefJson, ModelRouteRow, ProviderBudgetRow, ProviderConfigChangeRow, ProviderConnectionRow, ProviderRouteKillSwitchRow,
  ProviderUsageRow, SecretRefRow,
} from '../schema/providers.js';
import type { KillSwitchRow } from '../schema/admin.js';
import type { CommandContext } from './admin.js';

/**
 * Providers repository (KEYS-001, migration packages/data/migrations/providers).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext` (BE-004 elevation): each calls one `providers_*`
 *   SECURITY DEFINER command that resolves the caller's permission at the hub, enforces the second-person rules and
 *   the guard rails, and writes the admin audit row and the change-log row in the same transaction.
 * - **Reads** under row-level security: staff covering a hub read its connections, secret references (never
 *   ciphertext), tests, caps, routes, egress cells, cost records, kill switches, spend ledger and change log.
 * - **The call gate** without a principal (API or worker): authorize, settle or release a call, and fetch the sealed
 *   secret of an open decision. Nothing here ever returns or accepts a plaintext secret.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);

async function one<T>(query: Promise<{ rows: T[] }>, what: string): Promise<T> {
  const { rows } = await query;
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export type HostingInput =
  | { kind: 'self_hosted'; country: string }
  | { kind: 'vendor'; country: string; zeroRetention: boolean; trainsOnInputs: boolean; broker: boolean };
export interface ConnectionInput {
  label: string;
  capabilities: string[];
  endpoint: string | null;
  hosting: HostingInput;
  storageCountry: string | null;
  region: string | null;
  credentialRefId: string | null;
}
/** A secret sealed by the API (envelope encryption); the plaintext never reaches this layer. */
export interface SealedSecretInput { fingerprint: string; ciphertext: Buffer; iv: Buffer; authTag: Buffer; wrappedKey: Buffer; kekId: string }
export interface SealedSecretRow {
  secret_ref_id: string | null;
  ciphertext: Buffer | null;
  iv: Buffer | null;
  auth_tag: Buffer | null;
  wrapped_key: Buffer | null;
  kek_id: string | null;
  credential_store: string | null;
  credential_ref: string | null;
}
export interface TestMaterialRow extends SealedSecretRow { config_digest: string; credential_status: string | null }
export interface TestResultInput { configDigest: string; outcome: string; latencyMs: number | null; modelsListed: number | null; cost: { minorUnits: string; currency: string } | null; probeDigest: string; secretRefId: string | null }
export interface RouteInput {
  job: string;
  scope: { kind: 'job' } | { kind: 'module'; moduleKey: string } | { kind: 'extension'; extensionId: string };
  primary: ModelRefJson;
  fallbacks: ModelRefJson[];
  allowedDataClasses: string[];
  limits: { maxInputTokens: number; maxOutputTokens: number; maxFileBytes: number | null; timeoutMs: number };
  budgetId: string | null;
}
export interface BudgetInput {
  scope: { kind: 'hub' } | { kind: 'job'; job: string } | { kind: 'pipeline'; pipelineId: string } | { kind: 'agent_module'; moduleKey: string } | { kind: 'connection'; connectionId: string };
  period: 'day' | 'month';
  limit: { minorUnits: string; currency: string };
  alertAtPercent: number[];
  onExhausted: 'pause' | 'deny_new';
}
export interface PricingInput {
  connectionId: string;
  modelId: string;
  currency: string;
  inputPerMillionTokens: string | null;
  outputPerMillionTokens: string | null;
  perImage: string | null;
  perAudioMinute: string | null;
  basis: 'provider_list' | 'contract' | 'measured';
  observedAt: string;
  sourceNote: string | null;
}
export type KillTargetInput =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'route'; job: string; scope: RouteInput['scope'] };

const hostingParams = (h: HostingInput) => ({
  kind: h.kind, country: h.country,
  zero: h.kind === 'vendor' ? h.zeroRetention : null, trains: h.kind === 'vendor' ? h.trainsOnInputs : null, broker: h.kind === 'vendor' ? h.broker : null,
});
const scopeParams = (s: RouteInput['scope']) => ({ kind: s.kind, module: s.kind === 'module' ? s.moduleKey : null, extension: s.kind === 'extension' ? s.extensionId : null });

export const providerConnections = {
  create(trx: Transaction, ctx: CommandContext, hubId: string, input: ConnectionInput & { adapterId: string; mode: string }): Promise<ProviderConnectionRow> {
    const h = hostingParams(input.hosting);
    return one(sql<ProviderConnectionRow>`SELECT * FROM trustwork.providers_create_connection(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${input.adapterId}::text, ${input.mode}::text,
      ${input.label}::text, ${input.capabilities}::text[], ${input.endpoint}::text, ${h.kind}::text, ${h.country}::text, ${h.zero}::boolean, ${h.trains}::boolean, ${h.broker}::boolean,
      ${input.storageCountry}::text, ${input.region}::text, ${input.credentialRefId}::uuid)`.execute(trx), 'providers_create_connection');
  },
  update(trx: Transaction, ctx: CommandContext, connectionId: string, expectedRevision: number, input: ConnectionInput): Promise<ProviderConnectionRow> {
    const h = hostingParams(input.hosting);
    return one(sql<ProviderConnectionRow>`SELECT * FROM trustwork.providers_update_connection(${ctxJson(ctx)}::jsonb, ${connectionId}::uuid, ${expectedRevision}::integer,
      ${input.label}::text, ${input.capabilities}::text[], ${input.endpoint}::text, ${h.kind}::text, ${h.country}::text, ${h.zero}::boolean, ${h.trains}::boolean, ${h.broker}::boolean,
      ${input.storageCountry}::text, ${input.region}::text, ${input.credentialRefId}::uuid)`.execute(trx), 'providers_update_connection');
  },
  /** Stores a sealed secret as the next version; the previous version enters its grace period (0 hours destroys it). */
  storeSecret(trx: Transaction, ctx: CommandContext, connectionId: string, expectedRevision: number, sealed: SealedSecretInput, graceHours: number): Promise<SecretRefRow> {
    return one(sql<SecretRefRow>`SELECT * FROM trustwork.providers_store_secret(${ctxJson(ctx)}::jsonb, ${connectionId}::uuid, ${expectedRevision}::integer, ${sealed.fingerprint}::text,
      ${sealed.ciphertext}::bytea, ${sealed.iv}::bytea, ${sealed.authTag}::bytea, ${sealed.wrappedKey}::bytea, ${sealed.kekId}::text, ${graceHours}::integer)`.execute(trx), 'providers_store_secret');
  },
  revokeSecret(trx: Transaction, ctx: CommandContext, connectionId: string, expectedRevision: number): Promise<ProviderConnectionRow> {
    return one(sql<ProviderConnectionRow>`SELECT * FROM trustwork.providers_revoke_secret(${ctxJson(ctx)}::jsonb, ${connectionId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'providers_revoke_secret');
  },
  testMaterial(trx: Transaction, ctx: CommandContext, connectionId: string): Promise<TestMaterialRow> {
    return one(sql<TestMaterialRow>`SELECT * FROM trustwork.providers_test_material(${ctxJson(ctx)}::jsonb, ${connectionId}::uuid)`.execute(trx), 'providers_test_material');
  },
  recordTest(trx: Transaction, ctx: CommandContext, connectionId: string, result: TestResultInput): Promise<ConnectionTestRow> {
    return one(sql<ConnectionTestRow>`SELECT * FROM trustwork.providers_record_test(${ctxJson(ctx)}::jsonb, ${connectionId}::uuid, ${result.configDigest}::text, ${result.outcome}::text,
      ${result.latencyMs}::integer, ${result.modelsListed}::integer, ${result.cost?.minorUnits ?? null}::bigint, ${result.cost?.currency ?? null}::text, ${result.probeDigest}::text,
      ${result.secretRefId}::uuid)`.execute(trx), 'providers_record_test');
  },
  /** A non-fake connection consumes `providers.enable_non_fake` bound to `connectionEnableDigestInput`. */
  enable(trx: Transaction, ctx: CommandContext, connectionId: string, expectedRevision: number, approvalId: string | null): Promise<ProviderConnectionRow> {
    return one(sql<ProviderConnectionRow>`SELECT * FROM trustwork.providers_enable_connection(${ctxJson(ctx)}::jsonb, ${connectionId}::uuid, ${expectedRevision}::integer,
      ${approvalId}::uuid)`.execute(trx), 'providers_enable_connection');
  },
  disable(trx: Transaction, ctx: CommandContext, connectionId: string, expectedRevision: number): Promise<ProviderConnectionRow> {
    return one(sql<ProviderConnectionRow>`SELECT * FROM trustwork.providers_disable_connection(${ctxJson(ctx)}::jsonb, ${connectionId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'providers_disable_connection');
  },
  list(trx: Transaction, hubId: string): Promise<ProviderConnectionRow[]> {
    return trx.selectFrom('provider_connection').selectAll().where('hub_id', '=', hubId).orderBy('created_at').orderBy('id').execute();
  },
  get(trx: Transaction, connectionId: string): Promise<ProviderConnectionRow | undefined> {
    return trx.selectFrom('provider_connection').selectAll().where('id', '=', connectionId).executeTakeFirst();
  },
  secretRefs(trx: Transaction, hubId: string): Promise<SecretRefRow[]> {
    return trx.selectFrom('secret_ref').selectAll().where('hub_id', '=', hubId).orderBy('connection_id').orderBy('version', 'desc').execute();
  },
  tests(trx: Transaction, hubId: string): Promise<ConnectionTestRow[]> {
    return trx.selectFrom('connection_test').selectAll().where('hub_id', '=', hubId).orderBy('tested_at', 'desc').execute();
  },
  /** Residency, the engaged kill switch and the current configuration digest of each connection (staff readers). */
  async facts(trx: Transaction, hubId: string): Promise<{ connection_id: string; in_residency: boolean; kill_switch_id: string | null; config_digest: string }[]> {
    const { rows } = await sql<{ connection_id: string; in_residency: boolean; kill_switch_id: string | null; config_digest: string }>`SELECT * FROM trustwork.providers_connection_facts(${hubId}::uuid)`.execute(trx);
    return rows;
  },
};

export const egressRules = {
  /** A non-public allow consumes `egress.allow_private_class` bound to `egressAllowDigestInput` with the next version. */
  set(trx: Transaction, ctx: CommandContext, input: { connectionId: string; dataClass: string; decision: 'allow' | 'deny'; requireInResidency: boolean; requireZeroRetention: boolean; approvalId: string | null }): Promise<EgressRuleRow> {
    return one(sql<EgressRuleRow>`SELECT * FROM trustwork.providers_set_egress_rule(${ctxJson(ctx)}::jsonb, ${input.connectionId}::uuid, ${input.dataClass}::text, ${input.decision}::text,
      ${input.requireInResidency}::boolean, ${input.requireZeroRetention}::boolean, ${input.approvalId}::uuid)`.execute(trx), 'providers_set_egress_rule');
  },
  list(trx: Transaction, hubId: string): Promise<EgressRuleRow[]> {
    return trx.selectFrom('egress_rule').selectAll().where('hub_id', '=', hubId).orderBy('connection_id').orderBy('data_class').orderBy('version', 'desc').execute();
  },
  async nextVersion(trx: Transaction, connectionId: string, dataClass: string): Promise<number> {
    const row = await trx.selectFrom('egress_rule').select((eb) => eb.fn.max('version').as('v')).where('connection_id', '=', connectionId).where('data_class', '=', dataClass).executeTakeFirst();
    return Number(row?.v ?? 0) + 1;
  },
};

export const modelRoutes = {
  draft(trx: Transaction, ctx: CommandContext, hubId: string, input: RouteInput): Promise<ModelRouteRow> {
    const s = scopeParams(input.scope);
    return one(sql<ModelRouteRow>`SELECT * FROM trustwork.providers_draft_route(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${input.job}::text, ${s.kind}::text, ${s.module}::text, ${s.extension}::uuid,
      ${JSON.stringify(input.primary)}::jsonb, ${JSON.stringify(input.fallbacks)}::jsonb, ${input.allowedDataClasses}::text[], ${input.limits.maxInputTokens}::integer,
      ${input.limits.maxOutputTokens}::integer, ${input.limits.maxFileBytes}::bigint, ${input.limits.timeoutMs}::integer, ${input.budgetId}::uuid)`.execute(trx), 'providers_draft_route');
  },
  /** A route that may carry non-public data consumes `models.activate_private_route` bound to `routeActivationDigestInput`. */
  activate(trx: Transaction, ctx: CommandContext, routeId: string, expectedRevision: number, approvalId: string | null): Promise<ModelRouteRow> {
    return one(sql<ModelRouteRow>`SELECT * FROM trustwork.providers_activate_route(${ctxJson(ctx)}::jsonb, ${routeId}::uuid, ${expectedRevision}::integer, ${approvalId}::uuid)`.execute(trx), 'providers_activate_route');
  },
  disable(trx: Transaction, ctx: CommandContext, routeId: string, expectedRevision: number): Promise<ModelRouteRow> {
    return one(sql<ModelRouteRow>`SELECT * FROM trustwork.providers_disable_route(${ctxJson(ctx)}::jsonb, ${routeId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'providers_disable_route');
  },
  list(trx: Transaction, hubId: string): Promise<ModelRouteRow[]> {
    return trx.selectFrom('model_route').selectAll().where('hub_id', '=', hubId).orderBy('job').orderBy('scope_kind').orderBy('version', 'desc').execute();
  },
  get(trx: Transaction, routeId: string): Promise<ModelRouteRow | undefined> {
    return trx.selectFrom('model_route').selectAll().where('id', '=', routeId).executeTakeFirst();
  },
};

export const providerBudgets = {
  create(trx: Transaction, ctx: CommandContext, hubId: string, input: BudgetInput): Promise<ProviderBudgetRow> {
    const s = input.scope;
    return one(sql<ProviderBudgetRow>`SELECT * FROM trustwork.providers_create_budget(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${s.kind}::text, ${s.kind === 'job' ? s.job : null}::text,
      ${s.kind === 'pipeline' ? s.pipelineId : null}::uuid, ${s.kind === 'agent_module' ? s.moduleKey : null}::text, ${s.kind === 'connection' ? s.connectionId : null}::uuid,
      ${input.period}::text, ${input.limit.minorUnits}::bigint, ${input.limit.currency}::text, ${input.alertAtPercent}::integer[], ${input.onExhausted}::text)`.execute(trx), 'providers_create_budget');
  },
  update(trx: Transaction, ctx: CommandContext, budgetId: string, expectedRevision: number, input: Pick<BudgetInput, 'limit' | 'alertAtPercent' | 'onExhausted'>): Promise<ProviderBudgetRow> {
    return one(sql<ProviderBudgetRow>`SELECT * FROM trustwork.providers_update_budget(${ctxJson(ctx)}::jsonb, ${budgetId}::uuid, ${expectedRevision}::integer, ${input.limit.minorUnits}::bigint,
      ${input.limit.currency}::text, ${input.alertAtPercent}::integer[], ${input.onExhausted}::text)`.execute(trx), 'providers_update_budget');
  },
  retire(trx: Transaction, ctx: CommandContext, budgetId: string, expectedRevision: number): Promise<ProviderBudgetRow> {
    return one(sql<ProviderBudgetRow>`SELECT * FROM trustwork.providers_retire_budget(${ctxJson(ctx)}::jsonb, ${budgetId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'providers_retire_budget');
  },
  list(trx: Transaction, hubId: string): Promise<ProviderBudgetRow[]> {
    return trx.selectFrom('provider_budget').selectAll().where('hub_id', '=', hubId).orderBy('created_at').orderBy('id').execute();
  },
  get(trx: Transaction, budgetId: string): Promise<ProviderBudgetRow | undefined> {
    return trx.selectFrom('provider_budget').selectAll().where('id', '=', budgetId).executeTakeFirst();
  },
  async usage(trx: Transaction, hubId: string): Promise<{ budget_id: string; period_start: Date; spent: string; reserved: string }[]> {
    const { rows } = await sql<{ budget_id: string; period_start: Date; spent: string; reserved: string }>`SELECT * FROM trustwork.providers_cap_usage(${hubId}::uuid)`.execute(trx);
    return rows;
  },
};

export const modelPricing = {
  /** A new cost record version; it never changes a billing price. */
  record(trx: Transaction, ctx: CommandContext, input: PricingInput): Promise<ModelPricingRow> {
    return one(sql<ModelPricingRow>`SELECT * FROM trustwork.providers_record_pricing(${ctxJson(ctx)}::jsonb, ${input.connectionId}::uuid, ${input.modelId}::text, ${input.currency}::text,
      ${input.inputPerMillionTokens}::numeric, ${input.outputPerMillionTokens}::numeric, ${input.perImage}::numeric, ${input.perAudioMinute}::numeric, ${input.basis}::text,
      ${input.observedAt}::timestamptz, ${input.sourceNote}::text)`.execute(trx), 'providers_record_pricing');
  },
  list(trx: Transaction, hubId: string): Promise<ModelPricingRow[]> {
    return trx.selectFrom('model_pricing').selectAll().where('hub_id', '=', hubId).orderBy('connection_id').orderBy('model_id').orderBy('version', 'desc').execute();
  },
};

export const providerKills = {
  async engage(trx: Transaction, ctx: CommandContext, hubId: string, target: KillTargetInput): Promise<{ kind: 'connection' | 'route'; id: string }> {
    const s = target.kind === 'route' ? scopeParams(target.scope) : { kind: null, module: null, extension: null };
    return one(sql<{ kind: 'connection' | 'route'; id: string }>`SELECT * FROM trustwork.providers_engage_kill(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${target.kind}::text,
      ${target.kind === 'connection' ? target.connectionId : null}::uuid, ${target.kind === 'route' ? target.job : null}::text, ${s.kind}::text, ${s.module}::text,
      ${s.extension}::uuid)`.execute(trx), 'providers_engage_kill');
  },
  /** Needs an approval of `kill_switch.release` with `providerKillReleaseDigestInput`, requested by the releaser. */
  async release(trx: Transaction, ctx: CommandContext, hubId: string, killSwitchId: string, approvalId: string | null, incidentNote: string): Promise<{ kind: 'connection' | 'route'; id: string }> {
    return one(sql<{ kind: 'connection' | 'route'; id: string }>`SELECT * FROM trustwork.providers_release_kill(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${killSwitchId}::uuid, ${approvalId}::uuid,
      ${incidentNote}::text)`.execute(trx), 'providers_release_kill');
  },
  routeSwitches(trx: Transaction, hubId: string): Promise<ProviderRouteKillSwitchRow[]> {
    return trx.selectFrom('provider_route_kill_switch').selectAll().where('hub_id', '=', hubId).orderBy('engaged_at', 'desc').execute();
  },
  /** Connection switches are DATA-002's kill_switch rows of scope `provider_connection` at this hub (readable by everyone). */
  connectionSwitches(trx: Transaction, hubId: string): Promise<KillSwitchRow[]> {
    return trx.selectFrom('kill_switch').selectAll().where('hub_id', '=', hubId).where('scope_kind', '=', 'provider_connection').orderBy('engaged_at', 'desc').execute();
  },
};

export const providerChanges = {
  list(trx: Transaction, hubId: string, filter: { objectType?: string | undefined; objectId?: string | undefined; limit?: number | undefined } = {}): Promise<ProviderConfigChangeRow[]> {
    let q = trx.selectFrom('provider_config_change').selectAll().where('hub_id', '=', hubId);
    if (filter.objectType) q = q.where('object_type', '=', filter.objectType);
    if (filter.objectId) q = q.where('object_id', '=', filter.objectId);
    return q.orderBy('occurred_at', 'desc').orderBy('id').limit(Math.min(Math.max(filter.limit ?? 200, 1), 500)).execute();
  },
};

export interface UsageAggregateRow {
  day: Date; job: string; connection_id: string | null; model_id: string | null; pipeline_id: string | null; module_key: string | null;
  calls: number; input_tokens: string; output_tokens: string; images: string; audio_seconds: string; cost_minor: string; currency: string;
}
export const providerUsage = {
  /** Calls, units and cost by day, job, connection, model, pipeline and module; never per person (the ledger has none). */
  async aggregate(trx: Transaction, hubId: string, from: Date, to: Date): Promise<UsageAggregateRow[]> {
    const { rows } = await sql<UsageAggregateRow>`SELECT date_trunc('day', created_at) AS day, job, connection_id, model_id, pipeline_id, module_key, count(*)::int AS calls,
        coalesce(sum(input_tokens), 0)::text AS input_tokens, coalesce(sum(output_tokens), 0)::text AS output_tokens, coalesce(sum(images), 0)::text AS images,
        coalesce(sum(audio_seconds), 0)::text AS audio_seconds, coalesce(sum(cost_minor), 0)::text AS cost_minor, currency
      FROM trustwork.provider_usage
      WHERE hub_id = ${hubId}::uuid AND state = 'settled' AND created_at >= ${from} AND created_at < ${to}
      GROUP BY 1, job, connection_id, model_id, pipeline_id, module_key, currency ORDER BY 1, job`.execute(trx);
    return rows;
  },
  list(trx: Transaction, hubId: string): Promise<ProviderUsageRow[]> {
    return trx.selectFrom('provider_usage').selectAll().where('hub_id', '=', hubId).orderBy('created_at').execute();
  },
};

type Executor = Transaction | DataPool;
function isPool(x: Executor): x is DataPool {
  return typeof (x as DataPool).query === 'function' && typeof (x as Transaction).selectFrom !== 'function';
}
async function rows<T>(db: Executor, text: string, params: unknown[]): Promise<T[]> {
  if (isPool(db)) return (await db.query(text, params)).rows as T[];
  // Kysely: the same statement as a tagged template, parameters in order ($1, $2, ... appear once each, ascending).
  const parts = text.split(/\$\d+/);
  const strings = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
  return (await sql<T>(strings, ...params).execute(db)).rows;
}

/** The call gate for LLM-001 and every provider adapter call (API or worker; no principal). */
export const providerCalls = {
  /** `ProviderCallRequestSchema` in, `ProviderCallDecisionSchema` out; a dry run reserves nothing. */
  async authorize(db: Executor, request: unknown, dryRun = false): Promise<Record<string, unknown>> {
    const [row] = await rows<{ d: Record<string, unknown> }>(db, 'SELECT trustwork.providers_authorize_call($1::jsonb, $2::boolean) AS d', [JSON.stringify(request), dryRun]);
    return row!.d;
  },
  async settle(db: Executor, decisionId: string, input: { connectionId: string; modelId: string; outcome: 'succeeded' | 'failed' | 'unknown'; costMinorUnits: string; inputTokens?: number; outputTokens?: number; images?: number; audioSeconds?: number }): Promise<ProviderUsageRow> {
    const [row] = await rows<ProviderUsageRow>(db, 'SELECT * FROM trustwork.providers_settle_call($1::uuid, $2::uuid, $3::text, $4::text, $5::bigint, $6::integer, $7::integer, $8::integer, $9::integer)', [
      decisionId, input.connectionId, input.modelId, input.outcome, input.costMinorUnits, input.inputTokens ?? null, input.outputTokens ?? null, input.images ?? null, input.audioSeconds ?? null,
    ]);
    return row!;
  },
  async release(db: Executor, decisionId: string): Promise<ProviderUsageRow> {
    const [row] = await rows<ProviderUsageRow>(db, 'SELECT * FROM trustwork.providers_release_call($1::uuid)', [decisionId]);
    return row!;
  },
  /** The sealed secret of an open decision's connection (decrypted only by the API or worker that holds the key). */
  async secret(db: Executor, decisionId: string, connectionId: string): Promise<SealedSecretRow> {
    const [row] = await rows<SealedSecretRow>(db, 'SELECT * FROM trustwork.providers_call_secret($1::uuid, $2::uuid)', [decisionId, connectionId]);
    return row!;
  },
};

export const providerSweeps = {
  /** Worker: destroys rotated secret versions whose grace period ended; returns how many. */
  async destroyExpiredSecrets(db: Executor, limit = 200): Promise<number> {
    const [row] = await rows<{ n: number }>(db, 'SELECT trustwork.providers_destroy_expired_secrets($1::integer) AS n', [limit]);
    return row!.n;
  },
};
