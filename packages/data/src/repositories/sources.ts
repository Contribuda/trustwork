import { sql, type RawBuilder } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type {
  AllowedUsesJson, CrawlPolicyRow, ImportBatchRow, RecordLinkProposalRow, SourceItemRow, SourceRow, SourceTakedownRow, SourceTombstoneRow, SponsoredContentPolicyRow,
} from '../schema/sources.js';
import type { CommandContext } from './admin.js';
import '../schema/sources.js';

/**
 * Hub source registry (SRC-001, migration packages/data/migrations/sources).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext` (a live elevation of the caller, a request id and a
 *   reason): each calls one `sources_*` SECURITY DEFINER command that checks the permission at the hub, separation of
 *   duties and the licence rules, and writes the admin audit row in the same transaction. Refusals are SQLSTATE
 *   42501 / 23514 / P0002 / 40001 with a `sources.*` or `admin.*` hint.
 * - **Reads** under row-level security: staff holding a registry permission at the hub read everything; nobody else
 *   reads a row. The public reads only `sources_public_provenance` and `sources_sponsored_slot`.
 * - **Worker entry points** (trustwork_worker): the recommendation input without sponsored items and the peer export
 *   limited to items whose licence allows syndication.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
const json = (v: unknown): string => JSON.stringify(v);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

/** The editorial terms of a source as the commands take them (camelCase, the contract's shape). */
export interface SourceTermsInput {
  readerKind: string;
  purposes: string[];
  licence: { kind: string; name: string | null; url: string | null; agreementRef: string | null };
  allowedUses: AllowedUsesJson;
  attributionTemplate: string;
  takedownContact: string;
  personalData: boolean;
  legalBasis: string | null;
}
export interface RegisterSourceInput extends SourceTermsInput { kind: string; name: string; url: string | null; ownerPersonId: string }
export interface RobotsInput {
  domain: string;
  robotsUrl: string;
  userAgent: string;
  robotsDigest: string;
  allowed: boolean;
  status: 'allowed' | 'restricted' | 'forbidden';
  crawlDelaySeconds: number | null;
  allowedPaths: string[];
  disallowedPaths: string[];
  licenceUrls: string[];
}
export interface StagedItemInput { externalId: string; url: string; title: string; summary: string | null; fullText: string | null; sourceTime: string | null; sponsored: { sponsorName: string } | null }
export interface StagedFieldInput { recordKind: string; recordId: string; field: string; value: string; itemExternalId: string | null }
export interface StagedLinkInput { left: { kind: string; id: string }; rightLocalId: string | null; rightGlobalId: string | null; evidence: string }

