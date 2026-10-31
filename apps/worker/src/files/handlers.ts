import { inbox, jobs, type DataPool } from '@trustwork/data';
import { FileErasureRequestSchema, FileEventPayloadSchema, FileScanJobSchema, FileDeleteJobSchema, FileTombstoneSchema, type FileErasureRequest } from '../../../../packages/contracts/src/files.js';
import { fileWorker } from '../../../../packages/data/src/repositories/files.js';
import type { FileQuarantineReason } from '../../../../packages/data/src/schema/files.js';
import { BlobNotFoundError, BlobStoreUnavailableError, BlobTooLargeError, type BlobStore, type TombstoneLedger } from '../../../../packages/data/src/files/index.js';
import { inTransaction } from '../db.js';
import { PermanentJobError, RetryableJobError, type HandlerRegistry, type JobContext } from '../handlers.js';
import { describeError, type Logger } from '../log.js';
import type { Metrics } from '../metrics.js';
import type { ScheduledTask } from '../scheduler.js';
import { inspect } from './inspect.js';
import { ScannerUnavailableError, type MalwareScanner } from './scanner.js';

/**
 * Files in the worker (FILE-001). The API records intents in the outbox in the transaction of the change
 * (`file.uploaded`, `file.copy_requested`, `file.deletion_requested`); the handlers below turn them into jobs:
 *
 * - `files.scan` (external): materialises a copy, reads the stored bytes (bounded by the declared size), checks size,
 *   SHA-256, type and location metadata, asks the malware scanner, and records `clean` or `quarantined` once. Every
 *   storage effect is idempotent (a copy of identical bytes to a fixed key), so an unreachable store or scanner is a
 *   retry, never an unknown outcome.
 * - `files.delete` (external): writes the tombstone to the ledger first, then removes the bytes, then the row (audited).
 *   A crash between the steps repeats them harmlessly; a restore replays the tombstone (`replayFileTombstones`).
 *
 * The worker reaches the database only through the owner-run `files_*` entry points (no table grant) and never logs
 * storage keys with personal meaning: keys are opaque digests.
 */
export const FILES_SCAN_KIND = 'files.scan';
export const FILES_DELETE_KIND = 'files.delete';
export const FILES_EXPIRE_TASK = 'files.expire_uploads';
export const FILES_SCAN_ATTEMPTS = 8;
export const FILES_DELETE_ATTEMPTS = 10;
export const FILES_METRICS = {
  scans: ['trustwork_files_scans_total', 'File scan verdicts by result (clean, quarantined reason, skipped, retried).'],
  deletions: ['trustwork_files_deletions_total', 'File deletions by mode (delete, erase) and result (deleted, skipped, held).'],
  expired: ['trustwork_files_uploads_discarded_total', 'Abandoned uploads discarded by the housekeeping task.'],
} as const;

export interface FilesRuntime {
  pool: DataPool;
  store: BlobStore;
  tombstones: TombstoneLedger;
  /**
   * Null when no engine is configured: the scan job kind is then not registered, so scan jobs wait queued and no file
   * becomes visible (fail closed) until an operator configures a scanner.
   */
  scanner: MalwareScanner | null;
  log: Logger;
  metrics: Metrics;
  /** Time source of tombstone records (tests). */
  now?: () => Date;
}

const ENQUEUE: Record<string, { kind: string; attempts: number }> = {
  'file.uploaded': { kind: FILES_SCAN_KIND, attempts: FILES_SCAN_ATTEMPTS },
  'file.copy_requested': { kind: FILES_SCAN_KIND, attempts: FILES_SCAN_ATTEMPTS },
  'file.deletion_requested': { kind: FILES_DELETE_KIND, attempts: FILES_DELETE_ATTEMPTS },
};

function storageFailure(error: unknown, what: string): never {
  if (error instanceof BlobStoreUnavailableError || error instanceof ScannerUnavailableError) throw new RetryableJobError(`${what}: ${error.message}`, { cause: error });
  throw error;
}

