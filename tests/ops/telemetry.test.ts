import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.js';
import { apiConfigFromEnv } from '../../apps/api/src/config.js';
import { createTelemetry, parseTraceparent, RecordingExporter } from '../../apps/api/src/observability/telemetry.js';
import { LogCapture } from './helpers.js';

const PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }
function fakeFetch(status = 200) {
  const calls: Captured[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, impl };
}

test('without an OTLP endpoint telemetry is a no-op: nothing is recorded or sent', async () => {
  const { calls, impl } = fakeFetch();
  const original = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { globalCalls += 1; return original(...args); }) as typeof fetch;
  try {
    const created = await createApp({ telemetryFetch: impl, logSink: () => undefined });
    assert.equal(created.telemetry.enabled, false);
    for (let i = 0; i < 3; i++) assert.equal((await created.fastify.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    await created.telemetry.flush();
    await created.close();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 0);
  assert.equal(globalCalls, 0, 'no network call at all');
  assert.equal(createTelemetry(apiConfigFromEnv({}).telemetry).startRequest(undefined), null, 'no ids generated without a parent');
});

test('with an endpoint, request spans continue the W3C parent and metrics are exported as OTLP/HTTP JSON', async () => {
  const { calls, impl } = fakeFetch();
  const logs = new LogCapture();
  const created = await createApp({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=planted-collector-secret', OTEL_SERVICE_NAME: 'trustwork-api-test' },
    telemetryFetch: impl, logSink: logs.sink,
  });
  try {
    assert.equal(created.telemetry.enabled, true);
    const response = await created.fastify.inject({ method: 'GET', url: '/v1/missing/route', headers: { traceparent: PARENT, 'x-request-id': 'ops-trace-1' } });
    assert.equal(response.statusCode, 404);
    await created.fastify.inject({ method: 'GET', url: '/health/live' });
    await created.telemetry.flush();
    const traces = calls.find((c) => c.url === 'http://collector.test:4318/v1/traces');
    const metrics = calls.find((c) => c.url === 'http://collector.test:4318/v1/metrics');
    assert.ok(traces && metrics, `exports: ${calls.map((c) => c.url).join(', ')}`);
    assert.equal(traces.headers['content-type'], 'application/json');
    assert.equal(traces.headers['x-collector-key'], 'planted-collector-secret');
    const resourceSpans = traces.body.resourceSpans as { resource: { attributes: { key: string; value: { stringValue: string } }[] }; scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    assert.deepEqual(resourceSpans[0]!.resource.attributes, [{ key: 'service.name', value: { stringValue: 'trustwork-api-test' } }]);
    const spans = resourceSpans[0]!.scopeSpans[0]!.spans;
    const span = spans.find((s) => (s.attributes as { key: string; value: { stringValue?: string } }[]).some((a) => a.key === 'trustwork.request_id' && a.value.stringValue === 'ops-trace-1'))!;
    assert.equal(span.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(span.parentSpanId, '00f067aa0ba902b7');
    assert.match(String(span.spanId), /^[0-9a-f]{16}$/);
    assert.equal(span.kind, 2);
    assert.ok(BigInt(String(span.endTimeUnixNano)) >= BigInt(String(span.startTimeUnixNano)));
    const keys = (span.attributes as { key: string }[]).map((a) => a.key).sort();
    assert.deepEqual(keys, ['http.request.method', 'http.response.status_code', 'http.route', 'trustwork.request_id'], 'no personal data in attributes');
    const metricList = ((metrics.body.resourceMetrics as { scopeMetrics: { metrics: { name: string; histogram?: { dataPoints: { count: string; bucketCounts: string[]; explicitBounds: number[] }[] } }[] }[] }[])[0]!.scopeMetrics[0]!.metrics);
    const duration = metricList.find((m) => m.name === 'http.server.request.duration')!;
    const total = duration.histogram!.dataPoints.reduce((n, p) => n + Number(p.count), 0);
    assert.equal(total, 2);
    for (const p of duration.histogram!.dataPoints) assert.equal(p.bucketCounts.length, p.explicitBounds.length + 1);
    // The request log line carries the same trace id for correlation; the collector header never reaches logs.
    const [line] = logs.forRequest('ops-trace-1');
    assert.equal(line!.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(line!.spanId, span.spanId);
    assert.ok(!logs.lines.join('\n').includes('planted-collector-secret'));
  } finally {
    await created.close();
  }
});

test('collector failures are logged as warnings and never fail requests; unsampled traces export no span', async () => {
  const { impl } = fakeFetch(503);
  const logs = new LogCapture();
  const created = await createApp({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test:4318', OTEL_TRACES_SAMPLER_ARG: '0' }, telemetryFetch: impl, logSink: logs.sink });
  try {
    assert.equal((await created.fastify.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    await created.telemetry.flush();
    const warnings = logs.records().filter((r) => r.event === 'telemetry.export_failed');
    assert.equal(warnings.length, 1, 'only the metrics export ran (no sampled spans)');
    assert.equal(warnings[0]!.level, 'warn');
  } finally {
    await created.close();
  }
});

test('traceparent parsing rejects malformed and all-zero ids', () => {
  assert.deepEqual(parseTraceparent(PARENT), { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', parentSpanId: '00f067aa0ba902b7', sampled: true });
  assert.equal(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null);
  assert.equal(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'), null);
  assert.equal(parseTraceparent('garbage'), null);
  assert.equal(parseTraceparent(undefined), null);
  const recorder = new RecordingExporter();
  const telemetry = createTelemetry({ ...apiConfigFromEnv({}).telemetry, traceSampleRatio: 1 }, { exporter: recorder });
  const ctx = telemetry.startRequest(undefined)!;
  assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
  assert.equal(ctx.sampled, true);
  void telemetry.shutdown();
});