export const sources = {
  register(trx: Transaction, ctx: CommandContext, hubId: string, input: RegisterSourceInput): Promise<SourceRow> {
    return one(sql<SourceRow>`SELECT * FROM trustwork.sources_register(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${json(input)}::jsonb)`, trx, 'sources_register');
  },
  setTerms(trx: Transaction, ctx: CommandContext, sourceId: string, expectedRevision: number, input: SourceTermsInput): Promise<SourceRow> {
    return one(sql<SourceRow>`SELECT * FROM trustwork.sources_set_terms(${ctxJson(ctx)}::jsonb, ${sourceId}::uuid, ${expectedRevision}::int, ${json(input)}::jsonb)`, trx, 'sources_set_terms');
  },
  recordTerms(trx: Transaction, ctx: CommandContext, sourceId: string, expectedRevision: number, input: { termsUrl: string | null; termsDigest: string | null; automatedAccess: string; notes: string }): Promise<SourceRow> {
    return one(sql<SourceRow>`SELECT * FROM trustwork.sources_record_terms(${ctxJson(ctx)}::jsonb, ${sourceId}::uuid, ${expectedRevision}::int, ${input.termsUrl}::text,
      ${input.termsDigest}::text, ${input.automatedAccess}::text, ${input.notes}::text)`, trx, 'sources_record_terms');
  },
  recordRobots(trx: Transaction, ctx: CommandContext, sourceId: string, input: RobotsInput): Promise<CrawlPolicyRow> {
    return one(sql<CrawlPolicyRow>`SELECT * FROM trustwork.sources_record_robots(${ctxJson(ctx)}::jsonb, ${sourceId}::uuid, ${json(input)}::jsonb)`, trx, 'sources_record_robots');
  },
  recordRsl(trx: Transaction, ctx: CommandContext, sourceId: string, expectedRevision: number, input: { status: string; digest: string | null; ceiling: AllowedUsesJson | null; suggested: AllowedUsesJson | null }): Promise<SourceRow> {
    return one(sql<SourceRow>`SELECT * FROM trustwork.sources_record_rsl(${ctxJson(ctx)}::jsonb, ${sourceId}::uuid, ${expectedRevision}::int, ${input.status}::text, ${input.digest}::text,
      ${input.ceiling === null ? null : json(input.ceiling)}::jsonb, ${input.suggested === null ? null : json(input.suggested)}::jsonb)`, trx, 'sources_record_rsl');
  },
  setStatus(trx: Transaction, ctx: CommandContext, sourceId: string, expectedRevision: number, to: 'active' | 'paused' | 'rejected' | 'retired'): Promise<SourceRow> {
    return one(sql<SourceRow>`SELECT * FROM trustwork.sources_set_status(${ctxJson(ctx)}::jsonb, ${sourceId}::uuid, ${expectedRevision}::int, ${to}::text)`, trx, 'sources_set_status');
  },
  /** Takedown of a whole source (itemId null) or of one item (sourceId is then ignored). */
  takedown(trx: Transaction, ctx: CommandContext, target: { sourceId: string | null; itemId: string | null }, reasonCategory: string, note: string): Promise<SourceTakedownRow> {
    return one(sql<SourceTakedownRow>`SELECT * FROM trustwork.sources_takedown(${ctxJson(ctx)}::jsonb, ${target.sourceId}::uuid, ${target.itemId}::uuid, ${reasonCategory}::text, ${note}::text)`,
      trx, 'sources_takedown');
  },
  get(trx: Transaction, sourceId: string): Promise<SourceRow | undefined> {
    return trx.selectFrom('source').selectAll().where('id', '=', sourceId).executeTakeFirst();
  },
  list(trx: Transaction, hubId: string, status?: string): Promise<SourceRow[]> {
    let q = trx.selectFrom('source').selectAll().where('hub_id', '=', hubId);
    if (status) q = q.where('status', '=', status as SourceRow['status']);
    return q.orderBy('created_at', 'desc').orderBy('id').execute();
  },
  /** The latest robots.txt check of each source (its current crawl policy). */
  async currentPolicies(trx: Transaction, sourceIds: string[]): Promise<Map<string, CrawlPolicyRow>> {
    if (sourceIds.length === 0) return new Map();
    const rows = await trx.selectFrom('crawl_policy').selectAll().where('source_id', 'in', sourceIds).orderBy('fetched_at', 'desc').orderBy('id', 'desc').execute();
    const out = new Map<string, CrawlPolicyRow>();
    for (const row of rows) if (!out.has(row.source_id)) out.set(row.source_id, row);
    return out;
  },
  policyHistory(trx: Transaction, sourceId: string): Promise<CrawlPolicyRow[]> {
    return trx.selectFrom('crawl_policy').selectAll().where('source_id', '=', sourceId).orderBy('fetched_at', 'desc').orderBy('id', 'desc').execute();
  },
};

export const importBatches = {
  stage(trx: Transaction, ctx: CommandContext, sourceId: string, input: { items: StagedItemInput[]; fields: StagedFieldInput[]; links: StagedLinkInput[] }): Promise<ImportBatchRow> {
    return one(sql<ImportBatchRow>`SELECT * FROM trustwork.sources_stage_batch(${ctxJson(ctx)}::jsonb, ${sourceId}::uuid, ${json(input.items)}::jsonb, ${json(input.fields)}::jsonb,
      ${json(input.links)}::jsonb)`, trx, 'sources_stage_batch');
  },
  decide(trx: Transaction, ctx: CommandContext, batchId: string, expectedRevision: number, decision: 'activate' | 'reject'): Promise<ImportBatchRow> {
    return one(sql<ImportBatchRow>`SELECT * FROM trustwork.sources_decide_batch(${ctxJson(ctx)}::jsonb, ${batchId}::uuid, ${expectedRevision}::int, ${decision}::text)`, trx, 'sources_decide_batch');
  },
  get(trx: Transaction, batchId: string): Promise<ImportBatchRow | undefined> {
    return trx.selectFrom('import_batch').selectAll().where('id', '=', batchId).executeTakeFirst();
  },
  list(trx: Transaction, hubId: string, status?: string): Promise<ImportBatchRow[]> {
    let q = trx.selectFrom('import_batch').selectAll().where('hub_id', '=', hubId);
    if (status) q = q.where('status', '=', status as ImportBatchRow['status']);
    return q.orderBy('created_at', 'desc').orderBy('id').execute();
  },
};

