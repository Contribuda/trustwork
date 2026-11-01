import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type pg from 'pg';
import { mailAddressHash } from '../../packages/data/src/repositories/mail.js';
import { provisionLocalPrivacyJournal, replayPrivacyLedger, type LocalJournalBinding, type PrivacyErasureLedger } from '../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import { inOwnerTransaction } from '../../infra/backup/src/retention.js';
import { runLocalPrivacyRestoreCli } from './cli.js';
import type { RestoreProject } from './stage.js';

/** Synthetic privacy-owned redaction only; never claims that another module's subject records were erased. */
export interface PrivacyDrillFixture {
  binding: LocalJournalBinding; ledger: PrivacyErasureLedger; requestId: string; subjectId: string; approverId: string;
  contactDigest: string; sourceDigest: string; sourceFieldId: string; sourceRecordId: string; hubId: string;
}
export async function provisionPrivacyDrill(work: string, admin: pg.Pool, people: string[]): Promise<PrivacyDrillFixture> {
  const binding = { authorityDirectory: join(work, 'privacy-authority'), journalDirectory: join(work, 'privacy-journal'), journalId: randomUUID() };
  const ledger = await provisionLocalPrivacyJournal(binding);
  const client = await admin.connect();
  try {
    return await inOwnerTransaction(client, async () => {
      const subjectId = people[0]!; const approverId = people[1]!;
      const requestId = (await client.query<{ id: string }>(`INSERT INTO trustwork.privacy_request
        (requested_by,subject_kind,subject_id,kind,country,policy_status,correction)
        VALUES($1,'person',$1,'correction','ZZ','UNKNOWN','{"field":"profile","proposedValue":"synthetic erased detail"}') RETURNING id`, [subjectId])).rows[0]!.id;
      // Fixture provisioning is explicit maintenance, not a runtime identity-proof or source-approval shortcut.
      // Use a real SRC record kind and owning projection so restoration cannot pass with an unused hash.
      const hubId = (await client.query<{ id: string }>("INSERT INTO trustwork.hub(slug,lifecycle) VALUES($1,'public') RETURNING id", [`synthetic-privacy-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
      const sourceId = (await client.query<{ id: string }>(`INSERT INTO trustwork.source
        (hub_id,kind,name,reader_kind,purposes,licence_kind,allowed_uses,attribution_template,takedown_contact,
         owner_person_id,personal_data,legal_basis,proposed_by_person,edited_by,status,activated_by,activated_at)
        VALUES($1,'manual','Synthetic restore source','other',ARRAY['people_directory'],'unknown',
         trustwork.sources_most_restrictive() || '{"displayHeadlineAndLink":true}'::jsonb,'Synthetic attribution','synthetic@example.invalid',
         $2,true,'consent',$2,$2,'active',$3,now()) RETURNING id`, [hubId, subjectId, approverId])).rows[0]!.id;
      const batchId = (await client.query<{ id: string }>(`INSERT INTO trustwork.import_batch
        (source_id,hub_id,staged_by,counts,licence_snapshot,status,decided_by,decided_at)
        SELECT id,hub_id,$2,'{"fields":1}',jsonb_build_object('allowedUses',allowed_uses),'activated',$3,now()
        FROM trustwork.source WHERE id=$1 RETURNING id`, [sourceId, subjectId, approverId])).rows[0]!.id;
      const sourceRecordId = randomUUID();
      const sourceFieldId = (await client.query<{ id: string }>(`INSERT INTO trustwork.sourced_record_field
        (hub_id,record_kind,record_id,field,value,source_id,import_batch_id)
        VALUES($1,'professional_credential',$2,'description','Synthetic retained source evidence',$3,$4) RETURNING id`, [hubId, sourceRecordId, sourceId, batchId])).rows[0]!.id;
      const projected = (await client.query<{ projection: { fields: unknown[] } }>("SELECT trustwork.sources_public_provenance($1,'professional_credential',$2) AS projection", [hubId, sourceRecordId])).rows[0]!.projection;
      if (projected.fields.length !== 1) throw new Error('synthetic source must be visible before backup');
      const sourceDigest = (await client.query<{ digest: string }>("SELECT trustwork.privacy_source_key('professional_credential',$1) AS digest", [sourceRecordId])).rows[0]!.digest;
      return { binding, ledger, requestId, subjectId, approverId, contactDigest: mailAddressHash('synthetic-erased@example.invalid'), sourceDigest, sourceFieldId, sourceRecordId, hubId };
    });
  } finally { client.release(); }
}
export async function recordPrivacyDrill(fixture: PrivacyDrillFixture, admin: pg.Pool): Promise<void> {
  await fixture.ledger.withDecision({ version: 1, requestId: fixture.requestId, subject: { kind: 'person', id: fixture.subjectId },
    executedBy: fixture.subjectId, approvedBy: fixture.approverId, policyDigest: 'a'.repeat(64), recordedAt: new Date().toISOString(),
    modules: ['privacy'], suppressionDigests: [fixture.contactDigest, fixture.sourceDigest] }, async (entry) => {
    const client = await admin.connect();
    try { await inOwnerTransaction(client, () => replayPrivacyLedger(client, [entry])); } finally { client.release(); }
  });
}
export async function authorizePrivacyDrill(fixture: PrivacyDrillFixture, connectionString: string, project: RestoreProject, restoreId: string): Promise<string> {
  const output: string[] = []; const errors: string[] = [];
  const code = await runLocalPrivacyRestoreCli(['authorize', '--restore-id', restoreId, '--reference', `synthetic:${restoreId}`, '--operator', 'drill-operator',
    '--project', project.project, '--volume', project.volume, '--port', String(project.port)], { RESTORE_DATABASE_URL: connectionString },
  { out: (line) => output.push(line), err: (line) => errors.push(line) }, fixture.binding);
  if (code !== 0) throw new Error(`local privacy CLI refused: ${errors.join('; ')}`);
  return (JSON.parse(output[0]!) as { authorizedAt: string }).authorizedAt;
}
export async function verifyPrivacyDrill(fixture: PrivacyDrillFixture, admin: pg.Pool, worker: pg.Pool): Promise<Record<string, boolean>> {
  const client = await admin.connect();
  try {
    return await inOwnerTransaction(client, async () => {
      const row = (await client.query<{ correction: unknown; state: string }>('SELECT correction,state FROM trustwork.privacy_request WHERE id=$1', [fixture.requestId])).rows[0];
      const suppression = (await client.query('SELECT digest FROM trustwork.privacy_suppression WHERE digest=ANY($1) AND marketing AND do_not_collect', [[fixture.contactDigest, fixture.sourceDigest]])).rowCount;
      const mail = (await client.query('SELECT 1 FROM trustwork.suppression_entry WHERE address_hash=$1', [fixture.contactDigest])).rowCount;
      const allowed = (await worker.query<{ allowed: boolean }>('SELECT trustwork.privacy_marketing_allowed($1) AS allowed', [fixture.contactDigest])).rows[0]!.allowed;
      const projected = (await client.query<{ projection: { fields: unknown[] } }>("SELECT trustwork.sources_public_provenance($1,'professional_credential',$2) AS projection", [fixture.hubId, fixture.sourceRecordId])).rows[0]!.projection;
      const source = (await client.query<{ value: string }>('SELECT value FROM trustwork.sourced_record_field WHERE id=$1', [fixture.sourceFieldId])).rows[0];
      await client.query('SAVEPOINT privacy_reimport');
      let reimportDenied = false;
      try {
        await client.query(`INSERT INTO trustwork.sourced_record_field(hub_id,record_kind,record_id,field,value,source_id,import_batch_id)
          SELECT hub_id,record_kind,record_id,field,value,source_id,import_batch_id FROM trustwork.sourced_record_field WHERE id=$1`, [fixture.sourceFieldId]);
      } catch (error) { if ((error as { hint?: string }).hint !== 'privacy.do_not_collect') throw error; reimportDenied = true; }
      await client.query('ROLLBACK TO SAVEPOINT privacy_reimport');
      return { correctionRedacted: JSON.stringify(row?.correction) === '{"redacted":true}', subjectNotClaimedDeleted: row?.state === 'open',
        minimalSuppressionRestored: suppression === 2, owningMailSuppressionRestored: mail === 1, deliveryBarrierDenied: !allowed,
        sourceProjectionSuppressed: projected.fields.length === 0, sourceReimportDenied: reimportDenied,
        sourceEvidencePreserved: source?.value === 'Synthetic retained source evidence' };
    });
  } finally { client.release(); }
}
