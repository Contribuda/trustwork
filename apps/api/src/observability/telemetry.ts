import { randomBytes } from 'node:crypto';
import type { ApiConfig } from '../config.js';

/**
 * OpenTelemetry-compatible traces and metrics without a vendor SDK: request spans and a small metric set are
 * encoded as OTLP/HTTP JSON (`/v1/traces`, `/v1/metrics`) and sent to the configured collector through the
 * `TelemetryExporter` port. Without `OTEL_EXPORTER_OTLP_ENDPOINT` telemetry is a no-op: no ids are generated,
 * nothing is buffered, no timer runs and nothing leaves the process. Attributes never carry personal or private
 * data: method, route pattern, status code, request id and service name only.
 */
export type AttributeValue = string | number | boolean;
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** OTLP SpanKind: 2 = SERVER. */
  kind: 2;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, AttributeValue>;
  error: boolean;
}
export interface HistogramPoint { attributes: Record<string, AttributeValue>; count: number; sum: number; min: number; max: number; bucketCounts: number[] }
export interface GaugePoint { attributes: Record<string, AttributeValue>; value: number }
export interface MetricsSnapshot {
  startTimeUnixNano: bigint;
  timeUnixNano: bigint;
  histograms: { name: string; unit: string; description: string; bounds: number[]; points: HistogramPoint[] }[];
  gauges: { name: string; unit: string; description: string; points: GaugePoint[] }[];
}
/** Port to the collector; the OTLP adapter is the only implementation that leaves the process, the recording fake is for tests. */
export interface TelemetryExporter {
  exportSpans(spans: SpanRecord[]): Promise<void>;
  exportMetrics(snapshot: MetricsSnapshot): Promise<void>;
}

