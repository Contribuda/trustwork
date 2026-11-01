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
  contactDigest: string; sourceDigest: string;
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
      const sourceDigest = (await client.query<{ digest: string }>("SELECT trustwork.privacy_source_key('person',$1) AS digest", [subjectId])).rows[0]!.digest;
      return { binding, ledger, requestId, subjectId, approverId, contactDigest: mailAddressHash('synthetic-erased@example.invalid'), sourceDigest };
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
      return { correctionRedacted: JSON.stringify(row?.correction) === '{"redacted":true}', subjectNotClaimedDeleted: row?.state === 'open',
        minimalSuppressionRestored: suppression === 2, owningMailSuppressionRestored: mail === 1, deliveryBarrierDenied: !allowed };
    });
  } finally { client.release(); }
}
