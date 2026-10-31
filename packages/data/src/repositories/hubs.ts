import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type {
  CounselApprovalRow, HubConfigVersionRow, HubProfileRow, LaunchGateRow, LegalAcceptanceRow, LegalDocumentVersionRow, ProviderCredentialRefRow, RetentionPolicyRow,
} from '../schema/hubs.js';
import type { Hub as HubRow, HubTerritory as HubTerritoryRow } from '../schema/kernel.js';
import type { CommandContext } from './admin.js';

/**
 * Hubs repository (HUB-001, migration packages/data/migrations/hubs).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext` (BE-004 elevation): each calls one `hubs_*`
 *   SECURITY DEFINER command that resolves the caller's permission at the hub (or the node, for creating a hub),
 *   enforces the second-person rules and writes the audit row in the same transaction.
 * - **Reads** under row-level security: staff covering a hub read its configuration, gates, counsel records and
 *   credential references; everyone reads profiles, active legal texts and disclosed retention periods of hubs from
 *   soft launch on; a person reads their own acceptances.
 * - **Pool reads** without a principal: the presentation settings (identity, country, modes) a runtime loader reads.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);

export interface TerritoryInput { level: 'country' | 'region' | 'place'; code: string }
export interface CreateHubInput {
  slug: string;
  name: Record<string, string>;
  defaultLocale: string;
  locales: string[];
  timeZone: string;
  currency: string;
  countryPack: { code: string; version: string } | null;
  territories: TerritoryInput[];
}
export interface ProfileInput {
  name: Record<string, string>;
  defaultLocale: string;
  locales: string[];
  timeZone: string;
  currency: string;
  brandOverlay: string | null;
}

async function one<T>(query: Promise<{ rows: T[] }>, what: string): Promise<T> {
  const { rows } = await query;
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export const hubs = {
  create(trx: Transaction, ctx: CommandContext, input: CreateHubInput): Promise<HubProfileRow> {
    return one(sql<HubProfileRow>`SELECT * FROM trustwork.hubs_create(${ctxJson(ctx)}::jsonb, ${input.slug}::text, ${JSON.stringify(input.name)}::jsonb, ${input.defaultLocale}::text,
      ${input.locales}::text[], ${input.timeZone}::text, ${input.currency}::text, ${input.countryPack?.code ?? null}::text, ${input.countryPack?.version ?? null}::text,
      ${JSON.stringify(input.territories)}::jsonb)`.execute(trx), 'hubs_create');
  },
  updateProfile(trx: Transaction, ctx: CommandContext, hubId: string, expectedRevision: number, input: ProfileInput): Promise<HubProfileRow> {
    return one(sql<HubProfileRow>`SELECT * FROM trustwork.hubs_update_profile(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${expectedRevision}::integer, ${JSON.stringify(input.name)}::jsonb,
      ${input.defaultLocale}::text, ${input.locales}::text[], ${input.timeZone}::text, ${input.currency}::text, ${input.brandOverlay}::text)`.execute(trx), 'hubs_update_profile');
  },
  addTerritory(trx: Transaction, ctx: CommandContext, hubId: string, territory: TerritoryInput): Promise<HubTerritoryRow> {
    return one(sql<HubTerritoryRow>`SELECT * FROM trustwork.hubs_add_territory(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${territory.level}::text, ${territory.code}::text)`.execute(trx), 'hubs_add_territory');
  },
  removeTerritory(trx: Transaction, ctx: CommandContext, hubId: string, territoryId: string): Promise<HubTerritoryRow> {
    return one(sql<HubTerritoryRow>`SELECT * FROM trustwork.hubs_remove_territory(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${territoryId}::uuid)`.execute(trx), 'hubs_remove_territory');
  },
  /** Moves the lifecycle; soft_launch and public consume `approvalId` (hub.transition_soft_launch / hub.transition_public). */
  transition(trx: Transaction, ctx: CommandContext, hubId: string, to: string, expectedRevision: number, approvalId: string | null): Promise<HubRow> {
    return one(sql<HubRow>`SELECT * FROM trustwork.hubs_transition(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${to}::text, ${expectedRevision}::integer, ${approvalId}::uuid)`.execute(trx), 'hubs_transition');
  },
  get(trx: Transaction, hubId: string): Promise<HubRow | undefined> {
    return trx.selectFrom('hub').selectAll().where('id', '=', hubId).executeTakeFirst();
  },
  profile(trx: Transaction, hubId: string): Promise<HubProfileRow | undefined> {
    return trx.selectFrom('hub_profile').selectAll().where('hub_id', '=', hubId).executeTakeFirst();
  },
  /** Hubs with a profile that the caller may see (row-level security), newest first. */
  list(trx: Transaction): Promise<HubProfileRow[]> {
    return trx.selectFrom('hub_profile').selectAll().orderBy('created_at', 'desc').execute();
  },
  territories(trx: Transaction, hubId: string): Promise<HubTerritoryRow[]> {
    return trx.selectFrom('hub_territory').selectAll().where('hub_id', '=', hubId).orderBy('code').execute();
  },
  /** What blocks `target` now (`gate:<id>`, `modes:<violation>`, `territory:none`); staff readers only. */
  async blockers(trx: Transaction, hubId: string, target: 'soft_launch' | 'public'): Promise<string[]> {
    const { rows } = await sql<{ v: string[] }>`SELECT trustwork.hubs_transition_blockers(${hubId}::uuid, ${target}::text) AS v`.execute(trx);
    return rows[0]?.v ?? [];
  },
};