export const sourceItems = {
  /** Records the person's decision; a draft names the CNT-001 editorial draft they created from the item in this transaction. */
  decide(trx: Transaction, ctx: CommandContext, itemId: string, expectedRevision: number, decision: 'draft' | 'discard', publicationId: string | null): Promise<SourceItemRow> {
    return one(sql<SourceItemRow>`SELECT * FROM trustwork.sources_decide_item(${ctxJson(ctx)}::jsonb, ${itemId}::uuid, ${expectedRevision}::int, ${decision}::text, ${publicationId}::uuid)`,
      trx, 'sources_decide_item');
  },
  /** The licence-checked payload for a model provider or a peer; refuses (`sources.licence_forbids_*`) when the item's effective uses do not allow it. */
  async egress(trx: Transaction, itemId: string, channel: 'model_provider' | 'peer'): Promise<{ itemId: string; url: string; title: string; summary: string | null; fullText: string | null; attribution: string; sourceName: string }> {
    const { rows } = await sql<{ v: { itemId: string; url: string; title: string; summary: string | null; fullText: string | null; attribution: string; sourceName: string } }>`
      SELECT trustwork.sources_item_egress(${itemId}::uuid, ${channel}::text) AS v`.execute(trx);
    return rows[0]?.v as never;
  },
  recordAssist(trx: Transaction, ctx: CommandContext, itemId: string, expectedRevision: number, summary: string, language: string): Promise<SourceItemRow> {
    return one(sql<SourceItemRow>`SELECT * FROM trustwork.sources_record_assist(${ctxJson(ctx)}::jsonb, ${itemId}::uuid, ${expectedRevision}::int, ${summary}::text, ${language}::text)`,
      trx, 'sources_record_assist');
  },
  async effectiveUses(trx: Transaction, itemId: string): Promise<AllowedUsesJson> {
    const { rows } = await sql<{ v: AllowedUsesJson }>`SELECT trustwork.sources_item_effective_uses(${itemId}::uuid) AS v`.execute(trx);
    return rows[0]?.v as AllowedUsesJson;
  },
  get(trx: Transaction, itemId: string): Promise<SourceItemRow | undefined> {
    return trx.selectFrom('source_item').selectAll().where('id', '=', itemId).executeTakeFirst();
  },
  /** The review queue: items of activated batches still waiting for a person, oldest first (time order only). */
  queue(trx: Transaction, hubId: string, limit = 100): Promise<SourceItemRow[]> {
    return trx.selectFrom('source_item as i').innerJoin('import_batch as b', 'b.id', 'i.import_batch_id').selectAll('i')
      .where('i.hub_id', '=', hubId).where('i.status', '=', 'queued').where('b.status', '=', 'activated')
      .orderBy('i.observed_at').orderBy('i.id').limit(limit).execute();
  },
  list(trx: Transaction, hubId: string, filter: { status?: string; batchId?: string } = {}): Promise<SourceItemRow[]> {
    let q = trx.selectFrom('source_item').selectAll().where('hub_id', '=', hubId);
    if (filter.status) q = q.where('status', '=', filter.status as SourceItemRow['status']);
    if (filter.batchId) q = q.where('import_batch_id', '=', filter.batchId);
    return q.orderBy('observed_at').orderBy('id').limit(500).execute();
  },
};

export const recordLinks = {
  propose(trx: Transaction, ctx: CommandContext, hubId: string, input: StagedLinkInput): Promise<RecordLinkProposalRow> {
    return one(sql<RecordLinkProposalRow>`SELECT * FROM trustwork.sources_propose_link(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${input.left.kind}::text, ${input.left.id}::uuid,
      ${input.rightLocalId}::uuid, ${input.rightGlobalId}::text, ${input.evidence}::text)`, trx, 'sources_propose_link');
  },
  decide(trx: Transaction, ctx: CommandContext, linkId: string, expectedRevision: number, decision: 'accept' | 'reject'): Promise<RecordLinkProposalRow> {
    return one(sql<RecordLinkProposalRow>`SELECT * FROM trustwork.sources_decide_link(${ctxJson(ctx)}::jsonb, ${linkId}::uuid, ${expectedRevision}::int, ${decision}::text)`, trx, 'sources_decide_link');
  },
  get(trx: Transaction, linkId: string): Promise<RecordLinkProposalRow | undefined> {
    return trx.selectFrom('record_link_proposal').selectAll().where('id', '=', linkId).executeTakeFirst();
  },
  list(trx: Transaction, hubId: string, state?: string): Promise<RecordLinkProposalRow[]> {
    let q = trx.selectFrom('record_link_proposal').selectAll().where('hub_id', '=', hubId);
    if (state) q = q.where('state', '=', state as RecordLinkProposalRow['state']);
    return q.orderBy('created_at').orderBy('id').limit(500).execute();
  },
};

