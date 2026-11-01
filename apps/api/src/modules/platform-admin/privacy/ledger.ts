import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rmdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type pg from 'pg';
import { PrivacyPropagationSchema, PrivacyRetainedDecisionSchema, type PrivacyRetainedDecision } from '../../../../../../packages/contracts/src/privacy.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const EMPTY = '0'.repeat(64);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Checkpoint = z.strictObject({ version: z.literal(1), journalId: z.uuid(), sequence: z.int().nonnegative(),
  head: Digest, sealed: z.boolean() });
const Entry = z.strictObject({ version: z.literal(1), journalId: z.uuid(), sequence: z.int().positive(),
  previous: Digest, record: PrivacyRetainedDecisionSchema });
export type PrivacyJournalCheckpoint = z.infer<typeof Checkpoint>;
export interface PrivacyLedgerEntry { record: PrivacyRetainedDecision; digest: string }
export type LocalJournalStep = 'entry_synced' | 'checkpoint_synced' | 'restore_sealed';
export interface RetainedPrivacyAuthority {
  directory: string;
  journalId: string;
}
export interface LocalJournalBinding {
  /** Independently provisioned retained authority; never selected by the restore operator. */
  authorityDirectory: string;
  /** Pinned by installation provisioning, independently of the database and journal path. */
  journalId: string;
  journalDirectory: string;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeDurable(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
async function replaceDurable(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeDurable(temporary, text);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

/**
 * Local fixture foundation only. No API, worker or production configuration can enable subject erasure.
 * The independently retained checkpoint is the authority, not the journal listing or restored DB receipts.
 * Exclusive mkdir on that authority serializes all processes. No TTL/PID-based lock stealing is safe here:
 * a failed operation or process death leaves the lock for forensic recovery, never an automatic fence lift.
 */
export class PrivacyErasureLedger {
  readonly binding: Readonly<LocalJournalBinding>;
  constructor(binding: LocalJournalBinding, private readonly onDurableStep?: (step: LocalJournalStep) => Promise<void>) {
    if (process.env.NODE_ENV === 'production') throw new Error('local privacy journal is unavailable in production');
    this.binding = Object.freeze({ ...binding });
    z.uuid().parse(binding.journalId);
    if (![binding.authorityDirectory, binding.journalDirectory].every(isAbsolute)) throw new Error('explicit absolute journal and authority paths required');
  }
  assertAuthority(expected: RetainedPrivacyAuthority): void {
    if (!expected || expected.journalId !== this.binding.journalId || resolve(expected.directory) !== resolve(this.binding.authorityDirectory)) {
      throw new Error('journal does not match the independently pinned retained authority');
    }
  }
  private get checkpointPath() { return join(this.binding.authorityDirectory, 'checkpoint.json'); }
  private get lockPath() { return join(this.binding.authorityDirectory, 'operation.lock'); }

  private async verify(): Promise<{ checkpoint: z.infer<typeof Checkpoint>; entries: PrivacyLedgerEntry[] }> {
    const authority = await realpath(this.binding.authorityDirectory);
    const journal = await realpath(this.binding.journalDirectory);
    const nested = (a: string, b: string) => { const r = relative(a, b); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
    if (nested(authority, journal) || nested(journal, authority)) throw new Error('authority and journal must be independently retained directories');
    const checkpoint = Checkpoint.parse(JSON.parse(await readFile(this.checkpointPath, 'utf8')));
    const identity = JSON.parse(await readFile(join(journal, 'identity.json'), 'utf8')) as { journalId?: string };
    if (checkpoint.journalId !== this.binding.journalId || identity.journalId !== this.binding.journalId) throw new Error('wrong retained privacy journal identity');
    const files = (await readdir(journal)).filter((f) => f !== 'identity.json').sort();
    if (files.length !== checkpoint.sequence) throw new Error('privacy journal missing, rolled back or uncheckpointed');
    let head = EMPTY;
    const entries: PrivacyLedgerEntry[] = [];
    const ids = new Set<string>();
    for (let i = 0; i < files.length; i++) {
      if (files[i] !== `${String(i + 1).padStart(12, '0')}.json`) throw new Error('privacy journal sequence gap');
      const body = await readFile(join(journal, files[i]!), 'utf8');
      const entry = Entry.parse(JSON.parse(body));
      if (entry.journalId !== checkpoint.journalId || entry.sequence !== i + 1 || entry.previous !== head || ids.has(entry.record.requestId)) throw new Error('privacy journal integrity failure');
      ids.add(entry.record.requestId);
      entries.push({ record: entry.record, digest: hash(JSON.stringify(entry.record)) });
      head = hash(body);
    }
    if (head !== checkpoint.head) throw new Error('privacy journal checkpoint mismatch');
    return { checkpoint, entries };
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    // The parent must already exist; creating a fresh authority here would erase history.
    await mkdir(this.lockPath, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('privacy journal locked; incomplete operation requires retained-authority recovery');
      throw error;
    });
    await syncDirectory(this.binding.authorityDirectory);
    const result = await operation();
    // Deliberately no finally: an uncertain write, DB commit or fence lift retains the lock.
    await rmdir(this.lockPath);
    await syncDirectory(this.binding.authorityDirectory);
    return result;
  }
  async all(): Promise<PrivacyLedgerEntry[]> {
    return this.exclusive(async () => (await this.verify()).entries);
  }
  async record(input: PrivacyRetainedDecision): Promise<void> {
    await this.withDecision(input, async () => undefined);
  }
  /** Local owning executor boundary: journal/checkpoint first, then DB commit, retaining the lock on any uncertainty. */
  async withDecision<T>(input: PrivacyRetainedDecision, operation: (entry: PrivacyLedgerEntry) => Promise<T>): Promise<T> {
    const record = PrivacyRetainedDecisionSchema.parse(input);
    return this.exclusive(async () => {
      const { checkpoint, entries } = await this.verify();
      if (checkpoint.sealed) throw new Error('privacy journal sealed for restore; live erasure executor unavailable');
      const prior = entries.find((e) => e.record.requestId === record.requestId);
      if (prior) {
        if (prior.digest !== hash(JSON.stringify(record))) throw new Error('conflicting irreversible privacy decision');
        return operation(prior);
      }
      const sequence = checkpoint.sequence + 1;
      const body = JSON.stringify({ version: 1, journalId: checkpoint.journalId, sequence, previous: checkpoint.head, record });
      await writeDurable(join(this.binding.journalDirectory, `${String(sequence).padStart(12, '0')}.json`), body);
      await this.onDurableStep?.('entry_synced');
      await replaceDurable(this.checkpointPath, JSON.stringify({ ...checkpoint, sequence, head: hash(body) }));
      await this.onDurableStep?.('checkpoint_synced');
      await this.verify();
      return operation({ record, digest: hash(JSON.stringify(record)) });
    });
  }
  /** The freeze spans snapshot, DB replay/commit and fence lift. Seal prevents later unfenced decisions. */
  async withRestore<T>(operation: (entries: readonly PrivacyLedgerEntry[], checkpoint: PrivacyJournalCheckpoint) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const { checkpoint, entries } = await this.verify();
      await replaceDurable(this.checkpointPath, JSON.stringify({ ...checkpoint, sealed: true }));
      await this.onDurableStep?.('restore_sealed');
      return operation(entries, { ...checkpoint, sealed: true });
    });
  }
}

/** No temporary-root fallback and no runtime rollout adapter. This must not be used by the existing CLI. */
export function privacyLedgerFromEnv(env: NodeJS.ProcessEnv): never {
  void env; // Configuration cannot opt into the isolated local proof.
  throw new Error('privacy erasure rollout unavailable; independently provisioned retained authority required');
}

/** One-time local fixture provisioning only; refuses every existing directory, even an empty one. */
export async function provisionLocalPrivacyJournal(binding: LocalJournalBinding): Promise<PrivacyErasureLedger> {
  const ledger = new PrivacyErasureLedger(binding);
  await mkdir(binding.authorityDirectory, { mode: 0o700 });
  await syncDirectory(dirname(binding.authorityDirectory));
  await mkdir(binding.journalDirectory, { mode: 0o700 });
  await syncDirectory(dirname(binding.journalDirectory));
  await writeDurable(join(binding.journalDirectory, 'identity.json'), JSON.stringify({ journalId: binding.journalId }));
  await writeDurable(join(binding.authorityDirectory, 'checkpoint.json'), JSON.stringify({ version: 1, journalId: binding.journalId, sequence: 0, head: EMPTY, sealed: false }));
  await ledger.all();
  return ledger;
}

/**
 * Called under the restore owner's transaction and restore lock, BEFORE the runtime fence can lift.
 * Every ledger module must have a real replay adapter. An unsupported decision keeps the entire restore fenced.
 * This slice implements only privacy-owned data; it does not pretend to erase other modules.
 */
export async function replayPrivacyLedger(client: pg.PoolClient, entries: readonly PrivacyLedgerEntry[]): Promise<number> {
  for (const { record } of entries) {
    if (record.version === 1 && record.modules.some((m) => m !== 'privacy')) throw new Error('privacy replay adapter unavailable; restore must remain fenced');
  }
  for (const { record, digest: hash } of entries) {
    if (record.version === 2) {
      await client.query('SELECT trustwork.sources_replay_privacy_erasure($1::jsonb,$2)', [JSON.stringify(record), hash]);
      continue;
    }
    await client.query('SELECT trustwork.privacy_lock_subject($1, $2::uuid)', [record.subject.kind, record.subject.id]);
    const held = await client.query('SELECT id FROM trustwork.legal_hold WHERE subject_kind=$1 AND subject_id=$2 AND released_at IS NULL', [record.subject.kind, record.subject.id]);
    if (held.rowCount) throw new Error('privacy restore decision conflicts with a retained legal hold');
    const prior = await client.query<{ ledger_digest: string }>('SELECT ledger_digest FROM trustwork.privacy_replay_receipt WHERE request_id=$1', [record.requestId]);
    if (prior.rows[0] && prior.rows[0].ledger_digest !== hash) throw new Error('privacy replay receipt conflicts with ledger');
    await client.query(`UPDATE trustwork.privacy_request SET correction='{"redacted":true}'::jsonb WHERE subject_kind=$1 AND subject_id=$2 AND correction IS NOT NULL`, [record.subject.kind, record.subject.id]);
    await client.query('INSERT INTO trustwork.privacy_replay_receipt(request_id,subject_kind,subject_id,ledger_digest) VALUES($1,$2,$3,$4) ON CONFLICT(request_id) DO NOTHING',
      [record.requestId, record.subject.kind, record.subject.id, hash]);
    for (const target of ['retrieval', 'federation'] as const) {
      const id = randomUUID();
      const payload = PrivacyPropagationSchema.parse({ version: 1, id, requestId: record.requestId, target, subject: record.subject,
        digest: hash, modules: record.modules, operation: 'apply_retained_redaction' });
      await client.query(`INSERT INTO trustwork.privacy_propagation(id,request_id,target,decision_digest,payload) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(request_id,target) DO NOTHING`, [id, record.requestId, target, hash, JSON.stringify(payload)]);
      const stored = (await client.query<{ decision_digest: string }>('SELECT decision_digest FROM trustwork.privacy_propagation WHERE request_id=$1 AND target=$2', [record.requestId, target])).rows[0];
      if (stored?.decision_digest !== hash) throw new Error('privacy propagation conflicts with retained decision');
    }
    for (const key of [...record.suppressionDigests].sort()) {
      await client.query('SELECT trustwork.privacy_contact_lock($1)', [key]);
      await client.query(`INSERT INTO trustwork.privacy_suppression(digest,marketing,do_not_collect) VALUES($1,true,true)
        ON CONFLICT(digest) DO UPDATE SET marketing=true,do_not_collect=true`, [key]);
      // Includes the existing mail adapter's hash namespace when recorded by the owning decision.
      // Legacy opaque keys remain harmless suppression entries; no address or send is reconstructed.
      await client.query('SELECT trustwork.privacy_marketing_object($1)', [key]);
    }
  }
  return entries.length;
}
