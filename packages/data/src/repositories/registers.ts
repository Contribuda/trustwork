import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { RegisterAdapterRow, RegisterFactLinkRow, RegisterFactRow, RegisterReminderRow } from '../schema/registers.js';
import type { CommandContext } from './admin.js';
import '../schema/registers.js';

/**
 * Public-register and licence-board facts (REG-001, migration packages/data/migrations/registers; contract
 * packages/contracts/src/sourced-facts.ts).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext`: each calls one `registers_*` SECURITY DEFINER
 *   command that checks the permission at the hub (`admin.sources.manage` for adapters and fake runs,
 *   `admin.sources.dedupe.decide` for reviewed links) and writes the admin audit row in the same transaction. Live mode
 *   consumes a second person's approval (`providers.enable_non_fake`).
 * - **Reads**: staff of the hub under row-level security; the public projection (`registers_public_facts`) for anyone;
 *   a company's administrators read its expiry reminders.
 * - **Worker** (`registersWorker`): adapters due for a refresh, adapter runs without a person, and the expiry watch.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

/** A `date` column read by node-postgres is local midnight; this gives back the calendar date it stood for. */
export function calendarDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export interface PublicRegisterFactRow {
  kind: string;
  identifier_kind: string | null;
  value: Record<string, unknown>;
  source_id: string;
  link: string;
  observed_at: Date;
  valid_until: Date | null;
  stale: boolean;
}
export interface OwnRegisterReminderRow {
  id: string;
  kind: string;
  record_ref: string;
  valid_until: Date;
  days_before: number;
  link: string;
  created_at: Date;
}

export const registers = {
  bindAdapter(trx: Transaction, ctx: CommandContext, hubId: string, adapter: string, sourceId: string, refreshDays: number): Promise<RegisterAdapterRow> {
    return one(sql<RegisterAdapterRow>`SELECT * FROM trustwork.registers_bind_adapter(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${adapter}::text, ${sourceId}::uuid, ${refreshDays}::int)`,
      trx, 'registers_bind_adapter');
  },
  goLive(trx: Transaction, ctx: CommandContext, adapterId: string, expectedRevision: number, credentialRefId: string | null, approvalId: string | null): Promise<RegisterAdapterRow> {
    return one(sql<RegisterAdapterRow>`SELECT * FROM trustwork.registers_go_live(${ctxJson(ctx)}::jsonb, ${adapterId}::uuid, ${expectedRevision}::int, ${credentialRefId}::uuid,
      ${approvalId}::uuid)`, trx, 'registers_go_live');
  },
  retireAdapter(trx: Transaction, ctx: CommandContext, adapterId: string, expectedRevision: number): Promise<RegisterAdapterRow> {
    return one(sql<RegisterAdapterRow>`SELECT * FROM trustwork.registers_retire_adapter(${ctxJson(ctx)}::jsonb, ${adapterId}::uuid, ${expectedRevision}::int)`, trx,
      'registers_retire_adapter');
  },
  /** The digest a second person approves (`providers.enable_non_fake`) before an adapter goes live. */
  async liveDigest(trx: Transaction, adapterId: string, revision: number, credentialRefId: string): Promise<string> {
    const row = await one(sql<{ v: string }>`SELECT trustwork.registers_adapter_digest(${adapterId}::uuid, ${revision}::int, ${credentialRefId}::uuid) AS v`, trx, 'registers_adapter_digest');
    return row.v;
  },
  /** Records the observations of a staff run of a fake adapter (SourcedObservation objects). */
  async recordFakeRun(trx: Transaction, ctx: CommandContext, adapterId: string, observations: readonly unknown[]): Promise<RegisterFactRow[]> {
    const { rows } = await sql<RegisterFactRow>`SELECT * FROM trustwork.registers_record_fake_run(${ctxJson(ctx)}::jsonb, ${adapterId}::uuid, ${JSON.stringify(observations)}::jsonb)`
      .execute(trx);
    return rows;
  },
  linkRecord(trx: Transaction, ctx: CommandContext, adapterId: string, recordRef: string, companyId: string, reason: string): Promise<RegisterFactLinkRow> {
    return one(sql<RegisterFactLinkRow>`SELECT * FROM trustwork.registers_link_record(${ctxJson(ctx)}::jsonb, ${adapterId}::uuid, ${recordRef}::text, ${companyId}::uuid, ${reason}::text)`,
      trx, 'registers_link_record');
  },
  endLink(trx: Transaction, ctx: CommandContext, linkId: string): Promise<RegisterFactLinkRow> {
    return one(sql<RegisterFactLinkRow>`SELECT * FROM trustwork.registers_end_link(${ctxJson(ctx)}::jsonb, ${linkId}::uuid)`, trx, 'registers_end_link');
  },

  adapters(trx: Transaction, hubId: string): Promise<RegisterAdapterRow[]> {
    return trx.selectFrom('register_adapter').selectAll().where('hub_id', '=', hubId).orderBy('created_at').orderBy('id').execute();
  },
  adapter(trx: Transaction, adapterId: string): Promise<RegisterAdapterRow | undefined> {
    return trx.selectFrom('register_adapter').selectAll().where('id', '=', adapterId).executeTakeFirst();
  },
  /** Current facts an adapter recorded (staff). */
  currentFacts(trx: Transaction, adapterId: string): Promise<RegisterFactRow[]> {
    return trx.selectFrom('register_fact').selectAll().where('adapter_id', '=', adapterId).where('superseded_at', 'is', null).orderBy('kind').orderBy('record_ref').execute();
  },
  links(trx: Transaction, hubId: string): Promise<RegisterFactLinkRow[]> {
    return trx.selectFrom('register_fact_link').selectAll().where('hub_id', '=', hubId).orderBy('linked_at').orderBy('id').execute();
  },
  /** Staff: every current fact of the hub about a company, by identifier or reviewed link, before display rules. */
  async companyFacts(trx: Transaction, hubId: string, companyId: string): Promise<RegisterFactRow[]> {
    const { rows } = await sql<RegisterFactRow>`SELECT * FROM trustwork.registers_company_facts(${hubId}::uuid, ${companyId}::uuid)`.execute(trx);
    return rows;
  },
  /** Staff: current facts for an identifier kind and value (ENT-001 cites them field by field), before display rules. */
  async identifierFacts(trx: Transaction, hubId: string, identifierKind: string, identifierValue: string): Promise<RegisterFactRow[]> {
    const { rows } = await sql<RegisterFactRow>`SELECT * FROM trustwork.registers_identifier_facts(${hubId}::uuid, ${identifierKind}::text, ${identifierValue}::text)`.execute(trx);
    return rows;
  },
  /** Anyone: what a public page may show about the company (PublicSourcedFactSchema). */
  async publicFacts(trx: Transaction, hubId: string, companyId: string): Promise<PublicRegisterFactRow[]> {
    const { rows } = await sql<PublicRegisterFactRow>`SELECT * FROM trustwork.registers_public_facts(${hubId}::uuid, ${companyId}::uuid)`.execute(trx);
    return rows;
  },
  /** An active administrator of the company: its expiry reminders. */
  async ownReminders(trx: Transaction, companyId: string): Promise<OwnRegisterReminderRow[]> {
    const { rows } = await sql<OwnRegisterReminderRow>`SELECT * FROM trustwork.registers_own_reminders(${companyId}::uuid)`.execute(trx);
    return rows;
  },
};