export const hubConfig = {
  draft(trx: Transaction, ctx: CommandContext, hubId: string, domain: string, payload: Record<string, unknown>, source: 'console' | 'deployment_import' = 'console'): Promise<HubConfigVersionRow> {
    return one(sql<HubConfigVersionRow>`SELECT * FROM trustwork.hubs_draft_config(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${domain}::text, ${JSON.stringify(payload)}::jsonb, ${source}::text)`.execute(trx), 'hubs_draft_config');
  },
  cancel(trx: Transaction, ctx: CommandContext, versionId: string): Promise<HubConfigVersionRow> {
    return one(sql<HubConfigVersionRow>`SELECT * FROM trustwork.hubs_cancel_config(${ctxJson(ctx)}::jsonb, ${versionId}::uuid)`.execute(trx), 'hubs_cancel_config');
  },
  /** Activates a draft; sensitive domains consume `approvalId` and refuse the drafter. */
  activate(trx: Transaction, ctx: CommandContext, versionId: string, expectedRevision: number | null, approvalId: string | null): Promise<HubConfigVersionRow> {
    return one(sql<HubConfigVersionRow>`SELECT * FROM trustwork.hubs_activate_config(${ctxJson(ctx)}::jsonb, ${versionId}::uuid, ${expectedRevision}::integer, ${approvalId}::uuid)`.execute(trx), 'hubs_activate_config');
  },
  get(trx: Transaction, versionId: string): Promise<HubConfigVersionRow | undefined> {
    return trx.selectFrom('hub_config_version').selectAll().where('id', '=', versionId).executeTakeFirst();
  },
  list(trx: Transaction, hubId: string, domain?: string): Promise<HubConfigVersionRow[]> {
    let q = trx.selectFrom('hub_config_version').selectAll().where('hub_id', '=', hubId);
    if (domain) q = q.where('domain', '=', domain);
    return q.orderBy('domain').orderBy('version', 'desc').execute();
  },
  /** The active version of every domain of the hub (the current pointers). */
  current(trx: Transaction, hubId: string): Promise<HubConfigVersionRow[]> {
    return trx.selectFrom('hub_config_current as c').innerJoin('hub_config_version as v', 'v.id', 'c.version_id').selectAll('v').where('c.hub_id', '=', hubId).orderBy('v.domain').execute();
  },
  /** Presentation settings without a principal (identity, country, modes). */
  async publicPayload(pool: DataPool, hubId: string, domain: 'identity' | 'country' | 'modes'): Promise<Record<string, unknown> | null> {
    const { rows } = await pool.query<{ v: Record<string, unknown> | null }>('SELECT trustwork.hubs_public_config($1, $2) AS v', [hubId, domain]);
    return rows[0]?.v ?? null;
  },
  retention(trx: Transaction, hubId: string): Promise<RetentionPolicyRow[]> {
    return trx.selectFrom('retention_policy as r').innerJoin('hub_config_current as c', 'c.version_id', 'r.config_version_id').selectAll('r').where('r.hub_id', '=', hubId).orderBy('r.class').execute();
  },
};

export const launchGates = {
  check(trx: Transaction, ctx: CommandContext, hubId: string, gate: string, evidenceRef: string): Promise<LaunchGateRow> {
    return one(sql<LaunchGateRow>`SELECT * FROM trustwork.hubs_check_gate(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${gate}::text, ${evidenceRef}::uuid)`.execute(trx), 'hubs_check_gate');
  },
  invalidate(trx: Transaction, ctx: CommandContext, hubId: string, gate: string): Promise<LaunchGateRow> {
    return one(sql<LaunchGateRow>`SELECT * FROM trustwork.hubs_invalidate_gate(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${gate}::text)`.execute(trx), 'hubs_invalidate_gate');
  },
  list(trx: Transaction, hubId: string): Promise<LaunchGateRow[]> {
    return trx.selectFrom('launch_gate').selectAll().where('hub_id', '=', hubId).execute();
  },
  async preconditions(trx: Transaction, hubId: string): Promise<Map<string, boolean>> {
    const { rows } = await sql<{ gate: string; precondition: boolean }>`SELECT * FROM trustwork.hubs_gate_preconditions(${hubId}::uuid)`.execute(trx);
    return new Map(rows.map((r) => [r.gate, r.precondition]));
  },
};

