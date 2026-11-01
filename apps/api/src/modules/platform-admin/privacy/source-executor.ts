import type pg from 'pg';
import type { CommandContext } from '../../../../../../packages/data/src/repositories/admin.js';
import { PrivacySourceTombstoneSchema } from '../../../../../../packages/contracts/src/privacy.js';
import type { PrivacyErasureLedger, RetainedPrivacyAuthority } from './ledger.js';

/** Explicit local fixture executor only. Runtime has no owner connection or journal activation port. */
export async function executeLocalSourceErasure(input: {
  admin: pg.Pool; personId: string; authzEpoch: number; context: CommandContext; planId: string; digest: string;
  ledger: PrivacyErasureLedger; retainedAuthority: RetainedPrivacyAuthority;
}) {
  if (process.env.NODE_ENV === 'production') throw new Error('local source executor unavailable in production');
  input.ledger.assertAuthority(input.retainedAuthority);
  const client = await input.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE trustwork_app');
    await client.query('SELECT trustwork.set_principal($1,$2)', [input.personId, input.authzEpoch]);
    const { rows } = await client.query<{ v: Record<string, unknown> }>('SELECT trustwork.privacy_source_plan_admit($1::jsonb,$2::uuid,$3) AS v', [JSON.stringify(input.context), input.planId, input.digest]);
    const admission = rows[0]!.v;
    if (admission.action !== 'erasure') throw new Error('not a source erasure plan');
    const record = PrivacySourceTombstoneSchema.parse({ version: 2, requestId: admission.requestId, planId: input.planId,
      sourceFieldId: admission.sourceFieldId, sourceId: admission.sourceId, recordKind: admission.recordKind, recordId: admission.recordId,
      evidenceDigest: admission.sourceEvidenceDigest, executedBy: admission.executedBy, approvedBy: admission.approvedBy,
      policyDigest: input.digest, recordedAt: new Date().toISOString(), modules: ['sources'] });
    // The owner-only mutation is reachable only after the independently retained checkpoint is durable.
    return await input.ledger.withDecision(record, async (entry) => {
      await client.query('SELECT trustwork.admin_consume_approval($1,$2,$3,NULL,NULL,$4,$5)',
        [admission.approvalId, 'privacy.execute_erasure', 'platform', input.digest, input.planId]);
      await client.query('RESET ROLE');
      await client.query('SET LOCAL ROLE trustwork_owner');
      await client.query("SELECT set_config('trustwork.maintenance','on',true)");
      await client.query('SELECT trustwork.sources_apply_privacy_resolution($1,$2)', [input.planId, entry.digest]);
      await client.query('SELECT trustwork.sources_replay_privacy_erasure($1::jsonb,$2)', [JSON.stringify(record), entry.digest]);
      await client.query('COMMIT');
      return { scope: 'exact_source_field' as const, complete: false as const, evidenceRetained: true as const };
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(true); }
}
