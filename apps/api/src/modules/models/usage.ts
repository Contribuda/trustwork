import { ModelCallMetadataSchema, ModelUsageAggregateSchema, type ModelCallMetadata, type ModelUsageAggregate } from '../../../../../packages/contracts/src/models.js';

/** Internal, access-controlled ledger rows only. Never expose this input shape in a dashboard endpoint. */
export interface PrivateUsageRow {
  principalId: string;
  participantType: string;
  plan: string;
  moduleKey: ModelUsageAggregate['moduleKey'];
  metadata: ModelCallMetadata;
}

/** Fixed grouping, no person filter. Threshold is distinct principals, never requests by one principal. */
export function aggregateModelUsage(rows: readonly PrivateUsageRow[]): ModelUsageAggregate[] {
  const groups = new Map<string, { dimensions: Omit<ModelUsageAggregate, 'calls' | 'participants' | 'costMinorUnits' | 'inputTokens' | 'outputTokens' | 'failures' | 'fallbacks' | 'latencyP50Ms' | 'latencyP95Ms'>; rows: PrivateUsageRow[] }>();
  const seen = new Set<string>();
  for (const row of rows) {
    const m = ModelCallMetadataSchema.parse(row.metadata);
    // The durable ledger supplies one final row per operation; reject duplicate rows rather than inflate usage.
    if (seen.has(m.operationId)) throw new Error('Duplicate operation in usage projection');
    seen.add(m.operationId);
    const dimensions = { routeId: m.routeId, routeVersion: m.routeVersion, connectionId: m.model.connectionId, modelId: m.model.modelId,
      modelRevision: m.model.modelRevision, stage: m.stage, participantType: row.participantType, plan: row.plan, moduleKey: row.moduleKey, currency: m.cost.currency };
    const key = JSON.stringify(dimensions);
    const group = groups.get(key) ?? { dimensions, rows: [] };
    group.rows.push({ ...row, metadata: m });
    groups.set(key, group);
  }
  const result: ModelUsageAggregate[] = [];
  for (const group of groups.values()) {
    const participants = new Set(group.rows.map((r) => r.principalId)).size;
    if (participants < 10) continue;
    const records = group.rows.map((r) => r.metadata);
    const latencies = records.map((m) => m.latencyMs).sort((a, b) => a - b);
    const percentile = (p: number) => latencies[Math.ceil(p * latencies.length) - 1]!;
    result.push(ModelUsageAggregateSchema.parse({ ...group.dimensions, participants, calls: records.length,
      costMinorUnits: records.reduce((sum, m) => sum + BigInt(m.cost.minorUnits), 0n).toString(),
      inputTokens: records.reduce((sum, m) => sum + m.inputTokens, 0), outputTokens: records.reduce((sum, m) => sum + m.outputTokens, 0),
      failures: records.filter((m) => m.outcome !== 'succeeded').length, fallbacks: records.filter((m) => m.fallbackUsed).length,
      latencyP50Ms: percentile(0.5), latencyP95Ms: percentile(0.95),
    }));
  }
  return result;
}
