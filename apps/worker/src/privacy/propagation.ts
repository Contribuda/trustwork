import type { DataPool } from '@trustwork/data';
import { PrivacyPropagationSchema, type PrivacyPropagation } from '../../../../packages/contracts/src/privacy.js';

export interface PrivacyPropagationPort {
  readonly target: PrivacyPropagation['target'];
  /** Must apply the exact instruction id/digest idempotently, through the owning projection service. */
  apply(instruction: PrivacyPropagation): Promise<{ receipt: string }>;
  /** Unknown is terminal for this attempt. Only authoritative absence permits an idempotent retry. */
  reconcile(instruction: PrivacyPropagation): Promise<{ state: 'applied'; receipt: string } | { state: 'absent' | 'unknown' }>;
}
interface Stored { id: string; payload: unknown; decision_digest: string; state: 'pending' | 'outcome_unknown' | 'acknowledged'; receipt: string | null }

/** No default transport. Pending work stays pending until an owning consumer is explicitly supplied. */
export async function consumePrivacyPropagation(pool: DataPool, id: string, port?: PrivacyPropagationPort): Promise<'unavailable' | 'outcome_unknown' | 'acknowledged'> {
  if (!port) return 'unavailable';
  const client = await pool.connect();
  let locked = false;
  let healthy = true;
  try {
    // Session lock spans the committed unknown marker, dispatch/reconciliation and receipt commit.
    // A process death releases the lock, but its durable unknown outcome survives for the next process.
    await client.query("SELECT pg_advisory_lock(hashtextextended('privacy:propagation:' || $1::text,0))", [id]); locked = true;
    const row = (await client.query<Stored>('SELECT * FROM trustwork.privacy_propagation_get($1)', [id])).rows[0];
    if (!row?.id) throw new Error('privacy propagation unavailable');
    const instruction = PrivacyPropagationSchema.parse(row.payload);
    if (instruction.id !== id || instruction.digest !== row.decision_digest || instruction.target !== port.target) throw new Error('privacy propagation binding mismatch');
    if (row.state === 'acknowledged') return 'acknowledged';
    let receipt: string | undefined;
    if (row.state === 'outcome_unknown') {
      const result = await port.reconcile(instruction);
      if (result.state === 'unknown') return 'outcome_unknown';
      if (result.state === 'applied') receipt = result.receipt;
    }
    if (!receipt) {
      await client.query('SELECT trustwork.privacy_propagation_record($1,$2,NULL)', [id, instruction.digest]);
      receipt = (await port.apply(instruction)).receipt;
    }
    if (!receipt || receipt.length > 200) throw new Error('privacy propagation receipt unavailable');
    await client.query('SELECT trustwork.privacy_propagation_record($1,$2,$3)', [id, instruction.digest, receipt]);
    return 'acknowledged';
  } catch (error) {
    healthy = false;
    throw error;
  } finally {
    if (locked && healthy) await client.query("SELECT pg_advisory_unlock(hashtextextended('privacy:propagation:' || $1::text,0))", [id]).catch(() => { healthy = false; });
    client.release(!healthy);
  }
}
