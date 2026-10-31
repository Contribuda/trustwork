import { z } from 'zod';
import type pg from 'pg';
import { putSealed, getSealed, type BackupTarget } from './target.js';
import type { BackupKey } from './crypto.js';

/**
 * Partition retention for the two append-only streams (OPS-003, architecture audit C4, REL-001 monthly partitions).
 *
 * A monthly partition of `audit_event` or `outbox_event` leaves the database only when ALL of these hold:
 *   - its whole range ended more than the hub's configured retention period ago (nothing inside the window is touched);
 *   - the period is at least the engine floor for that stream (a configuration below the floor is refused, not clamped);
 *   - no configured legal hold overlaps its range;
 *   - audit: no row refers to an evidence artifact under legal hold (FILE-001 `legal_hold`);
 *   - outbox: every row is published (an unpublished event is pending work, never retention material);
 *   - it is not the DEFAULT partition and not the current or a future month.
 * Removal is detach, archive, verify, drop, in one transaction: the rows are exported to the backup target sealed,
 * read back and counted before DROP; any failure rolls back and the partition stays attached. Row-level DELETE is never
 * used (audit stays append-only for every role). Each removal appends a `retention.partition_removed` audit row.
 * Default is a dry run (plan only).
 */

/** Engine floors in days (docs/data/retention-and-privacy.md: audit_standard 1 year; operational 30 days). */
export const RETENTION_FLOOR_DAYS = { audit_event: 365, outbox_event: 30 } as const;
export const RETENTION_DEFAULT_DAYS = { audit_event: 2555, outbox_event: 90 } as const;
export const RETENTION_TABLES = ['audit_event', 'outbox_event'] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

const IsoDate = z.iso.datetime({ offset: true });

export const LegalHoldSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  tables: z.array(z.enum(RETENTION_TABLES)).min(1),
  from: IsoDate,
  /** Open-ended when null: everything from `from` onward is held. */
  to: IsoDate.nullable(),
  /** Case or matter reference recorded with every decision (no personal data). */
  reference: z.string().min(1).max(200).regex(/^[\x20-\x7E]+$/),
}).refine((h) => h.to === null || Date.parse(h.to) > Date.parse(h.from), { message: 'a legal hold ends after it starts', path: ['to'] });

