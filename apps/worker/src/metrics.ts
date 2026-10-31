import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jobs, outbox, type DataPool } from '@trustwork/data';
import { inTransaction } from './db.js';

type Labels = Readonly<Record<string, string>>;
type Kind = 'counter' | 'gauge';

interface Family { kind: Kind; help: string; samples: Map<string, { labels: Labels; value: number }> }

const METRIC_NAME = /^[a-z_][a-z0-9_]*$/;
const escapeLabel = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const keyOf = (labels: Labels): string => Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(',');

/**
 * Minimal Prometheus registry (text exposition format 0.0.4), no dependency. Counters live in the process; gauges of
 * the queue are read from the database at each scrape (`collectQueueGauges`), so every worker replica reports the same
 * backlog while counters add up across replicas.
 */
export class Metrics {
  private readonly families = new Map<string, Family>();

  private family(name: string, kind: Kind, help: string): Family {
    if (!METRIC_NAME.test(name)) throw new Error(`invalid metric name ${name}`);
    let family = this.families.get(name);
    if (!family) {
      family = { kind, help, samples: new Map() };
      this.families.set(name, family);
    } else if (family.kind !== kind) throw new Error(`metric ${name} is a ${family.kind}`);
    return family;
  }

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    const family = this.family(name, 'counter', help);
    const key = keyOf(labels);
    const sample = family.samples.get(key) ?? { labels, value: 0 };
    sample.value += by;
    family.samples.set(key, sample);
  }

  set(name: string, help: string, value: number, labels: Labels = {}): void {
    this.family(name, 'gauge', help).samples.set(keyOf(labels), { labels, value });
  }

  /** Drops all samples of a gauge (before a fresh database read, so vanished label sets disappear). */
  resetGauge(name: string, help: string): void {
    this.family(name, 'gauge', help).samples.clear();
  }

  value(name: string, labels: Labels = {}): number | undefined {
    return this.families.get(name)?.samples.get(keyOf(labels))?.value;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, family] of [...this.families].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${family.help}`, `# TYPE ${name} ${family.kind}`);
      for (const { labels, value } of family.samples.values()) {
        const rendered = Object.keys(labels).sort().map((k) => `${k}="${escapeLabel(labels[k] ?? '')}"`).join(',');
        lines.push(`${name}${rendered ? `{${rendered}}` : ''} ${Number.isFinite(value) ? value : 0}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Metric names and help texts used by the worker (one place, so dashboards and tests agree). */
export const M = {
  outboxUnpublished: ['trustwork_outbox_unpublished_events', 'Outbox events not yet published by the relay.'],
  outboxOldestAge: ['trustwork_outbox_oldest_unpublished_age_seconds', 'Age of the oldest unpublished outbox event (database clock); 0 when none.'],
  jobQueueDepth: ['trustwork_job_queue_depth', 'Jobs per kind and state (queued, leased, outcome_unknown, dead).'],
  jobReady: ['trustwork_job_ready', 'Queued jobs that are due now (database clock).'],
  jobOutcomeUnknown: ['trustwork_job_outcome_unknown', 'Jobs parked as outcome_unknown awaiting reconciliation.'],
  jobLeaseExpiredParked: ['trustwork_job_lease_expired_parked', 'outcome_unknown jobs that were parked by lease expiry.'],
  leaseExpirations: ['trustwork_worker_lease_expirations_total', 'Expired job leases parked by this worker.'],
  unknownOutcomes: ['trustwork_worker_unknown_outcomes_total', 'Jobs this worker moved to outcome_unknown, by reason.'],
  jobs: ['trustwork_worker_jobs_total', 'Job executions finished by this worker, by kind and result.'],
  outboxEvents: ['trustwork_worker_outbox_events_total', 'Outbox events relayed by this worker, by result.'],
  scheduleRuns: ['trustwork_worker_schedule_runs_total', 'Scheduled maintenance runs, by task and outcome.'],
  reconciliations: ['trustwork_worker_reconciliations_total', 'Job reconciliations, by mode (auto, manual) and outcome.'],
  partitionsCreated: ['trustwork_worker_partitions_created_total', 'Monthly partitions created by this worker.'],
  sweptRows: ['trustwork_worker_swept_rows_total', 'Rows removed by the scheduled sweep, by table.'],
  loopErrors: ['trustwork_worker_loop_errors_total', 'Errors caught by the worker loop (relay, lease, schedule).'],
} as const satisfies Record<string, readonly [string, string]>;

/** Reads the queue gauges from the database (outbox backlog and age, jobs per kind and state, unknown outcomes). */
export async function collectQueueGauges(pool: DataPool, metrics: Metrics): Promise<void> {
  const [backlog, rows] = await inTransaction(pool, async (trx) => [await outbox.stats(trx), await jobs.stats(trx)] as const);
  metrics.set(...M.outboxUnpublished, backlog.unpublished);
  metrics.set(...M.outboxOldestAge, backlog.oldestAgeSeconds);
  for (const [name, help] of [M.jobQueueDepth, M.jobReady, M.jobOutcomeUnknown, M.jobLeaseExpiredParked]) metrics.resetGauge(name, help);
  let unknown = 0;
  for (const row of rows) {
    metrics.set(...M.jobQueueDepth, row.count, { kind: row.kind, state: row.state });
    if (row.state === 'queued') metrics.set(...M.jobReady, row.ready, { kind: row.kind });
    if (row.state === 'outcome_unknown') {
      unknown += row.count;
      metrics.set(...M.jobOutcomeUnknown, row.count, { kind: row.kind });
      metrics.set(...M.jobLeaseExpiredParked, row.lease_expired, { kind: row.kind });
    }
  }
  metrics.set(...M.jobOutcomeUnknown, unknown, { kind: '_all' });
}

export interface MetricsServer { port: number; close(): Promise<void> }

/** GET /metrics (Prometheus text) and GET /health/live on a loopback address by default. */
export async function startMetricsServer(host: string, port: number, render: () => Promise<string>): Promise<MetricsServer> {
  const server: Server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok\n');
      return;
    }
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    render().then(
      (body) => response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(body),
      () => response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('metrics unavailable\n'),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
