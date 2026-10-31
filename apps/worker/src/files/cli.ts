import { blobStoreFromEnv } from '../../../../packages/data/src/files/index.js';
import { workerConfigFromEnv } from '../config.js';
import { assertWorkerRole, createWorkerPool } from '../db.js';
import { describeError, jsonLogger } from '../log.js';
import { replayFileTombstones, requestFileErasure } from './handlers.js';

const USAGE = `Usage (WORKER_DATABASE_URL names a trustwork_worker login; FILES_STORAGE and FILES_* configure storage):
  tsx apps/worker/src/files/cli.ts replay-tombstones
  tsx apps/worker/src/files/cli.ts erase <privacy-request-id> <executed-by-person-id> <second-approver-person-id> <artifact-id>...

replay-tombstones  after every database restore, before files are served: removes rows and bytes of deleted files
erase              privacy operations: marks the artifacts for erasure (two different people) and queues the worker;
                   an artifact under legal hold is reported, never erased`;

export interface FilesCliIo { out(line: string): void; err(line: string): void }

/** Exit codes: 0 ok, 1 failure, 2 usage. */
export async function runFilesCli(argv: string[], env: NodeJS.ProcessEnv, io: FilesCliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'replay-tombstones' && command !== 'erase') {
    io.err(USAGE);
    return 2;
  }
  if (command === 'erase' && rest.length < 4) {
    io.err(USAGE);
    return 2;
  }
  let pool;
  try {
    const { databaseUrl } = workerConfigFromEnv(env);
    const storage = blobStoreFromEnv(env);
    if (!storage) throw new Error('FILES_STORAGE is not configured');
    pool = createWorkerPool(databaseUrl, 2);
    await assertWorkerRole(pool);
    if (command === 'replay-tombstones') {
      const report = await replayFileTombstones({ pool, store: storage.store, tombstones: storage.tombstones, log: jsonLogger() });
      io.out(JSON.stringify(report));
      return report.invalid.length > 0 || report.held.length > 0 ? 1 : 0;
    }
    const [privacyRequestId, executedBy, secondApprover, ...artifactIds] = rest as [string, string, string, ...string[]];
    const report = await requestFileErasure(pool, { privacyRequestId, executedBy, secondApprover, artifactIds });
    io.out(JSON.stringify(report));
    return report.held.length > 0 ? 1 : 0;
  } catch (error) {
    io.err(JSON.stringify({ error: describeError(error) }));
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  runFilesCli(process.argv.slice(2), process.env, { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) }).then((code) => {
    process.exitCode = code;
  });
}
