import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HTTP_COVERED_COMPONENTS,
  REPLICA_MERGE_METHOD,
  httpSignatureProblems,
  inboxDeliveryDecision,
  intersectReplicaAudiences,
  mayReadReplica,
  replicaAudience,
  replicaDecision,
  type ReplicaState,
  type TombstoneReason,
} from '../../../packages/contracts/src/federation.js';
import { CITY, NATIONAL, THIRD, gid } from './fixtures.js';

test(`replica merge rule ${REPLICA_MERGE_METHOD}: revisions, duplicates, equivocation and tombstones`, () => {
  const none: ReplicaState = { kind: 'none' };
  const at3: ReplicaState = { kind: 'replica', revision: 3, digest: 'd3' };
  const env = (revision: number, digest = `d${revision}`) => ({ kind: 'envelope' as const, revision, digest });
  const ts = (revision: number, reason: TombstoneReason) => ({ kind: 'tombstone' as const, revision, reason });
  assert.deepEqual(replicaDecision(none, env(1)), { action: 'store' });
  assert.deepEqual(replicaDecision(at3, env(4)), { action: 'replace' });
  assert.deepEqual(replicaDecision(at3, env(2)), { action: 'ignore_stale' });
  assert.deepEqual(replicaDecision(at3, env(3)), { action: 'ignore_duplicate' });
  assert.deepEqual(replicaDecision(at3, env(3, 'other')), { action: 'reject', code: 'federation.replica_conflict' });
  assert.deepEqual(replicaDecision(at3, ts(3, 'unpublished')), { action: 'apply_tombstone' });
  assert.deepEqual(replicaDecision(at3, ts(2, 'unpublished')), { action: 'ignore_stale' });
  assert.deepEqual(replicaDecision(none, ts(1, 'erased')), { action: 'apply_tombstone' }, 'a tombstone for an unseen object is recorded so a late envelope cannot resurrect it');
  assert.deepEqual(replicaDecision({ kind: 'tombstoned', revision: 3, reason: 'unpublished' }, env(3)), { action: 'reject', code: 'federation.object_gone' });
  assert.deepEqual(replicaDecision({ kind: 'tombstoned', revision: 3, reason: 'unpublished' }, env(4)), { action: 'store' }, 'republished as a new revision');
  for (const reason of ['erased', 'takedown'] as const) assert.deepEqual(replicaDecision({ kind: 'tombstoned', revision: 3, reason }, env(9)), { action: 'reject', code: 'federation.object_gone' });
  assert.deepEqual(replicaDecision({ kind: 'tombstoned', revision: 3, reason: 'erased' }, ts(3, 'erased')), { action: 'ignore_duplicate' });
  assert.deepEqual(replicaDecision({ kind: 'tombstoned', revision: 3, reason: 'unpublished' }, ts(3, 'erased')), { action: 'apply_tombstone' }, 'an erasure escalates an unpublication');
  assert.deepEqual(replicaDecision({ kind: 'tombstoned', revision: 3, reason: 'erased' }, ts(3, 'unpublished')), { action: 'ignore_duplicate' }, 'nothing downgrades an erasure');
});

test('replica merge converges to the same state whatever order deliveries arrive in', () => {
  type Incoming = { kind: 'envelope'; revision: number; digest: string } | { kind: 'tombstone'; revision: number; reason: TombstoneReason };
  const apply = (sequence: Incoming[]): ReplicaState => {
    let state: ReplicaState = { kind: 'none' };
    for (const incoming of sequence) {
      const decision = replicaDecision(state, incoming);
      if (decision.action === 'store' || decision.action === 'replace') state = { kind: 'replica', revision: incoming.revision, digest: (incoming as { digest: string }).digest };
      if (decision.action === 'apply_tombstone') state = { kind: 'tombstoned', revision: incoming.revision, reason: (incoming as { reason: TombstoneReason }).reason };
    }
    return state;
  };
  const revisions: Incoming[] = [1, 2, 3, 4, 5].map((r) => ({ kind: 'envelope', revision: r, digest: `d${r}` }));
  const erased: Incoming[] = [...revisions, { kind: 'tombstone', revision: 4, reason: 'unpublished' }, { kind: 'tombstone', revision: 5, reason: 'erased' }];
  let seed = 7;
  const shuffle = <T>(items: T[]) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const j = seed % (i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };
  for (let round = 0; round < 50; round++) {
    assert.deepEqual(apply(shuffle(revisions)), { kind: 'replica', revision: 5, digest: 'd5' });
    assert.deepEqual(apply(shuffle(erased)), { kind: 'tombstoned', revision: 5, reason: 'erased' }, 'erasure wins in every order');
  }
});

/**
 * A reference inbox store with the uniqueness FED-001 implements in SQL: `(sender_node, delivery_id)` unique, insert
 * if absent (ON CONFLICT DO NOTHING), then read the stored body digest. Every await yields, so concurrent receptions
 * interleave between the read, the insert and the decision.
 */