export const takedowns = {
  get(trx: Transaction, takedownId: string): Promise<SourceTakedownRow | undefined> {
    return trx.selectFrom('source_takedown').selectAll().where('id', '=', takedownId).executeTakeFirst();
  },
  tombstones(trx: Transaction, takedownId: string): Promise<SourceTombstoneRow[]> {
    return trx.selectFrom('source_tombstone').selectAll().where('takedown_id', '=', takedownId).orderBy('channel').orderBy('target_kind').orderBy('target_id').execute();
  },
};

export const sponsoredPolicy = {
  /** A new policy version; `allowed: true` consumes a `sponsored.enable` approval of exactly this version. */
  set(trx: Transaction, ctx: CommandContext, hubId: string, input: { allowed: boolean; maxSlotsPerPage: number; requireVerifiedSponsor: boolean; approvalId: string | null }): Promise<SponsoredContentPolicyRow> {
    return one(sql<SponsoredContentPolicyRow>`SELECT * FROM trustwork.sources_set_sponsored_policy(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${input.allowed}::boolean,
      ${input.maxSlotsPerPage}::int, ${input.requireVerifiedSponsor}::boolean, ${input.approvalId}::uuid)`, trx, 'sources_set_sponsored_policy');
  },
  current(trx: Transaction, hubId: string): Promise<SponsoredContentPolicyRow | undefined> {
    return trx.selectFrom('sponsored_content_policy').selectAll().where('hub_id', '=', hubId).orderBy('version', 'desc').limit(1).executeTakeFirst();
  },
};

export const publicSources = {
  async provenance(trx: Transaction, hubId: string, recordKind: string, recordId: string): Promise<unknown> {
    const { rows } = await sql<{ v: unknown }>`SELECT trustwork.sources_public_provenance(${hubId}::uuid, ${recordKind}::text, ${recordId}::uuid) AS v`.execute(trx);
    return rows[0]?.v;
  },
  async sponsoredSlot(trx: Transaction, hubId: string): Promise<unknown> {
    const { rows } = await sql<{ v: unknown }>`SELECT trustwork.sources_sponsored_slot(${hubId}::uuid) AS v`.execute(trx);
    return rows[0]?.v;
  },
};

export const sourcesWorker = {
  /** Items a person drafted from active sources, never sponsored: the only registry input ranking, matching and recommendations may use. */
  async recommendable(trx: Transaction, hubId: string, limit = 50): Promise<{ item_id: string; source_id: string; title: string; url: string; observed_at: Date }[]> {
    const { rows } = await sql<{ item_id: string; source_id: string; title: string; url: string; observed_at: Date }>`
      SELECT * FROM trustwork.sources_recommendable_items(${hubId}::uuid, ${limit}::int)`.execute(trx);
    return rows;
  },
  async peerExport(trx: Transaction, hubId: string, limit = 50): Promise<Record<string, unknown>[]> {
    const { rows } = await sql<{ v: Record<string, unknown> }>`SELECT v FROM trustwork.sources_peer_export(${hubId}::uuid, ${limit}::int) AS v`.execute(trx);
    return rows.map((r) => r.v);
  },
  /** Identifier-only digest of the sponsored policy a second person approves (computed by the database). */
  async sponsoredDigest(pool: DataPool, input: { hubId: string; version: number; allowed: boolean; maxSlotsPerPage: number; requireVerifiedSponsor: boolean }): Promise<string> {
    const { rows } = await pool.query<{ v: string }>('SELECT trustwork.sources_sponsored_digest($1, $2, $3, $4, $5) AS v', [input.hubId, input.version, input.allowed, input.maxSlotsPerPage, input.requireVerifiedSponsor]);
    return rows[0]?.v as string;
  },
};