export function registerFiles(registry: HandlerRegistry, runtime: FilesRuntime): void {
  const { pool, store, tombstones, scanner, log, metrics } = runtime;
  const now = runtime.now ?? (() => new Date());

  for (const [type, target] of Object.entries(ENQUEUE)) {
    registry.onOutbox({
      name: `files.enqueue.${type.slice('file.'.length)}`,
      type,
      parse: (payload) => FileEventPayloadSchema.parse(payload),
      handle: async (event, context) => {
        if (event.aggregateKind !== 'evidence_artifact' || event.aggregateId !== event.payload.artifactId) throw new PermanentJobError(`malformed ${type} event ${event.id}`);
        // One job per artifact and intent, even when the same intent is appended twice.
        const { fresh } = await inbox.record(context.trx, { provider: 'outbox', account: type, event_id: event.payload.artifactId });
        if (!fresh) return;
        await context.enqueue({ kind: target.kind, payload: { artifactId: event.payload.artifactId }, maxAttempts: target.attempts });
      },
    });
  }

  if (scanner) registry.onJob({
    kind: FILES_SCAN_KIND,
    mode: 'external',
    parse: (payload) => FileScanJobSchema.parse(payload),
    run: async (context: JobContext<{ artifactId: string }>) => {
      const id = context.payload.artifactId;
      const target = await inTransaction(pool, (trx) => fileWorker.scanTarget(trx, id));
      if (!target || target.scan_state !== 'pending' || target.hidden || !target.upload_completed) {
        metrics.inc(...FILES_METRICS.scans, { result: 'skipped' });
        return;
      }
      const declared = Number(target.bytes);
      let verdict: { state: 'clean' } | { state: 'quarantined'; reason: FileQuarantineReason } = { state: 'clean' };
      try {
        if (target.copy_from_key) {
          try {
            await store.copy(target.copy_from_key, target.storage_key, context.signal);
          } catch (error) {
            if (!(error instanceof BlobNotFoundError)) throw error;
          }
        }
        let bytes: Uint8Array | null;
        try {
          bytes = await store.read(target.storage_key, declared, context.signal);
        } catch (error) {
          if (!(error instanceof BlobTooLargeError)) throw error;
          verdict = { state: 'quarantined', reason: 'size_mismatch' };
          bytes = null;
        }
        if (verdict.state === 'clean') {
          if (bytes === null) verdict = { state: 'quarantined', reason: 'missing_content' };
          else {
            const failure = inspect(bytes, { bytes: declared, sha256: target.sha256, mediaType: target.media_type, classification: target.classification });
            if (failure) verdict = { state: 'quarantined', reason: failure };
            else {
              const scan = await scanner.scan(bytes, target.media_type, context.signal);
              if (scan.verdict === 'infected') {
                verdict = { state: 'quarantined', reason: 'malware' };
                log('warn', 'file quarantined by the malware scanner', { artifactId: id, scanner: scanner.name, signature: scan.signature.slice(0, 100) });
              }
            }
          }
        }
      } catch (error) {
        metrics.inc(...FILES_METRICS.scans, { result: 'retried' });
        storageFailure(error, 'scan');
      }
      const recorded = await inTransaction(pool, (trx) => fileWorker.recordScan(trx, id, verdict));
      metrics.inc(...FILES_METRICS.scans, { result: recorded ? (verdict.state === 'clean' ? 'clean' : verdict.reason) : 'skipped' });
    },
  });

  registry.onJob({
    kind: FILES_DELETE_KIND,
    mode: 'external',
    parse: (payload) => FileDeleteJobSchema.parse(payload),
    run: async (context: JobContext<{ artifactId: string }>) => {
      const id = context.payload.artifactId;
      const target = await inTransaction(pool, (trx) => fileWorker.deletionTarget(trx, id));
      if (!target) {
        metrics.inc(...FILES_METRICS.deletions, { mode: 'unknown', result: 'skipped' });
        return;
      }
      if (target.legal_hold) {
        // Lawful preservation wins; the file stays hidden and an operator reconciles the request (dead letter).
        metrics.inc(...FILES_METRICS.deletions, { mode: target.deletion_mode, result: 'held' });
        throw new PermanentJobError('artifact under legal hold: deletion deferred to the privacy officer');
      }
      const tombstone = FileTombstoneSchema.parse({
        v: 1, artifactId: id, storageKey: target.storage_key, reason: target.deletion_mode === 'erase' ? 'erased' : 'deleted',
        privacyRequestId: target.privacy_request_id, recordedAt: now().toISOString(),
      });
      try {
        await tombstones.record(tombstone, context.signal);
        await store.delete(target.storage_key, context.signal);
      } catch (error) {
        storageFailure(error, 'delete');
      }
      await inTransaction(pool, (trx) => fileWorker.finishDeletion(trx, id));
      metrics.inc(...FILES_METRICS.deletions, { mode: target.deletion_mode, result: 'deleted' });
    },
  });
}

