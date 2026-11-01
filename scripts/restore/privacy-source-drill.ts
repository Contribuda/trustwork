import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { sql } from 'kysely';
import { bindTransaction, withMaintenance, type Transaction } from '@trustwork/data';
import { adminSetup, staffRoleDefinitions, caseGrants, type CommandContext } from '../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../packages/data/src/repositories/identity.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { executeLocalSourceErasure } from '../../apps/api/src/modules/platform-admin/privacy/source-executor.js';
import type { PrivacyDrillFixture } from './privacy-drill.js';

export interface SourceDrillFixture {
  fieldId: string; recordId: string; sourceId: string; evidenceDigest: string;
  officer: string; reviewer: string; requestId?: string; planId?: string;
}
/** Synthetic setup only. Decisions below use the real elevated case/grant and independent approval commands. */
export async function provisionSourceDrill(admin: pg.Pool, fixture: PrivacyDrillFixture): Promise<SourceDrillFixture> {
  return withMaintenance(admin, async (trx) => {
    if (!await adminSetup.node(trx)) await adminSetup.createNode(trx, 'Synthetic privacy restore node');
    const people = await trx.insertInto('person').values([{ display_name: 'Synthetic restore privacy officer' }, { display_name: 'Synthetic restore independent reviewer' }]).returning('id').execute();
    const officer = people[0]!.id; const reviewer = people[1]!.id;
    for (const [role, personId] of [['platform-owner', officer], ['staff-admin', reviewer]] as const) {
      await staffRoleDefinitions.release(trx, { version: 9137, role, scopes: ['platform'], permissions: [
        'admin.privacy.hold', 'admin.privacy.erasure.execute', 'admin.privacy.request.read', 'admin.privacy.export',
        'admin.support.case.create', 'admin.support.grant.request', 'admin.support.grant.approve'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 24 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
      await adminSetup.bootstrapFirstAdmin(trx, { personId, role, scope: { kind: 'platform' }, definitionVersion: 9137, reason: 'Synthetic isolated restore setup' });
    }
    await trx.insertInto('privacy_country_policy').values({ country: 'ZZ', version: 'synthetic-restore-v2', review: 'verified',
      sources: JSON.stringify(['https://example.invalid/synthetic-restore-policy']), deadline_days: 3, retention_days: 0 }).execute();
    const original = await trx.selectFrom('sourced_record_field').selectAll().where('id', '=', fixture.sourceFieldId).executeTakeFirstOrThrow();
    const recordId = randomUUID();
    const field = await trx.insertInto('sourced_record_field').values({ hub_id: fixture.hubId, source_id: original.source_id,
      import_batch_id: original.import_batch_id, record_kind: original.record_kind, record_id: recordId,
      field: 'description', value: 'Synthetic v2 immutable source evidence' }).returning('id').executeTakeFirstOrThrow();
    return { officer, reviewer, fieldId: field.id, recordId, sourceId: original.source_id, evidenceDigest: '' };
  }).then(async (source) => ({ ...source, evidenceDigest: await withMaintenance(admin, async (trx) =>
    (await sql<{ digest: string }>`SELECT trustwork.admin_digest(to_jsonb(f)-'active'-'deactivated_at'-'takedown_id') AS digest
      FROM trustwork.sourced_record_field f WHERE id=${source.fieldId}::uuid`.execute(trx)).rows[0]!.digest) }));
}
async function as<T>(admin: pg.Pool, person: string, fn: (trx: Transaction) => Promise<T>): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE trustwork_owner');
    await client.query('SET LOCAL search_path=trustwork,pg_temp');
    await client.query('SELECT trustwork.set_principal($1,(SELECT authz_epoch FROM trustwork.auth_person_epoch($1)))', [person]);
    const value = await fn(bindTransaction(client)); await client.query('COMMIT'); return value;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function context(admin: pg.Pool, person: string): Promise<CommandContext> {
  const session = await withMaintenance(admin, (trx) => trx.insertInto('session').values({ person_id: person, token_hash: randomBytes(32),
    idle_expires_at: new Date(Date.now() + 3600_000), absolute_expires_at: new Date(Date.now() + 3600_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
  const elevation = await withMaintenance(admin, (trx) => sessionElevations.insert(trx, { personId: person, sessionId: session.id,
    factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) }));
  return { elevationId: elevation.id, requestId: `synthetic-${randomUUID()}`, reasonCode: 'synthetic_drill', reasonText: 'Synthetic source restore decision' };
}
export async function recordSourceDrill(admin: pg.Pool, fixture: PrivacyDrillFixture): Promise<void> {
  const s = fixture.sourceV2!; const ctx = await context(admin, s.officer); const review = await context(admin, s.reviewer);
  const intake = await as(admin, s.officer, (trx) => privacy.externalSourceCase(trx, ctx, { hubId: fixture.hubId, sourceFieldId: s.fieldId,
    action: 'erasure', proposedValue: null, country: 'ZZ', method: 'signed_statement', evidenceDigest: createHash('sha256').update('Synthetic signed v2 source request').digest('hex') }));
  const grantInput = { supportCaseId: intake.caseId, objectType: 'sourced_record_field', objectIds: [s.fieldId],
    projectionClass: 'support_private_limited' as const, purpose: 'Synthetic exact source restore decision', expiresInSeconds: 3600 };
  let grant = await as(admin, s.officer, (trx) => caseGrants.request(trx, ctx, grantInput));
  grant = await as(admin, s.reviewer, (trx) => caseGrants.decide(trx, review, grant.id, 'approve', grant.request_digest));
  let second = await as(admin, s.reviewer, (trx) => caseGrants.request(trx, review, grantInput));
  second = await as(admin, s.officer, (trx) => caseGrants.decide(trx, ctx, second.id, 'approve', second.request_digest));
  const proof = randomBytes(32).toString('hex'); const tokenHash = createHash('sha256').update(proof).digest('hex');
  await as(admin, s.officer, (trx) => privacy.sourceProof(trx, ctx, { sourceFieldId: s.fieldId, grantId: grant.id, action: 'erasure',
    method: 'signed_statement', evidenceRef: intake.evidenceRef, tokenHash }));
  await admin.query('SELECT trustwork.privacy_source_submit($1,$2,NULL)', [tokenHash, 'erasure']);
  s.requestId = await withMaintenance(admin, async (trx) => (await trx.selectFrom('privacy_source_request').select('id').where('source_field_id', '=', s.fieldId).executeTakeFirstOrThrow()).id);
  const plan = await as(admin, s.officer, (trx) => privacy.proposeSourcePlan(trx, ctx, s.requestId!, grant.id)); s.planId = plan.id;
  await as(admin, s.reviewer, (trx) => privacy.approveSourcePlan(trx, review, plan.id, second.id, plan.digest));
  await executeLocalSourceErasure({ admin, personId: s.officer, authzEpoch: await withMaintenance(admin, async (trx) => (await trx.selectFrom('person').select('authz_epoch').where('id', '=', s.officer).executeTakeFirstOrThrow()).authz_epoch),
    context: ctx, planId: plan.id, digest: plan.digest, ledger: fixture.ledger,
    retainedAuthority: { directory: fixture.binding.authorityDirectory, journalId: fixture.binding.journalId } });
}
export async function verifySourceDrill(client: pg.PoolClient, fixture: PrivacyDrillFixture): Promise<Record<string, boolean>> {
  const s = fixture.sourceV2!;
  const field = (await client.query<{ active: boolean; digest: string }>("SELECT active,trustwork.admin_digest(to_jsonb(f)-'active'-'deactivated_at'-'takedown_id') AS digest FROM trustwork.sourced_record_field f WHERE id=$1", [s.fieldId])).rows[0];
  const receipt = await client.query('SELECT 1 FROM trustwork.source_privacy_replay_receipt WHERE request_id=$1 AND source_field_id=$2', [s.requestId, s.fieldId]);
  const projection = (await client.query<{ v: { fields: unknown[] } }>("SELECT trustwork.sources_public_provenance($1,'professional_credential',$2) AS v", [fixture.hubId, s.recordId])).rows[0]!.v;
  await client.query('SAVEPOINT source_v2_reimport'); let denied = false;
  try { await client.query(`INSERT INTO trustwork.sourced_record_field(hub_id,record_kind,record_id,field,value,source_id,import_batch_id)
    SELECT hub_id,record_kind,record_id,field,value,source_id,import_batch_id FROM trustwork.sourced_record_field WHERE id=$1`, [s.fieldId]); }
  catch (error) { if ((error as { hint?: string }).hint !== 'privacy.do_not_collect') throw error; denied = true; }
  await client.query('ROLLBACK TO SAVEPOINT source_v2_reimport');
  return { sourceV2Deactivated: field?.active === false, sourceV2EvidencePreserved: field?.digest === s.evidenceDigest,
    sourceV2Receipt: receipt.rowCount === 1, sourceV2ProjectionSuppressed: projection.fields.length === 0, sourceV2ReimportDenied: denied };
}