export const legalDocuments = {
  draft(trx: Transaction, ctx: CommandContext, hubId: string, input: { kind: string; locale: string; body: string }): Promise<LegalDocumentVersionRow> {
    return one(sql<LegalDocumentVersionRow>`SELECT * FROM trustwork.hubs_draft_legal_document(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${input.kind}::text, ${input.locale}::text, ${input.body}::text)`.execute(trx), 'hubs_draft_legal_document');
  },
  recordCounselApproval(trx: Transaction, ctx: CommandContext, hubId: string, input: { documentVersionIds: string[]; counselName: string; firm: string; approvedOn: string; scopeNote: string }): Promise<CounselApprovalRow> {
    return one(sql<CounselApprovalRow>`SELECT * FROM trustwork.hubs_record_counsel_approval(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${input.documentVersionIds}::uuid[], ${input.counselName}::text,
      ${input.firm}::text, ${input.approvedOn}::date, ${input.scopeNote}::text)`.execute(trx), 'hubs_record_counsel_approval');
  },
  activate(trx: Transaction, ctx: CommandContext, documentId: string, expectedRevision: number | null, approvalId: string | null): Promise<LegalDocumentVersionRow> {
    return one(sql<LegalDocumentVersionRow>`SELECT * FROM trustwork.hubs_activate_legal_document(${ctxJson(ctx)}::jsonb, ${documentId}::uuid, ${expectedRevision}::integer, ${approvalId}::uuid)`.execute(trx), 'hubs_activate_legal_document');
  },
  accept(trx: Transaction, documentId: string, context: LegalAcceptanceRow['context']): Promise<LegalAcceptanceRow> {
    return one(sql<LegalAcceptanceRow>`SELECT * FROM trustwork.hubs_accept_legal_document(${documentId}::uuid, ${context}::text)`.execute(trx), 'hubs_accept_legal_document');
  },
  get(trx: Transaction, documentId: string): Promise<LegalDocumentVersionRow | undefined> {
    return trx.selectFrom('legal_document_version').selectAll().where('id', '=', documentId).executeTakeFirst();
  },
  list(trx: Transaction, hubId: string): Promise<LegalDocumentVersionRow[]> {
    return trx.selectFrom('legal_document_version').selectAll().where('hub_id', '=', hubId).orderBy('kind').orderBy('locale').orderBy('version', 'desc').execute();
  },
  counselApprovals(trx: Transaction, hubId: string): Promise<CounselApprovalRow[]> {
    return trx.selectFrom('counsel_approval').selectAll().where('hub_id', '=', hubId).orderBy('recorded_at', 'desc').execute();
  },
  acceptances(trx: Transaction): Promise<LegalAcceptanceRow[]> {
    return trx.selectFrom('legal_acceptance').selectAll().orderBy('accepted_at', 'desc').execute();
  },
};

export const providerCredentials = {
  register(trx: Transaction, ctx: CommandContext, hubId: string, input: { provider: string; adapter: string; mode: ProviderCredentialRefRow['mode']; secretStore: ProviderCredentialRefRow['secret_store']; secretRef: string }): Promise<ProviderCredentialRefRow> {
    return one(sql<ProviderCredentialRefRow>`SELECT * FROM trustwork.hubs_register_credential(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${input.provider}::text, ${input.adapter}::text, ${input.mode}::text,
      ${input.secretStore}::text, ${input.secretRef}::text)`.execute(trx), 'hubs_register_credential');
  },
  activate(trx: Transaction, ctx: CommandContext, credentialId: string, approvalId: string | null): Promise<ProviderCredentialRefRow> {
    return one(sql<ProviderCredentialRefRow>`SELECT * FROM trustwork.hubs_activate_credential(${ctxJson(ctx)}::jsonb, ${credentialId}::uuid, ${approvalId}::uuid)`.execute(trx), 'hubs_activate_credential');
  },
  retire(trx: Transaction, ctx: CommandContext, credentialId: string): Promise<ProviderCredentialRefRow> {
    return one(sql<ProviderCredentialRefRow>`SELECT * FROM trustwork.hubs_retire_credential(${ctxJson(ctx)}::jsonb, ${credentialId}::uuid)`.execute(trx), 'hubs_retire_credential');
  },
  get(trx: Transaction, credentialId: string): Promise<ProviderCredentialRefRow | undefined> {
    return trx.selectFrom('provider_credential_ref').selectAll().where('id', '=', credentialId).executeTakeFirst();
  },
  list(trx: Transaction, hubId: string): Promise<ProviderCredentialRefRow[]> {
    return trx.selectFrom('provider_credential_ref').selectAll().where('hub_id', '=', hubId).orderBy('provider').orderBy('registered_at', 'desc').execute();
  },
};