export interface TraceContext { traceId: string; spanId: string; parentSpanId: string | null; sampled: boolean }
export interface RequestOutcome { method: string; route: string; status: number; requestId: string }
export interface Telemetry {
  readonly enabled: boolean;
  /** Starts a server span; continues a valid incoming W3C `traceparent`. Returns null when telemetry is off and no parent exists. */
  startRequest(traceparent: string | string[] | undefined): TraceContext | null;
  /** `startedHr` is `process.hrtime.bigint()` taken when the request arrived. */
  endRequest(context: TraceContext | null, startedHr: bigint, outcome: RequestOutcome): void;
  /** Registers an observable gauge read at each export (for example pool connections). */
  observeGauge(name: string, unit: string, description: string, read: () => GaugePoint[]): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
export function parseTraceparent(header: string | string[] | undefined): { traceId: string; parentSpanId: string; sampled: boolean } | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? TRACEPARENT.exec(value.trim().toLowerCase()) : null;
  if (!match) return null;
  const [, traceId, parentSpanId, flags] = match as unknown as [string, string, string, string];
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
  return { traceId, parentSpanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** OpenTelemetry semantic-convention buckets for `http.server.request.duration` (seconds). */
export const DURATION_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const MAX_QUEUED_SPANS = 2_048;
const BATCH = 512;
const SPAN_FLUSH_MS = 5_000;

/** Wall-clock nanoseconds for OTLP timestamps (durations come from the monotonic clock). */
const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

class NoopTelemetry implements Telemetry {
  readonly enabled = false;
  startRequest(traceparent: string | string[] | undefined): TraceContext | null {
    // Log correlation with an upstream trace still works; no span is recorded or exported.
    const parent = parseTraceparent(traceparent);
    return parent ? { traceId: parent.traceId, spanId: parent.parentSpanId, parentSpanId: null, sampled: false } : null;
  }
  endRequest(): void {}
  observeGauge(): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

interface HistogramState { attributes: Record<string, AttributeValue>; count: number; sum: number; min: number; max: number; bucketCounts: number[] }

class ExportingTelemetry implements Telemetry {
  readonly enabled = true;
  private readonly started = nowNs();
  private queue: SpanRecord[] = [];
  private dropped = 0;
  private readonly histogram = new Map<string, HistogramState>();
  private readonly gauges: { name: string; unit: string; description: string; read: () => GaugePoint[] }[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private inflight: Promise<void> = Promise.resolve();

  constructor(private readonly exporter: TelemetryExporter, private readonly sampleRatio: number, metricIntervalMs: number, private readonly onError: (error: unknown) => void, private readonly random: () => number = Math.random) {
    this.timers.push(setInterval(() => void this.flushSpans(), SPAN_FLUSH_MS).unref());
    this.timers.push(setInterval(() => void this.flushMetrics(), metricIntervalMs).unref());
  }

  startRequest(traceparent: string | string[] | undefined): TraceContext {
    const parent = parseTraceparent(traceparent);
    const spanId = randomBytes(8).toString('hex');
    if (parent) return { traceId: parent.traceId, spanId, parentSpanId: parent.parentSpanId, sampled: parent.sampled };
    return { traceId: randomBytes(16).toString('hex'), spanId, parentSpanId: null, sampled: this.random() < this.sampleRatio };
  }

  endRequest(context: TraceContext | null, startedHr: bigint, outcome: RequestOutcome): void {
    const durationNs = process.hrtime.bigint() - startedHr;
    const endedAt = nowNs();
    const startedAt = endedAt - durationNs;
    const seconds = Number(durationNs) / 1e9;
    const attributes = { 'http.request.method': outcome.method, 'http.route': outcome.route, 'http.response.status_code': outcome.status };
    const key = `${outcome.method} ${outcome.route} ${outcome.status}`;
    let state = this.histogram.get(key);
    if (!state) {
      if (this.histogram.size >= 2_000) return; // bounded cardinality: route patterns only, but never unbounded memory
      state = { attributes, count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0, bucketCounts: new Array(DURATION_BOUNDS.length + 1).fill(0) };
      this.histogram.set(key, state);
    }
    state.count += 1;
    state.sum += seconds;
    state.min = Math.min(state.min, seconds);
    state.max = Math.max(state.max, seconds);
    const bucket = DURATION_BOUNDS.findIndex((bound) => seconds <= bound);
    state.bucketCounts[bucket === -1 ? DURATION_BOUNDS.length : bucket]! += 1;
    if (!context?.sampled) return;
    if (this.queue.length >= MAX_QUEUED_SPANS) {
      this.dropped += 1;
      return;
    }
    this.queue.push({
      traceId: context.traceId, spanId: context.spanId, parentSpanId: context.parentSpanId,
      name: `${outcome.method} ${outcome.route}`, kind: 2, startTimeUnixNano: startedAt, endTimeUnixNano: endedAt,
      attributes: { ...attributes, 'trustwork.request_id': outcome.requestId }, error: outcome.status >= 500,
    });
    if (this.queue.length >= BATCH) void this.flushSpans();
  }

  observeGauge(name: string, unit: string, description: string, read: () => GaugePoint[]): void {
    this.gauges.push({ name, unit, description, read });
  }

  private serial(task: () => Promise<void>): Promise<void> {
    this.inflight = this.inflight.then(task).catch((error: unknown) => this.onError(error));
    return this.inflight;
  }

  private flushSpans(): Promise<void> {
    return this.serial(async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, BATCH);
        await this.exporter.exportSpans(batch);
      }
      if (this.dropped) {
        const dropped = this.dropped;
        this.dropped = 0;
        this.onError(new Error(`telemetry span queue full: ${dropped} spans dropped`));
      }
    });
  }

  snapshot(): MetricsSnapshot {
    const points = [...this.histogram.values()].map((s) => ({ ...s, bucketCounts: [...s.bucketCounts], min: Number.isFinite(s.min) ? s.min : 0 }));
    const gauges = this.gauges.map((g) => {
      let read: GaugePoint[] = [];
      try {
        read = g.read();
      } catch (error) {
        this.onError(error);
      }
      return { name: g.name, unit: g.unit, description: g.description, points: read };
    });
    return {
      startTimeUnixNano: this.started, timeUnixNano: nowNs(),
      histograms: [{ name: 'http.server.request.duration', unit: 's', description: 'Duration of HTTP server requests.', bounds: DURATION_BOUNDS, points }],
      gauges,
    };
  }

  private flushMetrics(): Promise<void> {
    return this.serial(() => this.exporter.exportMetrics(this.snapshot()));
  }

  async flush(): Promise<void> {
    await this.flushSpans();
    await this.flushMetrics();
  }

  async shutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    await this.flush();
  }
}

export interface TelemetryOptions {
  /** Overrides the OTLP adapter (tests pass the recording fake). */
  exporter?: TelemetryExporter;
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
  random?: () => number;
}

