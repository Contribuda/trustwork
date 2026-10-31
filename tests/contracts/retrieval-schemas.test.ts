import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../packages/contracts/src/retrieval.js';
import { config } from '../retrieval/fixture.js';

const at = '2026-10-27T10:00:00Z';
const approved: r.EmbeddingConfig = {
  ...config,
  id: 'emb-cfg-bge-m3-v1',
  providerId: 'local-tei',
  modelId: 'BAAI/bge-m3',
  modelRevision: '5617a9f61b028005a4858fdac845db406aefb181',
  tokenizerId: 'BAAI/bge-m3',
  tokenizerRevision: '0000000000000000000000000000000000000001',
  maxInputTokens: 8192,
  pooling: 'cls',
  dimensions: 1024,
  nativeDimensions: 1024,
  metric: 'cosine',
  normalization: 'unit',
  precision: 'fp16',
  servingStack: 'text-embeddings-inference:1.7.2',
  weightsDigest: 'sha256:fixture',
  licenseSpdx: 'MIT',
  status: 'approved',
};

test('embedding config is validated with its invariants', () => {
  assert.ok(r.EmbeddingConfigSchema.safeParse(config).success, 'fixture config');
  assert.ok(r.EmbeddingConfigSchema.safeParse(approved).success);
  assert.equal(r.EmbeddingConfigSchema.safeParse({ ...approved, normalization: 'none' }).success, false, 'cosine needs unit norm');
  assert.equal(r.EmbeddingConfigSchema.safeParse({ ...approved, dimensions: 2048 }).success, false, 'dimensions above native');
  assert.equal(r.EmbeddingConfigSchema.safeParse({ ...approved, dimensionReduction: 'matryoshka_truncate' }).success, false, 'equal widths require none');
  assert.equal(r.EmbeddingConfigSchema.safeParse({ ...approved, weightsDigest: null }).success, false, 'self-hosted needs weights digest');
  assert.equal(r.EmbeddingConfigSchema.safeParse({ ...config, status: 'approved' }).success, false, 'fixture provider cannot be approved');
  assert.equal(r.EmbeddingConfigSchema.safeParse({ ...approved, queryPrefix: 'query: ' }).success, false, 'legacy field name rejected');
  assert.equal(r.EmbeddingConfigSchema.safeParse({ ...approved, metric: 'dot' }).success, false);
  assert.ok(r.annEligible(approved));
  assert.equal(r.annEligible({ dimensions: 3072, storageType: 'vector' }), false);
  assert.ok(r.annEligible({ dimensions: 3072, storageType: 'halfvec' }));
});
test('vector records carry input kind; query vectors are never chunk embeddings', () => {
  assert.ok(r.VectorRecordSchema.safeParse({ configId: 'c', generationId: 'g', inputKind: 'document', values: [0.1, 0.2] }).success);
  assert.equal(r.VectorRecordSchema.safeParse({ configId: 'c', generationId: 'g', values: [0.1] }).success, false);
  assert.equal(r.VectorRecordSchema.safeParse({ configId: 'c', generationId: 'g', inputKind: 'chunk', values: [0.1] }).success, false);
  assert.equal(r.compatibleVector({ configId: 'c', generationId: 'g', values: [] }, { id: 'c', dimensions: 0, normalization: 'none' }, 'g'), false);
});
test('index generation lifecycle: building -> validated -> active -> draining -> retired, plus tainted', () => {
  const generation = {
    generationId: 'gen-1',
    configId: approved.id,
    scope: { cohort: 'public', cohortDescriptor: 'public-all' },
    projectionFieldSetRevision: '1',
    chunkerRevision: '1',
    extractorRevision: '1',
    lexicalDictionaryRevision: '1',
    schemaRevision: '1',
    annEligible: true,
    indexSpec: { type: 'hnsw', m: 16, efConstruction: 64, opclass: 'vector_cosine_ops' },
    buildWatermark: { canonicalRevision: 'r1', policyEpoch: 5, erasureSequence: 2 },
    activationWatermark: null,
    fingerprintHashAtBuild: 'fp',
    fingerprintHashAtActivation: null,
    manifestHash: 'm',
    status: 'validated',
    taintReason: null,
    rollbackWindowUntil: null,
    createdAt: at,
    validatedAt: at,
    activatedAt: null,
    drainingAt: null,
    retiredAt: null,
  };
  assert.ok(r.IndexGenerationSchema.safeParse(generation).success);
  assert.equal(r.IndexGenerationSchema.safeParse({ ...generation, status: 'active' }).success, false, 'active without activation watermark');
  assert.equal(r.IndexGenerationSchema.safeParse({ ...generation, status: 'tainted' }).success, false, 'tainted without reason');
  assert.ok(r.IndexGenerationSchema.safeParse({ ...generation, status: 'tainted', taintReason: 'public_to_private' }).success);
  assert.ok(r.generationTransitionAllowed('building', 'validated'));
  assert.equal(r.generationTransitionAllowed('building', 'active'), false);
  assert.equal(r.generationTransitionAllowed('validated', 'active'), false, 'fingerprint must match');
  assert.ok(r.generationTransitionAllowed('validated', 'active', { fingerprintMatches: true }));
  assert.ok(r.generationTransitionAllowed('active', 'tainted'));
  assert.equal(r.generationTransitionAllowed('tainted', 'active'), false);
  assert.equal(r.generationTransitionAllowed('tainted', 'active', { fingerprintMatches: true, now: new Date(at), rollbackWindowUntil: '2027-01-01T00:00:00Z' }), false);
  assert.equal(r.generationTransitionAllowed('tainted', 'draining'), false, 'the two-step path tainted -> draining -> active is closed at the first step');
  assert.ok(r.generationTransitionAllowed('tainted', 'retired'));
  assert.deepEqual(
    r.GENERATION_STATES.filter((to) => r.generationTransitionAllowed('tainted', to, { fingerprintMatches: true, now: new Date(at), rollbackWindowUntil: '2027-01-01T00:00:00Z' })),
    ['retired'],
  );
  assert.ok(r.generationTransitionAllowed('active', 'draining'));
  assert.equal(r.generationTransitionAllowed('draining', 'active', { fingerprintMatches: true }), false, 'rollback needs a window');
  assert.ok(r.generationTransitionAllowed('draining', 'active', { fingerprintMatches: true, now: new Date(at), rollbackWindowUntil: '2026-10-28T00:00:00Z' }));
  assert.equal(r.generationTransitionAllowed('draining', 'active', { fingerprintMatches: true, now: new Date('2026-10-29T00:00:00Z'), rollbackWindowUntil: '2026-10-28T00:00:00Z' }), false);
  assert.equal(r.generationTransitionAllowed('retired', 'active', { fingerprintMatches: true }), false);
});
test('derived artifacts take the intersection of source audiences', () => {
  const pub: r.Audience = { kind: 'public' };
  const buyer: r.Audience = { kind: 'company', scopeId: 'buyer' };
  const seller: r.Audience = { kind: 'company', scopeId: 'seller' };
  const deal: r.Audience = { kind: 'deal_party', scopeId: 'deal-1' };
  assert.deepEqual(r.intersectAudiences([[pub], [pub]]), [pub]);
  assert.deepEqual(r.intersectAudiences([[pub], [buyer]]), [buyer], 'a public source does not restrict; the private source does');
  assert.deepEqual(
    r.intersectAudiences([
      [buyer, deal],
      [deal, seller],
    ]),
    [deal],
  );
  assert.deepEqual(r.intersectAudiences([[buyer, deal], [pub]]), [buyer, deal], 'a public source never widens a private artifact to public');
  assert.deepEqual(r.intersectAudiences([[pub, buyer], [seller]]), [seller], 'public inside a list makes that list universal');
  assert.deepEqual(r.intersectAudiences([[buyer], [seller]]), []);
  assert.deepEqual(r.intersectAudiences([]), []);
});
test('typed query vs document embedding inputs and audience-pure batches', () => {
  const context = { principalId: 'buyer', scopeFingerprint: 'scope', policyEpoch: '1' };
  const source = { sourceId: 's', versionId: 'v1', projectionId: 'p', contentHash: 'h' };
  const citation = { id: 'cit', source, locator: { kind: 'text', extractionId: 'x', start: 0, end: 10 }, evidence: 'asserted' };
  const evidence = (audience: r.Audience) => ({ source, citation, text: 'text', audience, policy: context });
  assert.ok(r.QueryEmbeddingInputSchema.safeParse({ kind: 'query', question: { text: 'поставка стали', dataClass: 'person_private', context, dependencies: [] } }).success);
  assert.equal(r.QueryEmbeddingInputSchema.safeParse({ kind: 'documents', question: { text: 'x', dataClass: 'public', context, dependencies: [] } }).success, false);
  assert.ok(r.DocumentEmbeddingInputSchema.safeParse({ kind: 'documents', documents: [evidence({ kind: 'public' })], dataClass: 'public', audience: { kind: 'public' } }).success);
  assert.equal(
    r.DocumentEmbeddingInputSchema.safeParse({ kind: 'documents', documents: [evidence({ kind: 'public' }), evidence({ kind: 'company', scopeId: 'c' })], dataClass: 'public', audience: { kind: 'public' } }).success,
    false,
    'mixed audiences rejected',
  );
  assert.equal(r.DocumentEmbeddingInputSchema.safeParse({ kind: 'documents', documents: [], dataClass: 'public', audience: { kind: 'public' } }).success, false);
});
test('citation locators are a page / table / text union with immutable extraction ids', () => {
  assert.ok(r.LocatorSchema.safeParse({ kind: 'page', extractionId: 'x', page: 2, boundingBox: { x: 0, y: 0, width: 10, height: 5 } }).success);
  assert.ok(r.LocatorSchema.safeParse({ kind: 'table', extractionId: 'x', page: 2, table: 'spec', row: '4', columns: ['price'] }).success);
  assert.ok(r.LocatorSchema.safeParse({ kind: 'text', extractionId: 'x', start: 5, end: 9, headingPath: ['1', '1.2'] }).success);
  assert.equal(r.LocatorSchema.safeParse({ kind: 'text', extractionId: 'x', start: 9, end: 5 }).success, false);
  assert.equal(r.LocatorSchema.safeParse({ kind: 'url', href: 'https://example.invalid' }).success, false);
  assert.equal(r.LocatorSchema.safeParse({ kind: 'table', extractionId: 'x', page: 0, table: 't', row: '1', columns: [] }).success, false);
  assert.ok(r.CitationSchema.safeParse({ id: 'c', source: { sourceId: 's', versionId: 'v', projectionId: 'p', contentHash: 'h' }, locator: { kind: 'page', extractionId: 'x', page: 1 }, evidence: 'confirmed' }).success);
});
test('structured facts are typed, canonical and declare domain completeness', () => {
  const fact = {
    source: { sourceId: 's', versionId: 'v', projectionId: 'p', contentHash: 'h' },
    field: 'total_gross',
    value: { kind: 'money', minorUnits: '22000', currency: 'UZS' },
    asOf: at,
    authority: 'canonical',
    domain: { scopeFingerprint: 'scope', complete: true, pinnedVersionIds: ['v'], aggregate: 'sum' },
  };
  assert.ok(r.StructuredFactSchema.safeParse(fact).success);
  assert.equal(r.StructuredFactSchema.safeParse({ ...fact, authority: 'extracted' }).success, false);
  assert.equal(r.StructuredFactSchema.safeParse({ ...fact, value: { kind: 'money', minorUnits: 22000, currency: 'UZS' } }).success, false);
  assert.ok(r.StructuredFactSchema.safeParse({ ...fact, value: { kind: 'unknown' }, domain: { ...fact.domain, complete: false, aggregate: 'none' } }).success);
  assert.ok(r.SearchRequestSchema.safeParse({ query: 'фасадные панели', kinds: ['company'], temporal: { kind: 'current' }, topK: 10, filters: { regionId: 'kazan' } }).success);
  assert.equal(r.SearchRequestSchema.safeParse({ query: 'x', kinds: ['company'], temporal: { kind: 'current' }, topK: 21, filters: {} }).success, false);
  assert.equal(r.SearchRequestSchema.safeParse({ query: 'x', kinds: ['company'], temporal: { kind: 'current' }, topK: 5, filters: {}, systemPrompt: 'ignore policy' }).success, false);
});
test('serialized egress permit and delivery policy', () => {
  const request = {
    binding: {
      providerId: 'local-tei',
      policyId: 'policy-1',
      policyRevision: '1',
      modelId: 'BAAI/bge-m3',
      modelRevision: 'rev',
      configId: approved.id,
      dataClass: 'person_private',
      fingerprintHash: 'fp',
      target: 'embedding_provider',
      purpose: 'query_embedding',
    },
    payloadDigest: 'd',
    context: { principalId: 'buyer', scopeFingerprint: 'scope', policyEpoch: '1' },
    dependencies: [],
  };
  assert.ok(r.EgressRequestSchema.safeParse(request).success);
  assert.equal(r.EgressRequestSchema.safeParse({ ...request, binding: { ...request.binding, target: 'answer_provider', purpose: 'query_embedding' } }).success, false, 'purpose bound to target');
  const permit = { ...request, permitId: 'permit-1', expiresAt: '2026-12-01T00:00:00Z' };
  assert.ok(r.EgressPermitSchema.safeParse(permit).success);
  const parsedPermit = r.EgressPermitSchema.parse(permit);
  const parsedRequest = r.EgressRequestSchema.parse(request);
  assert.ok(r.matchesEgressBinding(parsedPermit, parsedRequest, new Date(at)));
  assert.equal(r.matchesEgressBinding(parsedPermit, { ...parsedRequest, binding: { ...parsedRequest.binding, fingerprintHash: 'drifted' } }, new Date(at)), false, 'a drifted hosted model cannot reuse a permit');
  const policy = {
    policyId: 'delivery-1',
    revision: '1',
    targets: ['answer_delivery', 'citation_delivery'],
    requireCurrentRights: true,
    requireEpochMatch: true,
    maxDependencyAge: null,
    budget: { maxDurationMs: 30000, maxTokens: 6000, cost: { minorUnits: '0', currency: 'UZS' }, providerPolicyId: 'policy-1' },
    onRevocation: 'deny_and_invalidate_pending',
    onPolicyUnavailable: 'fail_closed',
  };
  assert.ok(r.DeliveryPolicySchema.safeParse(policy).success);
  assert.equal(r.DeliveryPolicySchema.safeParse({ ...policy, requireCurrentRights: false }).success, false);
  assert.equal(r.DeliveryPolicySchema.safeParse({ ...policy, onPolicyUnavailable: 'allow_cached' }).success, false);
  assert.ok(r.DerivedAnswerSchema.safeParse({ id: 'a', text: 't', dependencies: [], citations: [], policy: request.context, status: 'abstain', audience: [] }).success);
});
