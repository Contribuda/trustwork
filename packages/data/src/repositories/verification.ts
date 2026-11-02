import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { VerificationCheckResult, VerificationCheckRow, VerificationProviderRow, VerificationRecipeRow, VerificationStepJson } from '../schema/verification.js';
import type { CommandContext } from './admin.js';
import '../schema/verification.js';

/**
 * Counterparty verification (HUB-003, migration packages/data/migrations/verification).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext`: each calls one `verification_*` SECURITY DEFINER
 *   command that checks the permission at the hub (`admin.claims.policy.edit` for providers and recipes,
 *   `admin.claims.decide` for results) and writes the admin audit row in the same transaction. Live mode consumes a
 *   second person's approval; the sanctions check reads SANC-003 and stores only a reference.
 * - **Reads** under row-level security: staff of the hub with a claims permission.
 * - **Worker**: the re-check list (`verification_due_rechecks`).
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
const json = (v: unknown): string => JSON.stringify(v);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export type VerificationSubjectKind = 'company' | 'person';
export interface RegisterProviderInput {
  checkType: string;
  adapter: string;
  mode: 'fake' | 'manual';
  retentionDays: number;
  legalBasis: string;
  costMinor: string | null;
}
export interface DraftRecipeInput {
  key: string;
  subjectKind: VerificationSubjectKind;
  trigger: string;
  steps: VerificationStepJson[];
  badgeCategories: string[];
  recheckMonths: number;
}
export interface VerificationStanding {
  status: 'passed' | 'pending' | 'failed';
  missing: string[];
  failed: string[];
  handoverBlocked: boolean;
  badgeCategories: string[];
  expiresAt: string | null;
}

export const verification = {
  registerProvider(trx: Transaction, ctx: CommandContext, hubId: string, input: RegisterProviderInput): Promise<VerificationProviderRow> {
    return one(sql<VerificationProviderRow>`SELECT * FROM trustwork.verification_register_provider(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${json(input)}::jsonb)`, trx,
      'verification_register_provider');
  },
  goLive(trx: Transaction, ctx: CommandContext, providerId: string, expectedRevision: number, credentialRefId: string | null, approvalId: string | null): Promise<VerificationProviderRow> {
    return one(sql<VerificationProviderRow>`SELECT * FROM trustwork.verification_go_live(${ctxJson(ctx)}::jsonb, ${providerId}::uuid, ${expectedRevision}::int, ${credentialRefId}::uuid,
      ${approvalId}::uuid)`, trx, 'verification_go_live');
  },
  draftRecipe(trx: Transaction, ctx: CommandContext, hubId: string, input: DraftRecipeInput): Promise<VerificationRecipeRow> {
    return one(sql<VerificationRecipeRow>`SELECT * FROM trustwork.verification_draft_recipe(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${json(input)}::jsonb)`, trx, 'verification_draft_recipe');
  },
  activateRecipe(trx: Transaction, ctx: CommandContext, recipeId: string, expectedRevision: number): Promise<VerificationRecipeRow> {
    return one(sql<VerificationRecipeRow>`SELECT * FROM trustwork.verification_activate_recipe(${ctxJson(ctx)}::jsonb, ${recipeId}::uuid, ${expectedRevision}::int)`, trx,
      'verification_activate_recipe');
  },
  recordCheck(trx: Transaction, ctx: CommandContext, hubId: string, subject: { kind: VerificationSubjectKind; id: string }, recipeId: string, providerId: string,
    result: VerificationCheckResult, evidenceRef: string | null): Promise<VerificationCheckRow> {
    return one(sql<VerificationCheckRow>`SELECT * FROM trustwork.verification_record_check(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${subject.kind}::text, ${subject.id}::uuid,
      ${recipeId}::uuid, ${providerId}::uuid, ${result}::text, ${evidenceRef}::text)`, trx, 'verification_record_check');
  },
  recordScreening(trx: Transaction, ctx: CommandContext, hubId: string, subject: { kind: VerificationSubjectKind; id: string }, recipeId: string): Promise<VerificationCheckRow> {
    return one(sql<VerificationCheckRow>`SELECT * FROM trustwork.verification_record_screening(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${subject.kind}::text, ${subject.id}::uuid,
      ${recipeId}::uuid)`, trx, 'verification_record_screening');
  },
  async evaluate(trx: Transaction, hubId: string, subject: { kind: VerificationSubjectKind; id: string }, recipeId: string): Promise<VerificationStanding> {
    const row = await one(sql<{ v: VerificationStanding }>`SELECT trustwork.verification_evaluate(${hubId}::uuid, ${subject.kind}::text, ${subject.id}::uuid, ${recipeId}::uuid) AS v`, trx,
      'verification_evaluate');
    return row.v;
  },
  /** The digest a second person approves (`providers.enable_non_fake`) before a provider goes live. */
  async liveDigest(trx: Transaction, providerId: string, revision: number, credentialRefId: string): Promise<string> {
    const row = await one(sql<{ v: string }>`SELECT trustwork.verification_provider_digest(${providerId}::uuid, ${revision}::int, ${credentialRefId}::uuid) AS v`, trx,
      'verification_provider_digest');
    return row.v;
  },

  providers(trx: Transaction, hubId: string): Promise<VerificationProviderRow[]> {
    return trx.selectFrom('verification_provider').selectAll().where('hub_id', '=', hubId).orderBy('created_at').execute();
  },
  recipes(trx: Transaction, hubId: string): Promise<VerificationRecipeRow[]> {
    return trx.selectFrom('verification_recipe').selectAll().where('hub_id', '=', hubId).orderBy('key').orderBy('version').execute();
  },
  recipe(trx: Transaction, recipeId: string): Promise<VerificationRecipeRow | undefined> {
    return trx.selectFrom('verification_recipe').selectAll().where('id', '=', recipeId).executeTakeFirst();
  },
  checksOf(trx: Transaction, hubId: string, subject: { kind: VerificationSubjectKind; id: string }): Promise<VerificationCheckRow[]> {
    return trx.selectFrom('verification_check').selectAll().where('hub_id', '=', hubId)
      .where(subject.kind === 'person' ? 'subject_person_id' : 'subject_company_id', '=', subject.id).orderBy('recorded_at', 'desc').execute();
  },
};

export const verificationWorker = {
  /** Results that expire within `days` (the latest per recipe, subject and check type). */
  dueRechecks(trx: Transaction, hubId: string, days: number): Promise<Array<{ check_id: string; subject_kind: VerificationSubjectKind; subject_id: string; recipe_id: string; check_type: string; expires_at: Date }>> {
    return sql<{ check_id: string; subject_kind: VerificationSubjectKind; subject_id: string; recipe_id: string; check_type: string; expires_at: Date }>`
      SELECT * FROM trustwork.verification_due_rechecks(${hubId}::uuid, ${days}::int)`.execute(trx).then((r) => r.rows);
  },
};