/** No-op unless an endpoint is configured or an exporter is injected. */
export function createTelemetry(config: ApiConfig['telemetry'], options: TelemetryOptions = {}): Telemetry {
  const onError = options.onError ?? (() => undefined);
  const exporter = options.exporter ?? (config.endpoint ? new OtlpHttpJsonExporter(config, options.fetch ?? globalThis.fetch) : null);
  if (!exporter) return new NoopTelemetry();
  return new ExportingTelemetry(exporter, config.traceSampleRatio, config.exportIntervalMs, onError, options.random);
}

// ---------------------------------------------------------------- OTLP/HTTP JSON encoding

type OtlpAnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
function anyValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}
const attributes = (record: Record<string, AttributeValue>) => Object.entries(record).map(([key, value]) => ({ key, value: anyValue(value) }));

export function encodeSpans(serviceName: string, spans: SpanRecord[]): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: attributes({ 'service.name': serviceName }) },
      scopeSpans: [{
        scope: { name: 'trustwork-api' },
        spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name, kind: s.kind,
          startTimeUnixNano: s.startTimeUnixNano.toString(), endTimeUnixNano: s.endTimeUnixNano.toString(),
          attributes: attributes(s.attributes),
          // STATUS_CODE_ERROR = 2 for server errors; 4xx stays unset on server spans (semantic conventions).
          status: s.error ? { code: 2 } : { code: 0 },
        })),
      }],
    }],
  };
}

export function encodeMetrics(serviceName: string, snapshot: MetricsSnapshot): unknown {
  const start = snapshot.startTimeUnixNano.toString();
  const time = snapshot.timeUnixNano.toString();
  return {
    resourceMetrics: [{
      resource: { attributes: attributes({ 'service.name': serviceName }) },
      scopeMetrics: [{
        scope: { name: 'trustwork-api' },
        metrics: [
          ...snapshot.histograms.map((h) => ({
            name: h.name, unit: h.unit, description: h.description,
            histogram: {
              aggregationTemporality: 2, // CUMULATIVE
              dataPoints: h.points.map((p) => ({
                attributes: attributes(p.attributes), startTimeUnixNano: start, timeUnixNano: time,
                count: String(p.count), sum: p.sum, min: p.min, max: p.max,
                bucketCounts: p.bucketCounts.map(String), explicitBounds: h.bounds,
              })),
            },
          })),
          ...snapshot.gauges.map((g) => ({
            name: g.name, unit: g.unit, description: g.description,
            gauge: { dataPoints: g.points.map((p) => ({ attributes: attributes(p.attributes), timeUnixNano: time, asInt: String(Math.trunc(p.value)) })) },
          })),
        ],
      }],
    }],
  };
}

/** OTLP/HTTP with JSON bodies (`application/json`), bounded by a request timeout; failures are reported, never thrown into requests. */
export class OtlpHttpJsonExporter implements TelemetryExporter {
  constructor(private readonly config: ApiConfig['telemetry'], private readonly fetchImpl: typeof fetch, private readonly timeoutMs = 10_000) {}

  private async post(path: '/v1/traces' | '/v1/metrics', body: unknown): Promise<void> {
    if (!this.config.endpoint) return;
    const response = await this.fetchImpl(`${this.config.endpoint}${path}`, {
      method: 'POST',
      headers: { ...this.config.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`OTLP export to ${path} answered ${response.status}`);
  }

  exportSpans(spans: SpanRecord[]): Promise<void> {
    return spans.length ? this.post('/v1/traces', encodeSpans(this.config.serviceName, spans)) : Promise.resolve();
  }

  exportMetrics(snapshot: MetricsSnapshot): Promise<void> {
    return this.post('/v1/metrics', encodeMetrics(this.config.serviceName, snapshot));
  }
}

/** Test fake: keeps every export in memory. */
export class RecordingExporter implements TelemetryExporter {
  readonly spans: SpanRecord[] = [];
  readonly metrics: MetricsSnapshot[] = [];
  async exportSpans(spans: SpanRecord[]): Promise<void> {
    this.spans.push(...spans);
  }
  async exportMetrics(snapshot: MetricsSnapshot): Promise<void> {
    this.metrics.push(snapshot);
  }
}

