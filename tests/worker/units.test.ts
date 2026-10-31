import test from 'node:test';
import assert from 'node:assert/strict';
import { RetryPolicySchema } from '@trustwork/contracts';
import { DEFAULT_RETRY, HandlerRegistry, Metrics, retryDelaySeconds, runCli, workerConfigFromEnv, type RetryPolicy } from '@trustwork/worker';

test('worker configuration comes from explicit environment values and is validated', () => {
  assert.throws(() => workerConfigFromEnv({}), /WORKER_DATABASE_URL is required/);
  const { databaseUrl, config } = workerConfigFromEnv({ WORKER_DATABASE_URL: 'postgresql://w@127.0.0.1/db', WORKER_ID: 'worker-1', WORKER_CONCURRENCY: '8', WORKER_LEASE_SECONDS: '90', WORKER_METRICS_PORT: '9464' });
  assert.equal(databaseUrl, 'postgresql://w@127.0.0.1/db');
  assert.deepEqual([config.workerId, config.concurrency, config.leaseSeconds, config.heartbeatMs, config.metrics.host, config.metrics.port], ['worker-1', 8, 90, 30_000, '127.0.0.1', 9464]);
  assert.equal(workerConfigFromEnv({ WORKER_DATABASE_URL: 'x' }).config.metrics.port, null, 'metrics are off unless a port is set');
  for (const [key, value] of [['WORKER_CONCURRENCY', '0'], ['WORKER_LEASE_SECONDS', '2'], ['WORKER_POLL_MS', 'fast'], ['WORKER_METRICS_PORT', '70000'], ['WORKER_ID', 'bad id with spaces']] as const) {
    assert.throws(() => workerConfigFromEnv({ WORKER_DATABASE_URL: 'x', [key]: value }), new RegExp(key), `${key}=${value}`);
  }
  assert.deepEqual(RetryPolicySchema.parse(DEFAULT_RETRY), DEFAULT_RETRY, 'the default retry policy satisfies the contract');
});

test('backoff: fixed or exponential from the contract retry policy, capped, with bounded jitter', () => {
  const exp: RetryPolicy = { maxAttempts: 5, backoff: 'exponential', baseSeconds: 5, maxDelaySeconds: 60, retryOn: ['timeout'] };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => retryDelaySeconds(exp, n)), [5, 10, 20, 40, 60, 60]);
  assert.deepEqual([1, 4].map((n) => retryDelaySeconds({ ...exp, backoff: 'fixed' as const }, n)), [5, 5]);
  assert.equal(retryDelaySeconds(exp, 1, 0.5, () => 1), 7.5);
  assert.equal(retryDelaySeconds(exp, 9, 0.5, () => 1), 60, 'jitter never exceeds the cap');
  assert.equal(retryDelaySeconds(exp, 1_000), 60, 'large attempt numbers do not overflow');
});

test('metrics render the Prometheus text format with escaped labels and typed families', () => {
  const metrics = new Metrics();
  metrics.inc('trustwork_worker_jobs_total', 'Jobs.', { kind: 'mail.send', result: 'succeeded' });
  metrics.inc('trustwork_worker_jobs_total', 'Jobs.', { result: 'succeeded', kind: 'mail.send' }, 2);
  metrics.set('trustwork_job_queue_depth', 'Depth.', 3, { kind: 'a"b\\c\nd', state: 'queued' });
  const text = metrics.render();
  assert.match(text, /^# TYPE trustwork_worker_jobs_total counter$/m);
  assert.match(text, /^trustwork_worker_jobs_total\{kind="mail.send",result="succeeded"\} 3$/m, 'label order does not split series');
  assert.ok(text.includes('trustwork_job_queue_depth{kind="a\\"b\\\\c\\nd",state="queued"} 3'));
  assert.throws(() => metrics.set('trustwork_worker_jobs_total', 'x', 1), /is a counter/);
  assert.throws(() => metrics.inc('bad-name', 'x'), /invalid metric name/);
});

test('handler registry: names are validated and unique; several outbox handlers per event type', () => {
  const registry = new HandlerRegistry()
    .onOutbox({ name: 'a.one', type: 'project.created', handle: async () => {} })
    .onOutbox({ name: 'a.two', type: 'project.created', handle: async () => {} })
    .onJob({ kind: 'mail.send', mode: 'external', run: async () => {} })
    .onJob({ kind: 'search.index', mode: 'transactional', run: async () => {} });
  assert.deepEqual(registry.outboxHandlersFor('project.created').map((h) => h.name), ['a.one', 'a.two']);
  assert.deepEqual(registry.outboxHandlersFor('unknown'), []);
  assert.deepEqual(registry.jobKinds(), ['mail.send', 'search.index']);
  assert.deepEqual([registry.isTransactional('search.index'), registry.isTransactional('mail.send'), registry.isTransactional('missing')], [true, false, false]);
  assert.throws(() => registry.onOutbox({ name: 'a.one', type: 'x', handle: async () => {} }), /already registered/);
  assert.throws(() => registry.onJob({ kind: 'mail.send', mode: 'transactional', run: async () => {} }), /already registered/);
  assert.throws(() => registry.onJob({ kind: 'Bad Kind', mode: 'external', run: async () => {} }), /invalid job kind/);
});

test('reconciliation CLI: usage errors exit 2 before any connection', async () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv = { WORKER_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/none' }) => {
    const err: string[] = [];
    const code = await runCli(argv, env, { out: () => {}, err: (l) => err.push(l) });
    return { code, err: err.join('\n') };
  };
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['drop-everything'])).code, 2);
  assert.equal((await run(['reconcile', 'id-only'])).code, 2);
  assert.equal((await run(['reconcile', '11111111-1111-4111-8111-111111111111', 'replay', 'ref'])).code, 2, 'only succeeded, failed or queued');
  assert.equal((await run(['reconcile', '11111111-1111-4111-8111-111111111111', 'queued', 'ref', '--operator'])).code, 2);
  const missing = await run(['parked'], {});
  assert.deepEqual([missing.code, /WORKER_DATABASE_URL/.test(missing.err)], [2, true]);
});
