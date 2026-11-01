import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { LegalHoldRow, PrivacyExportRow, PrivacyPreferenceRow, PrivacyRequestRow } from '../schema/privacy.js';
import type { CommandContext } from './admin.js';

export const privacy = {
  async proposePlan(trx: Transaction, ctx: CommandContext, requestId: string, grantId: string): Promise<{ id: string; digest: string; approvalId: string; state: 'proposed'; snapshot: Record<string, unknown> }> {
    return (await sql<{ result: { id: string; digest: string; approvalId: string; state: 'proposed'; snapshot: Record<string, unknown> } }>`SELECT trustwork.privacy_plan_propose(${JSON.stringify(ctx)}::jsonb, ${requestId}::uuid, ${grantId}::uuid) AS result`.execute(trx)).rows[0]!.result;
  },
  async approvePlan(trx: Transaction, ctx: CommandContext, id: string, grantId: string, digest: string): Promise<{ id: string; digest: string; state: 'approved'; executable: false }> {
    return (await sql<{ result: { id: string; digest: string; state: 'approved'; executable: false } }>`SELECT trustwork.privacy_plan_approve(${JSON.stringify(ctx)}::jsonb, ${id}::uuid, ${grantId}::uuid, ${digest}) AS result`.execute(trx)).rows[0]!.result;
  },
  async executePlan(trx: Transaction, ctx: CommandContext, id: string, digest: string): Promise<{ status: 'blocked' | 'invalidated'; complete: false; reason: string; gaps: { module: string; action: string; gap: string }[] }> {
    return (await sql<{ result: { status: 'blocked' | 'invalidated'; complete: false; reason: string; gaps: { module: string; action: string; gap: string }[] } }>`SELECT trustwork.privacy_plan_execute(${JSON.stringify(ctx)}::jsonb, ${id}::uuid, ${digest}) AS result`.execute(trx)).rows[0]!.result;
  },
  async sourceProof(trx: Transaction, ctx: CommandContext, input: { sourceFieldId: string; grantId: string; action: string; tokenHash: string; method: string; evidenceRef: string }): Promise<string> {
    return (await sql<{ id: string }>`SELECT trustwork.privacy_source_prove(${JSON.stringify(ctx)}::jsonb, ${input.sourceFieldId}::uuid, ${input.grantId}::uuid,
      ${input.action}, ${input.tokenHash}, ${input.method}, ${input.evidenceRef}::uuid) AS id`.execute(trx)).rows[0]!.id;
  },
  async registryReceive(trx: Transaction, ctx: CommandContext, registrationId: string, items: unknown): Promise<{ status: 'UNKNOWN' | 'not_due' | 'received'; received: number; nextPollAt: string | null }> {
    return (await sql<{ result: { status: 'UNKNOWN' | 'not_due' | 'received'; received: number; nextPollAt: string | null } }>`SELECT trustwork.privacy_registry_receive(${JSON.stringify(ctx)}::jsonb, ${registrationId}::uuid, ${JSON.stringify(items)}::jsonb) AS result`.execute(trx)).rows[0]!.result;
  },
  /** Worker-only; the delivery row must already be locked. Keep this transaction through dispatch. */
  async marketingAllowed(trx: Transaction, digest: string): Promise<boolean> {
    return (await sql<{ allowed: boolean }>`SELECT trustwork.privacy_marketing_allowed(${digest}) AS allowed`.execute(trx)).rows[0]?.allowed === true;
  },
  async authorized(trx: Transaction, kind: 'person' | 'company', id: string): Promise<boolean> {
    const r = await sql<{ allowed: boolean }>`SELECT trustwork.privacy_subject_authorized(${kind}, ${id}::uuid) AS allowed`.execute(trx);
    return r.rows[0]?.allowed === true;
  },
  async request(trx: Transaction, input: unknown): Promise<PrivacyRequestRow> {
    return (await sql<PrivacyRequestRow>`SELECT * FROM trustwork.privacy_request_create(${JSON.stringify(input)}::jsonb)`.execute(trx)).rows[0]!;
  },
  requests(trx: Transaction) { return trx.selectFrom('privacy_request').selectAll().orderBy('created_at').orderBy('id').execute(); },
  async preference(trx: Transaction, input: unknown): Promise<PrivacyPreferenceRow> {
    return (await sql<PrivacyPreferenceRow>`SELECT * FROM trustwork.privacy_preference_set(${JSON.stringify(input)}::jsonb)`.execute(trx)).rows[0]!;
  },
  preferences(trx: Transaction) { return trx.selectFrom('privacy_preference').selectAll().executeTakeFirst(); },
  async createExport(trx: Transaction, kind: 'person' | 'company', id: string, coverage: unknown): Promise<PrivacyExportRow> {
    return (await sql<PrivacyExportRow>`SELECT * FROM trustwork.privacy_export_create(${kind}, ${id}::uuid, ${JSON.stringify(coverage)}::jsonb)`.execute(trx)).rows[0]!;
  },
  export(trx: Transaction, id: string) { return trx.selectFrom('privacy_export').selectAll().where('id', '=', id).executeTakeFirst(); },
  async hold(trx: Transaction, ctx: CommandContext, requestId: string, reasonCode: string, evidenceRef: string): Promise<LegalHoldRow> {
    return (await sql<LegalHoldRow>`SELECT * FROM trustwork.privacy_hold_place(${JSON.stringify(ctx)}::jsonb, ${requestId}::uuid, ${reasonCode}, ${evidenceRef}::uuid)`.execute(trx)).rows[0]!;
  },
  async releaseHold(trx: Transaction, ctx: CommandContext, id: string): Promise<LegalHoldRow> {
    return (await sql<LegalHoldRow>`SELECT * FROM trustwork.privacy_hold_release(${JSON.stringify(ctx)}::jsonb, ${id}::uuid)`.execute(trx)).rows[0]!;
  },
  async erasureCheck(trx: Transaction, ctx: CommandContext, id: string): Promise<{ ready: false; reason: string }> {
    return (await sql<{ result: { ready: false; reason: string } }>`SELECT trustwork.privacy_erasure_check(${JSON.stringify(ctx)}::jsonb, ${id}::uuid) AS result`.execute(trx)).rows[0]!.result;
  },
};
