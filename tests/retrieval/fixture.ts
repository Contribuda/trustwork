import { compatibleVector, type Citation, type EmbeddingConfig, type SourceRef, type TemporalMode, type VectorRecord } from '../../packages/contracts/src/retrieval.js';

// Tiny in-memory policy oracle, not production SQL, RLS, ANN, model inference or distributed fencing.
export const config: EmbeddingConfig = {
  id: 'fake-v1',
  schemaVersion: 1,
  hosting: 'self_hosted',
  providerId: 'fixture',
  providerPolicyId: 'policy-fixture',
  providerPolicyRevision: '1',
  modelId: 'predefined-fixture',
  modelRevision: '1',
  queryModelId: null,
  queryModelRevision: null,
  tokenizerId: 'none',
  tokenizerRevision: 'none',
  maxInputTokens: 16,
  truncation: 'error',
  pooling: 'provider_opaque',
  dimensions: 2,
  nativeDimensions: 2,
  dimensionReduction: 'none',
  metric: 'inner_product',
  normalization: 'none',
  precision: 'fp32',
  storageType: 'vector',
  inputContracts: { query: { prefix: '', instructionTemplate: null, instruction: null }, document: { prefix: '', instructionTemplate: null }, adapter: null },
  servingStack: null,
  weightsDigest: 'fixture',
  fingerprint: { probeSetId: 'probe-fixture', hash: 'fixture' },
  licenseSpdx: 'UNLICENSED',
  licenseTextHash: 'fixture',
  allowedDataClasses: ['public', 'person_private', 'company_private', 'project_restricted', 'deal_party_private'],
  allowedQueryDataClasses: ['public', 'person_private', 'company_private', 'project_restricted', 'deal_party_private'],
  costModel: null,
  status: 'proposed',
};
export type Row = { ref: SourceRef; text: string; allowed: Set<string>; vector: VectorRecord; citation: Citation; exactPrice: string };
export class Fixture {
  epoch = 1;
  rows = new Map<string, Row>();
  current = new Map<string, string>();
  tombstones = new Set<string>();
  publicAnnTainted = false;
  deliveries: string[] = [];
  constructor() {
    this.add('shared', 'v1', ['buyer', 'seller'], 'Поставка и монтаж стали ГОСТ 123', [1, 0], '10000');
    this.add('buyer-note', 'v1', ['buyer'], 'Private buyer budget', [1, 0], '0');
    this.add('seller-floor', 'v1', ['seller'], 'Private seller floor', [1, 0], '0');
    this.add('employer', 'v1', ['employee'], 'Employer-only project', [0, 1], '20000');
    this.add('public', 'v1', ['*'], 'Поставка стали / steel supply', [0.9, 0.1], '12000');
  }
  add(sourceId: string, versionId: string, principals: string[], text: string, values: number[], exactPrice: string) {
    const ref = { sourceId, versionId, projectionId: sourceId, contentHash: `${sourceId}-${versionId}-hash` };
    const row: Row = {
      ref,
      text,
      allowed: new Set(principals),
      vector: { configId: config.id, generationId: 'g1', inputKind: 'document', values },
      citation: { id: `${sourceId}:${versionId}`, source: ref, locator: { kind: 'table', extractionId: 'extract-1', page: 2, table: 'spec', row: '1', columns: ['price'] }, evidence: 'asserted' },
      exactPrice,
    };
    this.rows.set(`${sourceId}:${versionId}`, row);
    this.current.set(sourceId, versionId);
    return row;
  }
  allowed(ref: SourceRef, principal: string, temporal: TemporalMode = { kind: 'current' }): boolean {
    const row = this.rows.get(`${ref.sourceId}:${ref.versionId}`);
    return (
      !!row &&
      !this.tombstones.has(ref.sourceId) &&
      row.ref.contentHash === ref.contentHash &&
      row.ref.projectionId === ref.projectionId &&
      (row.allowed.has('*') || row.allowed.has(principal)) &&
      (temporal.kind === 'current' ? this.current.get(ref.sourceId) === ref.versionId : temporal.versionIds.includes(ref.versionId))
    );
  }
  revoke(sourceId: string, principal: string) {
    for (const row of this.rows.values()) if (row.ref.sourceId === sourceId) row.allowed.delete(principal);
    if (principal === '*') this.publicAnnTainted = true;
    this.epoch++;
  }
  erase(sourceId: string) {
    this.tombstones.add(sourceId);
    this.epoch++;
    this.publicAnnTainted = true;
  }
  candidates(principal: string, query = [1, 0]) {
    // Authorization precedes distance and ranking; unauthorized decoys cannot perturb this oracle.
    return [...this.rows.values()]
      .filter((r) => this.allowed(r.ref, principal) && compatibleVector(r.vector, config, 'g1'))
      .sort((a, b) => cosine(b.vector.values, query) - cosine(a.vector.values, query) || a.citation.id.localeCompare(b.citation.id));
  }
  hydrate(refs: SourceRef[], principal: string) {
    return refs.every((ref) => this.allowed(ref, principal)) ? refs.map((ref) => this.rows.get(`${ref.sourceId}:${ref.versionId}`)!) : null;
  }
  // Synchronous admission has no interleaving point. Distributed implementation still needs proof.
  admit(refs: SourceRef[], principal: string, expectedEpoch: number, target: string) {
    if (this.epoch !== expectedEpoch || !refs.every((ref) => this.allowed(ref, principal))) return false;
    this.deliveries.push(target);
    return true;
  }
  citation(candidate: Citation, principal: string, temporal: TemporalMode = { kind: 'current' }) {
    const actual = this.rows.get(candidate.id);
    return this.allowed(candidate.source, principal, temporal) && actual && JSON.stringify(actual.citation) === JSON.stringify(candidate) ? actual.citation : null;
  }
  readDerived(dependencies: SourceRef[], principal: string) {
    return dependencies.length > 0 && dependencies.every((ref) => this.allowed(ref, principal));
  }
  total(principal: string) {
    return [...this.rows.values()].filter((r) => this.allowed(r.ref, principal)).reduce((n, r) => n + BigInt(r.exactPrice), 0n);
  }
}
export function cosine(a: readonly number[], b: readonly number[]) {
  return a.reduce((n, x, i) => n + x * (b[i] ?? 0), 0) / (Math.hypot(...a) * Math.hypot(...b));
}
export function rrf(lists: readonly (readonly string[])[]) {
  const scores = new Map<string, number>();
  for (const list of lists) for (const [i, id] of [...new Set(list)].entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i + 1));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}