/** Housekeeping: uploads whose window passed more than an hour ago without a completion report lose bytes and row. */
export function filesExpireUploadsTask(runtime: Pick<FilesRuntime, 'pool' | 'store' | 'metrics'>, intervalSeconds = 900): ScheduledTask {
  return {
    name: FILES_EXPIRE_TASK,
    intervalSeconds,
    run: async () => {
      const due = await inTransaction(runtime.pool, (trx) => fileWorker.expiredUploads(trx, 200));
      let discarded = 0;
      for (const upload of due) {
        await runtime.store.delete(upload.storage_key);
        if (await inTransaction(runtime.pool, (trx) => fileWorker.discardUpload(trx, upload.artifact_id))) discarded += 1;
      }
      if (discarded > 0) runtime.metrics.inc(...FILES_METRICS.expired, {}, discarded);
      return { due: due.length, discarded };
    },
  };
}

export interface ErasureReport { queued: string[]; held: string[]; missing: string[] }

/**
 * Erasure entry point for privacy operations (two people, a privacy request): marks each artifact for erasure and
 * queues its deletion job in the same transaction. An artifact under legal hold is reported, never erased.
 */
export async function requestFileErasure(pool: DataPool, request: FileErasureRequest): Promise<ErasureReport> {
  const input = FileErasureRequestSchema.parse(request);
  const report: ErasureReport = { queued: [], held: [], missing: [] };
  for (const id of input.artifactIds) {
    try {
      const marked = await inTransaction(pool, async (trx) => {
        const ok = await fileWorker.requestErasure(trx, id, { privacyRequestId: input.privacyRequestId, executedBy: input.executedBy, secondApprover: input.secondApprover });
        if (ok) await jobs.enqueue(trx, { kind: FILES_DELETE_KIND, payload: { artifactId: id }, max_attempts: FILES_DELETE_ATTEMPTS });
        return ok;
      });
      (marked ? report.queued : report.missing).push(id);
    } catch (error) {
      if ((error as { hint?: string }).hint === 'files.legal_hold') report.held.push(id);
      else throw error;
    }
  }
  return report;
}

export interface ReplayReport { tombstones: number; rowsRemoved: number; invalid: string[]; held: string[] }

/**
 * Restore replay: applies every tombstone of the ledger to the database (rows a restore brought back are removed) and
 * removes the bytes again (an object-storage restore may have brought them back too). Run after every database restore
 * before the API serves files (`node apps/worker/src/files/cli.js replay-tombstones`). Idempotent.
 */
export async function replayFileTombstones(runtime: Pick<FilesRuntime, 'pool' | 'store' | 'tombstones' | 'log'>): Promise<ReplayReport> {
  const report: ReplayReport = { tombstones: 0, rowsRemoved: 0, invalid: [], held: [] };
  for (const entry of await runtime.tombstones.all()) {
    const parsed = FileTombstoneSchema.safeParse(entry.value);
    if (!parsed.success) {
      report.invalid.push(entry.key);
      continue;
    }
    report.tombstones += 1;
    try {
      report.rowsRemoved += await inTransaction(runtime.pool, (trx) => fileWorker.applyTombstone(trx, parsed.data.artifactId, parsed.data.storageKey));
    } catch (error) {
      if ((error as { hint?: string }).hint === 'kernel.legal_hold') {
        report.held.push(parsed.data.artifactId);
        runtime.log('warn', 'tombstone replay met a legal hold', { artifactId: parsed.data.artifactId });
        continue;
      }
      runtime.log('error', 'tombstone replay failed', { artifactId: parsed.data.artifactId, error: describeError(error) });
      throw error;
    }
    await runtime.store.delete(parsed.data.storageKey);
  }
  return report;
}