class ReferenceInbox {
  private readonly rows = new Map<string, string>();
  effects = 0;
  async receive(sender: string, deliveryId: string, bodyDigest: string) {
    const key = `${sender}\u0000${deliveryId}`;
    await new Promise((resolve) => setImmediate(resolve));
    const inserted = !this.rows.has(key);
    if (inserted) this.rows.set(key, bodyDigest);
    await new Promise((resolve) => setImmediate(resolve));
    const decision = inserted ? inboxDeliveryDecision(null, bodyDigest) : inboxDeliveryDecision(this.rows.get(key)!, bodyDigest);
    if (decision.state === 'accepted') this.effects += 1;
    return decision;
  }
}

test('inbox idempotency under concurrency: one acceptance and one effect per (sender, delivery id)', async () => {
  const inbox = new ReferenceInbox();
  const same = await Promise.all(Array.from({ length: 50 }, () => inbox.receive(CITY, 'dlv-1', 'digest-a')));
  assert.equal(same.filter((d) => d.state === 'accepted').length, 1);
  assert.equal(same.filter((d) => d.state === 'duplicate').length, 49);
  assert.equal(inbox.effects, 1);

  const mixed = await Promise.all(Array.from({ length: 20 }, (_, i) => inbox.receive(CITY, 'dlv-2', i % 2 === 0 ? 'digest-x' : 'digest-y')));
  assert.equal(mixed.filter((d) => d.state === 'accepted').length, 1);
  const winner = mixed.findIndex((d) => d.state === 'accepted') % 2 === 0 ? 'x' : 'y';
  assert.equal(mixed.filter((d) => d.state === 'duplicate').length, 9, `same body as the winner (${winner}) is a duplicate`);
  assert.ok(mixed.filter((d) => d.state === 'rejected').every((d) => d.state === 'rejected' && d.code === 'federation.delivery_conflict'));
  assert.equal(mixed.filter((d) => d.state === 'rejected').length, 10);

  // The same delivery id from another sender is a different delivery.
  assert.deepEqual(await inbox.receive(NATIONAL, 'dlv-1', 'digest-b'), { state: 'accepted' });
  assert.equal(inbox.effects, 3);
});

test('R31: a replica\'s audience and the intersection of audiences for anything derived from several replicas', () => {
  const buyer = gid(NATIONAL, 'company', 'buyer');
  const seller = gid(CITY, 'company', 'seller');
  const other = gid(THIRD, 'company', 'other');
  const pub = replicaAudience({ audience: { kind: 'public' } });
  const dealA = replicaAudience({ audience: { kind: 'parties', parties: [seller, buyer], nodes: [NATIONAL, CITY] } });
  const dealB = replicaAudience({ audience: { kind: 'parties', parties: [buyer, other], nodes: [NATIONAL, THIRD] } });
  assert.deepEqual(dealA, { kind: 'parties', parties: [seller, buyer].sort() });
  assert.deepEqual(intersectReplicaAudiences([pub, pub]), { kind: 'public' });
  assert.deepEqual(intersectReplicaAudiences([pub, dealA]), dealA, 'public sources never widen a shared one');
  assert.deepEqual(intersectReplicaAudiences([dealA, dealB]), { kind: 'parties', parties: [buyer] });
  const disjoint = intersectReplicaAudiences([dealA, replicaAudience({ audience: { kind: 'parties', parties: [other, gid(THIRD, 'person', 'p')], nodes: [THIRD] } })]);
  assert.deepEqual(disjoint, { kind: 'parties', parties: [] });
  assert.ok(mayReadReplica(pub, []));
  assert.ok(mayReadReplica(dealA, [seller]));
  assert.ok(!mayReadReplica(dealA, [other]), 'a non-party never reads deal data');
  assert.ok(!mayReadReplica(disjoint, [buyer, seller, other]), 'an empty intersection is readable by nobody');
});

test('HTTP signature freshness and coverage rules', () => {
  const now = 1_793_606_400;
  const params = { created: now, expires: now + 300, keyid: 'a1', nonce: 'bm9uY2Utb2YtdGhlLWluYm94LXZlY3Rvcg' };
  const post = HTTP_COVERED_COMPONENTS.requestWithBody;
  assert.deepEqual(httpSignatureProblems({ components: [...post], params }, post, now + 10), []);
  assert.deepEqual(httpSignatureProblems({ components: ['@method', '@target-uri'], params }, post, now), ['components']);
  assert.deepEqual(httpSignatureProblems({ components: [...post], params: { ...params, expires: now + 3600 } }, post, now), ['window']);
  assert.deepEqual(httpSignatureProblems({ components: [...post], params }, post, now + 400), ['clock_skew']);
  assert.deepEqual(httpSignatureProblems({ components: [...post], params }, post, now - 120), ['clock_skew']);
  assert.deepEqual(httpSignatureProblems({ components: [...post], params: { ...params, nonce: null } }, post, now), ['nonce_missing']);
  assert.deepEqual(httpSignatureProblems({ components: [...HTTP_COVERED_COMPONENTS.response], params: { ...params, nonce: null } }, HTTP_COVERED_COMPONENTS.response, now), []);
});
