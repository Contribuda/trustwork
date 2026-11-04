import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { CommandContext, StaffScope, StaffTarget } from './admin.js';
import type { FeatureFlagRow } from '../schema/admin.js';
import type { ConsoleNotificationSettingRow, ConsoleSavedViewRow, FeatureFlagRolloutRow, FlagStage } from '../schema/console-services.js';
import '../schema/console-services.js';

/**
 * Console navigation services (ADM-005, migration packages/data/migrations/console-services; contract
 * packages/contracts/src/console-services.ts). Reads run as the staff member: `console_search` and `console_work_items`
 * are invoker functions under row-level security that also state each object's owning read permission. Commands are
 * SECURITY DEFINER functions that check the elevation and write the audit row.
 */
const nodeOf = (t: StaffTarget): string | null => (t.kind === 'node' ? t.nodeId : null);
const hubOf = (t: StaffTarget): string | null => (t.kind === 'hub' ? t.hubId : null);
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export type ConsoleFlagRow = FeatureFlagRow & { stage: FlagStage; share_percent: number | null; rollout_revision: number };

export const consoleReads = {
  /** Exactly one of `id`, `number`, `key` is set. An empty answer means missing and unreadable alike. */
  async search(trx: Transaction, ref: { id?: string; number?: string; key?: string }, target: StaffTarget): Promise<unknown[]> {
    const { rows } = await sql<{ hit: unknown }>`SELECT hit FROM trustwork.console_search(${ref.id ?? null}::uuid, ${ref.number ?? null}::bigint, ${ref.key ?? null}, ${nodeOf(target)}::uuid, ${hubOf(target)}::uuid)`.execute(trx);
    return rows.map((r) => r.hit);
  },
  async workItems(trx: Transaction, view: string, target: StaffTarget): Promise<unknown[]> {
    const { rows } = await sql<{ item: unknown }>`SELECT item FROM trustwork.console_work_items(${view}, ${nodeOf(target)}::uuid, ${hubOf(target)}::uuid)`.execute(trx);
    return rows.map((r) => r.item);
  },
  async isStaff(trx: Transaction, target: StaffTarget): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.console_is_staff(${nodeOf(target)}::uuid, ${hubOf(target)}::uuid) AS ok`.execute(trx);
    return rows[0]?.ok === true;
  },
};

export const consoleFlags = {
  /** Flags at exactly this target, expired ones included (they are listed for removal from code). */
  async list(trx: Transaction, target: StaffTarget): Promise<ConsoleFlagRow[]> {
    const { rows } = await sql<ConsoleFlagRow>`
      SELECT f.*, o.stage, o.share_percent, o.revision AS rollout_revision FROM trustwork.feature_flag f JOIN trustwork.feature_flag_rollout o ON o.flag_id = f.id
       WHERE f.node_id IS NOT DISTINCT FROM ${nodeOf(target)}::uuid AND f.hub_id IS NOT DISTINCT FROM ${hubOf(target)}::uuid ORDER BY f.key`.execute(trx);
    return rows;
  },
  /** What can be in force at a hub: its own unexpired flags and the node's, a hub's flag first for a shared key. */
  async inForceAt(trx: Transaction, hubId: string): Promise<ConsoleFlagRow[]> {
    const { rows } = await sql<ConsoleFlagRow>`
      SELECT DISTINCT ON (f.key) f.*, o.stage, o.share_percent, o.revision AS rollout_revision FROM trustwork.feature_flag f JOIN trustwork.feature_flag_rollout o ON o.flag_id = f.id
       WHERE (f.hub_id = ${hubId}::uuid OR f.node_id IS NOT NULL) AND f.expires_at > now() ORDER BY f.key, (f.hub_id IS NULL)`.execute(trx);
    return rows;
  },
  async setStage(trx: Transaction, ctx: CommandContext, input: { flagId: string; stage: FlagStage; sharePercent: number | null; expectedRevision: number }): Promise<FeatureFlagRolloutRow> {
    return one(sql<FeatureFlagRolloutRow>`SELECT * FROM trustwork.console_flag_set_stage(${ctxJson(ctx)}::jsonb, ${input.flagId}::uuid, ${input.stage}, ${input.sharePercent}::integer, ${input.expectedRevision}::integer)`, trx, 'console_flag_set_stage');
  },
  async one(trx: Transaction, flagId: string): Promise<ConsoleFlagRow | undefined> {
    const { rows } = await sql<ConsoleFlagRow>`
      SELECT f.*, o.stage, o.share_percent, o.revision AS rollout_revision FROM trustwork.feature_flag f JOIN trustwork.feature_flag_rollout o ON o.flag_id = f.id WHERE f.id = ${flagId}::uuid`.execute(trx);
    return rows[0];
  },
};

export const consoleViews = {
  /** Views the caller may read at the target (row-level security decides owner and team). */
  async list(trx: Transaction, target: StaffTarget, surface?: string): Promise<ConsoleSavedViewRow[]> {
    const node = nodeOf(target);
    const hub = hubOf(target);
    let query = trx.selectFrom('console_saved_view').selectAll().where('node_id', node === null ? 'is' : '=', node).where('hub_id', hub === null ? 'is' : '=', hub);
    if (surface) query = query.where('surface', '=', surface);
    return query.orderBy('surface').orderBy('name').orderBy('id').execute();
  },
  async create(trx: Transaction, ctx: CommandContext, input: { scope: StaffScope; surface: string; name: string; configuration: unknown; teamRole: string | null; isDefault: boolean }): Promise<ConsoleSavedViewRow> {
    return one(sql<ConsoleSavedViewRow>`SELECT * FROM trustwork.console_view_create(${ctxJson(ctx)}::jsonb, ${nodeOf(input.scope)}::uuid, ${hubOf(input.scope)}::uuid, ${input.surface}, ${input.name},
      ${JSON.stringify(input.configuration)}::jsonb, ${input.teamRole}, ${input.isDefault})`, trx, 'console_view_create');
  },
  async update(trx: Transaction, ctx: CommandContext, viewId: string, input: { expectedRevision: number; name: string; configuration: unknown; teamRole: string | null; isDefault: boolean }): Promise<ConsoleSavedViewRow> {
    return one(sql<ConsoleSavedViewRow>`SELECT * FROM trustwork.console_view_update(${ctxJson(ctx)}::jsonb, ${viewId}::uuid, ${input.expectedRevision}::integer, ${input.name},
      ${JSON.stringify(input.configuration)}::jsonb, ${input.teamRole}, ${input.isDefault})`, trx, 'console_view_update');
  },
  async remove(trx: Transaction, ctx: CommandContext, viewId: string, expectedRevision: number): Promise<ConsoleSavedViewRow> {
    return one(sql<ConsoleSavedViewRow>`SELECT * FROM trustwork.console_view_remove(${ctxJson(ctx)}::jsonb, ${viewId}::uuid, ${expectedRevision}::integer)`, trx, 'console_view_remove');
  },
};

export const consoleNotifications = {
  async get(trx: Transaction): Promise<ConsoleNotificationSettingRow | undefined> {
    return trx.selectFrom('console_notification_setting').selectAll().executeTakeFirst();
  },
  async set(trx: Transaction, ctx: CommandContext, input: { scope: StaffScope; expectedRevision: number; emailCategories: string[]; quietHours: { fromMinute: number; untilMinute: number; timeZone: string } | null }): Promise<ConsoleNotificationSettingRow> {
    return one(sql<ConsoleNotificationSettingRow>`SELECT * FROM trustwork.console_notifications_set(${ctxJson(ctx)}::jsonb, ${nodeOf(input.scope)}::uuid, ${hubOf(input.scope)}::uuid, ${input.expectedRevision}::integer,
      ${input.emailCategories}::text[], ${input.quietHours?.fromMinute ?? null}::integer, ${input.quietHours?.untilMinute ?? null}::integer, ${input.quietHours?.timeZone ?? null})`, trx, 'console_notifications_set');
  },
};