export const RetentionPolicySchema = z.strictObject({
  v: z.literal(1),
  hubId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  /** Version of the hub setting this policy was exported from (recorded in audit rows). */
  version: z.int().min(1),
  auditEvent: z.strictObject({ retainDays: z.int().min(RETENTION_FLOOR_DAYS.audit_event).max(36_500) }),
  outboxEvent: z.strictObject({ retainDays: z.int().min(RETENTION_FLOOR_DAYS.outbox_event).max(36_500) }),
  legalHolds: z.array(LegalHoldSchema).max(500),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;
export type LegalHold = z.infer<typeof LegalHoldSchema>;

/** Parses a hub policy; throws with the reasons (for example a period below the engine floor). */
export function parseRetentionPolicy(input: unknown): RetentionPolicy {
  const result = RetentionPolicySchema.safeParse(input);
  if (!result.success) throw new Error(`retention policy refused: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return result.data;
}

export interface PartitionInfo {
  table: RetentionTable;
  name: string;
  /** Null for the DEFAULT partition. */
  from: Date | null;
  to: Date | null;
}

export interface PartitionFacts {
  rows: number;
  /** Outbox: rows with published_at IS NULL. */
  unpublished: number;
  /** Audit: rows whose object is an evidence artifact under legal hold. */
  heldArtifactRefs: number;
}

export type RetentionDecision =
  | { action: 'keep'; partition: PartitionInfo; reason: 'default_partition' | 'current_or_future' | 'inside_window' | 'legal_hold' | 'held_artifact' | 'unpublished'; detail?: string }
  | { action: 'remove'; partition: PartitionInfo; cutoff: Date; rows: number };

export function retainDays(policy: RetentionPolicy, table: RetentionTable): number {
  return table === 'audit_event' ? policy.auditEvent.retainDays : policy.outboxEvent.retainDays;
}

/** Pure decision for one partition. */
export function decidePartition(partition: PartitionInfo, facts: PartitionFacts, policy: RetentionPolicy, now: Date): RetentionDecision {
  if (!partition.from || !partition.to) return { action: 'keep', partition, reason: 'default_partition' };
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (partition.to.getTime() > monthStart) return { action: 'keep', partition, reason: 'current_or_future' };
  const cutoff = new Date(now.getTime() - retainDays(policy, partition.table) * 86_400_000);
  // Every row of [from, to) is older than the window only when `to` is at or before the cutoff.
  if (partition.to.getTime() > cutoff.getTime()) return { action: 'keep', partition, reason: 'inside_window', detail: `cutoff ${cutoff.toISOString()}` };
  const hold = policy.legalHolds.find((h) => h.tables.includes(partition.table)
    && Date.parse(h.from) < (partition.to as Date).getTime() && (h.to === null || Date.parse(h.to) > (partition.from as Date).getTime()));
  if (hold) return { action: 'keep', partition, reason: 'legal_hold', detail: `${hold.id} (${hold.reference})` };
  if (partition.table === 'audit_event' && facts.heldArtifactRefs > 0) return { action: 'keep', partition, reason: 'held_artifact', detail: `${facts.heldArtifactRefs} rows refer to artifacts under legal hold` };
  if (partition.table === 'outbox_event' && facts.unpublished > 0) return { action: 'keep', partition, reason: 'unpublished', detail: `${facts.unpublished} unpublished events` };
  return { action: 'remove', partition, cutoff, rows: facts.rows };
}

const BOUND = /FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/;

/** Partitions of both streams with their bounds (DEFAULT has null bounds). */
export async function listPartitions(client: Pick<pg.ClientBase, 'query'>): Promise<PartitionInfo[]> {
  const { rows } = await client.query<{ parent: RetentionTable; name: string; bound: string }>(`
    SELECT p.relname AS parent, c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'trustwork' AND p.relname = ANY ($1) ORDER BY p.relname, c.relname`, [RETENTION_TABLES as unknown as string[]]);
  return rows.map((r) => {
    const m = BOUND.exec(r.bound);
    return { table: r.parent, name: r.name, from: m ? new Date(m[1] as string) : null, to: m ? new Date(m[2] as string) : null };
  });
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`unexpected identifier ${name}`);
  return `"${name}"`;
}

/** Facts read from one partition (or from the detached table of the same name). */
export async function partitionFacts(client: Pick<pg.ClientBase, 'query'>, partition: PartitionInfo): Promise<PartitionFacts> {
  const table = `trustwork.${ident(partition.name)}`;
  if (partition.table === 'outbox_event') {
    const { rows } = await client.query<{ rows: number; unpublished: number }>(`SELECT count(*)::int AS rows, count(*) FILTER (WHERE published_at IS NULL)::int AS unpublished FROM ${table}`);
    return { rows: rows[0]?.rows ?? 0, unpublished: rows[0]?.unpublished ?? 0, heldArtifactRefs: 0 };
  }
  const { rows } = await client.query<{ rows: number; held: number }>(`
    SELECT count(*)::int AS rows,
           count(*) FILTER (WHERE a.object_kind = 'evidence_artifact' AND EXISTS (
             SELECT 1 FROM trustwork.evidence_artifact e WHERE e.legal_hold AND e.id::text = a.object_id))::int AS held
    FROM ${table} a`);
  return { rows: rows[0]?.rows ?? 0, unpublished: 0, heldArtifactRefs: rows[0]?.held ?? 0 };
}

export interface RetentionPlan { policy: { hubId: string; version: number }; now: string; decisions: RetentionDecision[] }

/** Reads partitions and facts and decides; runs inside the caller's maintenance transaction. */
export async function planRetention(client: Pick<pg.ClientBase, 'query'>, policy: RetentionPolicy, now: Date): Promise<RetentionPlan> {
  const decisions: RetentionDecision[] = [];
  for (const partition of await listPartitions(client)) {
    const facts = partition.from ? await partitionFacts(client, partition) : { rows: 0, unpublished: 0, heldArtifactRefs: 0 };
    decisions.push(decidePartition(partition, facts, policy, now));
  }
  return { policy: { hubId: policy.hubId, version: policy.version }, now: now.toISOString(), decisions };
}

export interface RemovedPartition { table: RetentionTable; name: string; rows: number; archiveKey: string; archiveSha256: string }
export interface RetentionResult { plan: RetentionPlan; removed: RemovedPartition[]; kept: { name: string; reason: string }[] }

/** Advisory lock shared with partition creation (trustwork.ensure_monthly_partitions). */
const PARTITION_LOCK = "SELECT pg_advisory_xact_lock(hashtext('trustwork.monthly_partitions'))";

/**
 * Applies retention. `client` is a dedicated connection of a login that may SET ROLE trustwork_owner (the migrator in
 * the stack); every partition is handled in its own transaction under the partition advisory lock, and its facts are
 * re-read after DETACH (no row can be added to a detached table), so a concurrent hold, a late unpublished event or a
 * concurrent retention run can never lead to a drop. Without `apply` it only plans.
 */
export async function runRetention(input: { client: pg.ClientBase; policy: RetentionPolicy; now: Date; apply: boolean; target?: BackupTarget; key?: BackupKey; operator: string }): Promise<RetentionResult> {
  const { client, policy, now } = input;
  if (input.apply && (!input.target || !input.key)) throw new Error('applying retention needs a backup target and key for the archive');
  if (!/^[\x20-\x7E]{1,128}$/.test(input.operator)) throw new Error('operator must be 1-128 printable ASCII characters');
  const plan = await inOwnerTransaction(client, async () => planRetention(client, policy, now));
  const result: RetentionResult = { plan, removed: [], kept: plan.decisions.filter((d) => d.action === 'keep').map((d) => ({ name: d.partition.name, reason: d.reason })) };
  if (!input.apply) return result;
  for (const decision of plan.decisions) {
    if (decision.action !== 'remove') continue;
    const removed = await inOwnerTransaction(client, async () => {
      await client.query(PARTITION_LOCK);
      // Re-plan this partition under the lock: still attached, still removable.
      const current = (await listPartitions(client)).find((p) => p.name === decision.partition.name && p.table === decision.partition.table);
      if (!current) return null;
      await client.query(`ALTER TABLE trustwork.${ident(current.table)} DETACH PARTITION trustwork.${ident(current.name)}`);
      const facts = await partitionFacts(client, current);
      const again = decidePartition(current, facts, policy, now);
      if (again.action !== 'remove') throw new KeepPartition(current.name, again.reason);
      const archiveKey = `archive/${current.table}/${current.name}/${now.toISOString().replace(/[-:.]/g, '')}.jsonl`;
      const { rows } = await client.query<{ line: string }>(`SELECT row_to_json(t)::text AS line FROM trustwork.${ident(current.name)} t ORDER BY 1`);
      const body = Buffer.from(rows.map((r) => r.line).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      const put = await putSealed(input.target as BackupTarget, input.key as BackupKey, archiveKey, body, 'application/x-ndjson');
      const readBack = await getSealed(input.target as BackupTarget, input.key as BackupKey, archiveKey, put.sha256);
      const lines = readBack ? readBack.toString('utf8').split('\n').filter(Boolean).length : -1;
      if (lines !== facts.rows) throw new Error(`archive of ${current.name} holds ${lines} rows, expected ${facts.rows}; partition kept`);
      await client.query(`DROP TABLE trustwork.${ident(current.name)}`);
      await client.query(`INSERT INTO trustwork.audit_event (action, object_kind, object_id, reason, basis) VALUES ('retention.partition_removed', 'partition', $1, $2, $3)`, [
        current.name,
        `older than ${retainDays(policy, current.table)} days (hub ${policy.hubId} policy v${policy.version})`,
        JSON.stringify({ table: current.table, from: current.from?.toISOString(), to: current.to?.toISOString(), rows: facts.rows, archiveKey, archiveSha256: put.sha256, operator: input.operator }),
      ]);
      return { table: current.table, name: current.name, rows: facts.rows, archiveKey, archiveSha256: put.sha256 };
    }).catch((error: unknown) => {
      if (error instanceof KeepPartition) {
        result.kept.push({ name: error.partition, reason: error.reason });
        return null;
      }
      throw error;
    });
    if (removed) result.removed.push(removed);
  }
  return result;
}

class KeepPartition extends Error {
  constructor(readonly partition: string, readonly reason: string) {
    super(`partition ${partition} kept: ${reason}`);
  }
}

/** BEGIN; SET LOCAL ROLE trustwork_owner; maintenance flag; fn; COMMIT (ROLLBACK on any error). */
export async function inOwnerTransaction<T>(client: Pick<pg.ClientBase, 'query'>, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE trustwork_owner');
    await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
    const value = await fn();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
