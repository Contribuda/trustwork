import { jobs, maintenance } from '@trustwork/data';
import { workerConfigFromEnv } from './config.js';
import { assertWorkerRole, createWorkerPool, inTransaction } from './db.js';
import { describeError } from './log.js';
import { RECONCILE_OUTCOMES, reconcileJob, type ReconcileOutcome } from './reconcile.js';

const USAGE = `Usage (WORKER_DATABASE_URL must name a trustwork_worker login):
  npm run reconcile -w @trustwork/worker -- parked [limit]
  npm run reconcile -w @trustwork/worker -- reconcile <job-id> <succeeded|failed|queued> <reference> [--operator <label>]
  npm run reconcile -w @trustwork/worker -- schedule

reconcile resolves one outcome_unknown job with evidence and writes an audit row:
  succeeded  the provider lookup confirms the effect happened
  failed     confirmed no effect; the work must not run again (dead)
  queued     confirmed no effect; safe to run again with the same effect key`;

export interface CliIo { out(line: string): void; err(line: string): void }

/** Exit codes: 0 ok, 1 failure, 2 usage. */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || !['parked', 'reconcile', 'schedule'].includes(command)) {
    io.err(USAGE);
    return 2;
  }
  let parsed: { jobId: string; outcome: ReconcileOutcome; reference: string; operator: string | null } | null = null;
  if (command === 'reconcile') {
    const operatorAt = rest.indexOf('--operator');
    const operator = operatorAt >= 0 ? rest[operatorAt + 1] ?? null : null;
    const positional = operatorAt >= 0 ? rest.slice(0, operatorAt) : rest;
    const [jobId, outcome, reference] = positional;
    if (!jobId || !outcome || !reference || positional.length !== 3 || !RECONCILE_OUTCOMES.includes(outcome as ReconcileOutcome) || (operatorAt >= 0 && !operator)) {
      io.err(USAGE);
      return 2;
    }
    parsed = { jobId, outcome: outcome as ReconcileOutcome, reference, operator };
  }
  let config;
  try {
    config = workerConfigFromEnv(env);
  } catch (error) {
    io.err(describeError(error));
    return 2;
  }
  const pool = createWorkerPool(config.databaseUrl, 2);
  try {
    await assertWorkerRole(pool);
    if (command === 'parked') {
      const limit = rest[0] ? Number(rest[0]) : 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        io.err('limit must be an integer between 1 and 1000');
        return 2;
      }
      const parked = await inTransaction(pool, (trx) => jobs.listParked(trx, limit));
      for (const job of parked) io.out(JSON.stringify({ id: job.id, kind: job.kind, attempt: job.attempt, fencingToken: job.fencing_token, parkedAt: job.updated_at, reason: job.last_error }));
      return 0;
    }
    if (command === 'schedule') {
      const rows = await inTransaction(pool, (trx) => maintenance.listScheduledTasks(trx));
      for (const row of rows) io.out(JSON.stringify(row));
      return 0;
    }
    const input = parsed!;
    const job = await inTransaction(pool, (trx) => reconcileJob(trx, { ...input, mode: 'manual' }));
    io.out(JSON.stringify({ id: job.id, kind: job.kind, state: job.state, reference: input.reference }));
    return 0;
  } catch (error) {
    io.err(describeError(error));
    return 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  runCli(process.argv.slice(2), process.env, { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) }).then((code) => {
    process.exitCode = code;
  });
}
