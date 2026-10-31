import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/contracts/src/index.js';
import * as f from '../../packages/contracts/src/files.js';

/**
 * FILE-001 contracts: classification inherited from the parent kind, per-type size limits, bounded signed URL lifetimes,
 * strict commands that leave no room for a client-chosen uploader, owner change or scan state, identifiers-only events,
 * erasure by two people, personal-data-free tombstones and the capability registry entries (ADR 010 decision 23).
 */
const person = { kind: 'person' as const, id: '7f0b2a52-0a51-4bd4-8f3c-111111111111' };
const command = (over: Record<string, unknown> = {}) => ({
  owner: person, parent: { kind: 'project', id: '7f0b2a52-0a51-4bd4-8f3c-222222222222' }, mediaType: 'image/png', bytes: 1024, sha256: 'a'.repeat(64), uploadKey: 'upload-key-000001', ...over,
});

test('classification is inherited from the parent kind and can only get stricter, except the listed public classes', () => {
  assert.equal(f.resolveClassification('project', null), 'shared');
  assert.equal(f.resolveClassification('project', 'owner_private'), 'owner_private');
  assert.equal(f.resolveClassification('project', 'public'), 'public', 'a published project story image');
  assert.equal(f.resolveClassification('rfq', 'public'), null, 'an RFQ attachment is never public');
  assert.equal(f.resolveClassification('quote', 'shared'), 'shared');
  assert.equal(f.resolveClassification('person', null), 'owner_private');
  assert.equal(f.resolveClassification('person', 'public'), 'public', 'an avatar');
  assert.equal(f.resolveClassification('person', 'shared'), null, 'looser than the default and not listed');
  assert.deepEqual(f.allowedClassifications('person'), ['public', 'owner_private']);
  assert.deepEqual(f.allowedClassifications('company'), ['public', 'owner_private']);
  assert.deepEqual(f.allowedClassifications('rfq'), ['shared', 'party_private', 'owner_private']);
  assert.deepEqual(f.allowedClassifications('publication'), ['public', 'shared', 'party_private', 'owner_private']);
  for (const kind of f.FILE_PARENT_KINDS) {
    assert.ok(f.allowedClassifications(kind).includes(f.CLASSIFICATION_POLICY[kind].default), kind);
    assert.ok(!(f.allowedClassifications(kind) as string[]).includes('restricted'), `${kind}: restricted is never requested`);
  }
});

test('per-type size limits, accepted types and bounded URL lifetimes', () => {
  assert.equal(f.sizeLimitExceeded('image/png', 15 * 1024 * 1024), null);
  assert.equal(f.sizeLimitExceeded('image/png', 15 * 1024 * 1024 + 1), 15 * 1024 * 1024);
  assert.equal(f.sizeLimitExceeded('application/pdf', 50 * 1024 * 1024), null);
  assert.equal(f.sizeLimitExceeded('application/pdf', 50 * 1024 * 1024 + 1), 50 * 1024 * 1024);
  assert.equal(f.sizeLimitExceeded('text/csv', 5 * 1024 * 1024 + 1), 5 * 1024 * 1024);
  assert.equal(f.sizeLimitExceeded('image/svg+xml', 1), 0, 'an unknown type has no allowance');
  for (const t of f.ACCEPTED_MEDIA_TYPES) assert.ok((f.MEDIA_TYPE_LIMITS[t]?.maxBytes ?? 0) <= f.FILE_MAX_BYTES, t);
  for (const t of ['image/svg+xml', 'text/html', 'application/zip', 'application/x-msdownload', 'application/javascript']) assert.ok(!f.ACCEPTED_MEDIA_TYPES.includes(t), t);
  assert.equal(f.boundedTtl('upload', undefined), 300);
  assert.equal(f.boundedTtl('upload', 86_400), 900);
  assert.equal(f.boundedTtl('download', 1), 10);
  assert.equal(f.boundedTtl('download', 3600), 300);
});

test('commands are strict: no uploader, scan state, storage key or owner change can be sent', () => {
  assert.ok(f.StartUploadCommandSchema.safeParse(command()).success);
  assert.deepEqual(f.StartUploadCommandSchema.parse(command()).actor, { via: 'person' });
  for (const extra of [{ uploadedBy: person.id }, { scanState: 'clean' }, { storageKey: 'files/u/x' }, { legalHold: false }]) {
    const result = f.StartUploadCommandSchema.safeParse(command(extra));
    assert.ok(!result.success && result.error.issues.some((i) => i.code === 'unrecognized_keys'), JSON.stringify(extra));
  }
  assert.ok(!f.StartUploadCommandSchema.safeParse(command({ classification: 'restricted' })).success);
  assert.ok(!f.StartUploadCommandSchema.safeParse(command({ parent: { kind: 'rfq', id: 'r1' }, classification: 'public' })).success);
  assert.ok(!f.StartUploadCommandSchema.safeParse(command({ parent: { kind: 'person', id: person.id }, owner: { kind: 'company', id: 'c1' } })).success, 'files of a person belong to that person');
  assert.ok(!f.StartUploadCommandSchema.safeParse(command({ mediaType: 'image/svg+xml' })).success);
  assert.ok(!f.StartUploadCommandSchema.safeParse(command({ sha256: 'A'.repeat(64) })).success);
  assert.ok(!f.StartUploadCommandSchema.safeParse(command({ bytes: 0 })).success);
  assert.ok(!f.StartUploadCommandSchema.safeParse(command({ uploadKey: 'short' })).success);
  assert.ok(!f.StartUploadCommandSchema.safeParse(command({ parent: { kind: 'invoice', id: 'x' } })).success);
  assert.ok(f.StartUploadCommandSchema.safeParse(command({ actor: { via: 'agent', mandateId: 'mandate-1' } })).success);
  for (const schema of [f.CopyFileCommandSchema, f.MoveFileCommandSchema]) {
    assert.ok(schema.safeParse({ parent: { kind: 'project', id: 'p2' } }).success);
    for (const extra of [{ classification: 'public' }, { owner: person }]) assert.ok(!schema.safeParse({ parent: { kind: 'project', id: 'p2' }, ...extra }).success, JSON.stringify(extra));
  }
  assert.ok(!f.DeleteFileCommandSchema.safeParse({ reason: 'x' }).success);
});