export const registersWorker = {
  async dueAdapters(trx: Transaction, now: Date, limit: number): Promise<RegisterAdapterRow[]> {
    const { rows } = await sql<RegisterAdapterRow>`SELECT * FROM trustwork.registers_due_adapters(${now}::timestamptz, ${limit}::int)`.execute(trx);
    return rows;
  },
  async recordAdapterRun(trx: Transaction, adapterId: string, observations: readonly unknown[], now: Date): Promise<number> {
    const row = await one(sql<{ v: number }>`SELECT trustwork.registers_record_adapter_run(${adapterId}::uuid, ${JSON.stringify(observations)}::jsonb, ${now}::timestamptz) AS v`, trx,
      'registers_record_adapter_run');
    return row.v;
  },
  /** What a due adapter re-observes: the identifiers (or record references) of its current facts. */
  async adapterSubjects(trx: Transaction, adapterId: string, limit: number): Promise<Array<{ identifier_value: string | null; record_ref: string | null }>> {
    const { rows } = await sql<{ identifier_value: string | null; record_ref: string | null }>`SELECT * FROM trustwork.registers_adapter_subjects(${adapterId}::uuid, ${limit}::int)`.execute(trx);
    return rows;
  },
  /** A due live adapter visited without observations (no adapter code yet): reported once per cadence. */
  async markVisited(trx: Transaction, adapterId: string, now: Date): Promise<void> {
    await sql`SELECT trustwork.registers_mark_visited(${adapterId}::uuid, ${now}::timestamptz)`.execute(trx);
  },
  async runExpiryWatch(trx: Transaction, now: Date): Promise<RegisterReminderRow[]> {
    const { rows } = await sql<RegisterReminderRow>`SELECT * FROM trustwork.registers_run_expiry_watch(${now}::timestamptz)`.execute(trx);
    return rows;
  },
};
