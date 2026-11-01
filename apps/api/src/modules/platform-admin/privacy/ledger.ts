import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type pg from 'pg';
import type { BlobStore } from '../../../../../../packages/data/src/files/blob-store.js';
import { FilesystemBlobStore } from '../../../../../../packages/data/src/files/filesystem.js';
import { PrivacyTombstoneSchema, type PrivacyTombstone } from '../../../../../../packages/contracts/src/privacy.js';

const PREFIX = 'privacy-erasure/';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** External append-only, content-addressed decisions. No delete/overwrite capability is exposed by this class. */
export class PrivacyErasureLedger {
  constructor(private readonly store: BlobStore) {
    if (store.kind !== 'filesystem') throw new Error('privacy ledger currently supports the local storage fake only');
  }
  async record(input: PrivacyTombstone): Promise<void> {
    const record = PrivacyTombstoneSchema.parse(input);
    const body = Buffer.from(JSON.stringify(record));
    const key = `${PREFIX}${record.requestId}/${digest(body)}.json`;
    const prior = (await this.all()).find((r) => r.record.requestId === record.requestId);
    if (prior && prior.digest !== digest(body)) throw new Error('conflicting irreversible privacy decision');
    if (!prior) await this.store.put(key, body, 'application/json');
    // Concurrent contradictory decisions create separate immutable keys and fail closed on every subsequent read.
    const verified = (await this.all()).find((r) => r.record.requestId === record.requestId);
    if (verified?.digest !== digest(body)) throw new Error('privacy ledger durability verification failed');
  }
  async all(): Promise<Array<{ record: PrivacyTombstone; digest: string }>> {
    const records = new Map<string, { record: PrivacyTombstone; digest: string }>();
    for (const key of await this.store.list(PREFIX)) {
      const body = await this.store.read(key, 64 * 1024);
      if (!body) throw new Error('privacy ledger object disappeared');
      const record = PrivacyTombstoneSchema.parse(JSON.parse(Buffer.from(body).toString('utf8')));
      const hash = digest(body);
      if (key !== `${PREFIX}${record.requestId}/${hash}.json`) throw new Error('privacy ledger integrity failure');
      const prior = records.get(record.requestId);
      if (prior && prior.digest !== hash) throw new Error('conflicting irreversible privacy decision');
      records.set(record.requestId, { record, digest: hash });
    }
    return [...records.values()];
  }
}

/** Configuration, never a request body. This bucket is separate from backed-up files and database snapshots. */
export function privacyLedgerFromEnv(env: NodeJS.ProcessEnv): PrivacyErasureLedger {
  if (env.FILES_STORAGE !== 'filesystem' || env.NODE_ENV === 'production') throw new Error('a separately retained local privacy ledger is required; provider adapters are unavailable');
  return new PrivacyErasureLedger(new FilesystemBlobStore({ root: env.FILES_FS_ROOT ?? join(tmpdir(), 'trustwork-files'), bucket: 'trustwork-privacy-ledger' }));
}

/**
 * Called under the restore owner's transaction and restore lock, BEFORE the runtime fence can lift.
 * Every ledger module must have a real replay adapter. An unsupported decision keeps the entire restore fenced.
 * This slice implements only privacy-owned data; it does not pretend to erase other modules.
 */
export async function replayPrivacyLedger(client: pg.PoolClient, ledger: PrivacyErasureLedger): Promise<number> {
  const entries = await ledger.all();
  for (const { record } of entries) {
    if (record.modules.some((m) => m !== 'privacy')) throw new Error('privacy replay adapter unavailable; restore must remain fenced');
  }
  for (const { record, digest: hash } of entries) {
    await client.query('SELECT trustwork.privacy_lock_subject($1, $2::uuid)', [record.subject.kind, record.subject.id]);
    const held = await client.query('SELECT id FROM trustwork.legal_hold WHERE subject_kind=$1 AND subject_id=$2 AND released_at IS NULL', [record.subject.kind, record.subject.id]);
    if (held.rowCount) throw new Error('privacy restore decision conflicts with a retained legal hold');
    const prior = await client.query<{ ledger_digest: string }>('SELECT ledger_digest FROM trustwork.privacy_replay_receipt WHERE request_id=$1', [record.requestId]);
    if (prior.rows[0] && prior.rows[0].ledger_digest !== hash) throw new Error('privacy replay receipt conflicts with ledger');
    await client.query(`UPDATE trustwork.privacy_request SET correction='{"redacted":true}'::jsonb WHERE subject_kind=$1 AND subject_id=$2 AND correction IS NOT NULL`, [record.subject.kind, record.subject.id]);
    await client.query('INSERT INTO trustwork.privacy_replay_receipt(request_id,subject_kind,subject_id,ledger_digest) VALUES($1,$2,$3,$4) ON CONFLICT(request_id) DO NOTHING',
      [record.requestId, record.subject.kind, record.subject.id, hash]);
    for (const key of record.suppressionDigests) {
      await client.query(`INSERT INTO trustwork.privacy_suppression(digest,marketing,do_not_collect) VALUES($1,true,true)
        ON CONFLICT(digest) DO UPDATE SET marketing=true,do_not_collect=true`, [key]);
    }
  }
  return entries.length;
}