test('views, events, tombstones and erasure requests', () => {
  const view = {
    id: 'f1', owner: person, parent: { kind: 'project', id: 'p1' }, classification: 'shared', mediaType: 'image/png', bytes: 10, sha256: 'b'.repeat(64), scanState: 'clean',
    quarantineReason: null, origin: 'upload', uploadedBy: person.id, createdAt: '2026-11-01T10:00:00.000Z', revision: 1,
  };
  assert.ok(f.FileRefSchema.safeParse(view).success);
  for (const leak of [{ storageKey: 'files/u/x' }, { legalHold: false }, { url: 'https://x' }]) assert.ok(!f.FileRefSchema.safeParse({ ...view, ...leak }).success, JSON.stringify(leak));
  assert.deepEqual(f.attachmentRefOf(view as f.FileRef), { evidenceArtifactId: 'f1', hash: 'b'.repeat(64), audience: 'shared' });
  assert.equal(f.attachmentRefOf({ ...view, scanState: 'pending' } as f.FileRef), null);
  assert.equal(f.attachmentRefOf({ ...view, classification: 'owner_private' } as f.FileRef), null);
  assert.ok(c.AttachmentRefSchema.safeParse(f.attachmentRefOf(view as f.FileRef)).success);

  assert.ok(f.FileEventPayloadSchema.safeParse({ artifactId: '7f0b2a52-0a51-4bd4-8f3c-111111111111' }).success);
  assert.ok(!f.FileEventPayloadSchema.safeParse({ artifactId: '7f0b2a52-0a51-4bd4-8f3c-111111111111', storageKey: 'files/u/x' }).success, 'identifiers only');
  const tombstone = { v: 1, artifactId: '7f0b2a52-0a51-4bd4-8f3c-111111111111', storageKey: 'files/u/x', reason: 'erased', privacyRequestId: 'pr-1', recordedAt: '2026-11-01T10:00:00.000Z' };
  assert.ok(f.FileTombstoneSchema.safeParse(tombstone).success);
  assert.ok(!f.FileTombstoneSchema.safeParse({ ...tombstone, ownerName: 'Fixture Petr' }).success, 'no personal data');
  const erasure = { privacyRequestId: 'pr-1', artifactIds: [tombstone.artifactId], executedBy: '7f0b2a52-0a51-4bd4-8f3c-333333333333', secondApprover: '7f0b2a52-0a51-4bd4-8f3c-444444444444' };
  assert.ok(f.FileErasureRequestSchema.safeParse(erasure).success);
  assert.ok(!f.FileErasureRequestSchema.safeParse({ ...erasure, secondApprover: erasure.executedBy }).success, 'two different people');
  assert.ok(!f.FileErasureRequestSchema.safeParse({ ...erasure, artifactIds: [tombstone.artifactId, tombstone.artifactId] }).success);
  assert.ok(f.SignedRequestSchema.safeParse({ method: 'PUT', url: 'http://localhost:8333/b/k?X-Amz-Signature=1', headers: { 'content-type': 'image/png' }, expiresAt: '2026-11-01T10:05:00.000Z' }).success);
  assert.ok(!f.SignedRequestSchema.safeParse({ method: 'DELETE', url: 'http://localhost:8333/b/k', headers: {}, expiresAt: '2026-11-01T10:05:00.000Z' }).success, 'clients never get a signed delete');
});

test('every file capability is a valid registry entry for the interface and the agent, and resolves its contracts', () => {
  const ids = new Set<string>();
  for (const entry of f.FILE_CAPABILITIES) {
    const cap = entry.capability;
    assert.deepEqual(c.capabilityViolations(cap), [], cap.id);
    assert.ok(cap.surfaces.includes('ui') && cap.surfaces.includes('agent'), `${cap.id}: parity`);
    for (const ref of [cap.input, cap.output]) assert.ok((f as Record<string, unknown>)[ref.schema], `${cap.id}: files.${ref.schema} is exported`);
    assert.match(entry.apiRoute, /^(GET|POST) \/v1\/files/, cap.id);
    assert.ok(!ids.has(cap.id));
    ids.add(cap.id);
    if (cap.kind === 'commit') assert.equal(cap.acceptsUntrustedText, false, `${cap.id}: commits take structured input only`);
  }
  assert.deepEqual(c.parityGaps(f.FILE_CAPABILITIES.map((e) => e.capability)), []);
  assert.equal(f.FILE_CAPABILITIES.find((e) => e.capability.id === 'files.upload')?.capability.acceptsUntrustedText, true, 'uploaded content is untrusted input');
});
