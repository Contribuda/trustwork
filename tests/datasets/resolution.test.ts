import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { datasets, datasetsWorker, links } from '../../packages/data/src/repositories/datasets.js';
import { LinkProposalSchema } from '../../packages/contracts/src/hub.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { datasetInput, datasetsWorld, record } from './helpers.js';

const env = await provisionWorkerDatabase('datasets_resolution');

/**
 * MINE-001 part 2 on real PostgreSQL: entity resolution proposes links, never merges. The resolver proposes only
 * identifier matches, marked statutory when the record came from an official register and the company holds the
 * identifier; names alone never produce a proposal. A person decides, never their own proposal; a person is linked
 * only with their own confirmation; a pair marked distinct is never proposed again; a batch decision covers only
 * statutory identifier evidence and records the sample and counts. Every value is synthetic.
 */
test('MINE-001 entity resolution on PostgreSQL', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const worker = env.workerPool(4);
  const world = await datasetsWorld(admin, env.apiPool);
  const { w, as, cmd, activeSource } = world;
  const p = w.people;
  const steward = p.hubOwner;
  const second = p.lead2;
  const register = await activeSource();
  const directory = await activeSource({ kind: 'rss', readerKind: 'industry_media', name: 'Synthetic Trade Directory', url: 'https://directory.synthetic.invalid/feed.xml',
    licence: { kind: 'open_licence', name: 'CC BY 4.0', url: null, agreementRef: null } });
  const company = (name: string, identifiers: Array<{ kind: string; value: string }>) => withMaintenance(admin, async (trx) =>
    (await trx.insertInto('company').values({ display_name: name, claim_status: 'unclaimed', legal_identifiers: JSON.stringify(identifiers.map((i) => ({ ...i, status: 'sourced' }))) })
      .returning('id').executeTakeFirstOrThrow()).id);
  const proposed = await cmd(steward, (trx, ctx) => datasets.propose(trx, ctx, w.hubId, datasetInput([register.id, directory.id])));
  const dataset = await cmd(second, (trx, ctx) => datasets.activate(trx, ctx, proposed.id, proposed.revision, null));
  const keys = ['R1001', 'R1002', 'R1003', 'R1004', 'R1005', 'R1006'];
  await cmd(steward, (trx, ctx) => datasets.ingest(trx, ctx, dataset.id, [
    ...keys.map((k) => record(register.id, k)),
    record(directory.id, 'X2001', { identifierValue: '2001' }),
    record(register.id, 'N3001', { identifierKind: null, identifierValue: null, fields: { legalName: 'Synthetic Namesake LLC', status: 'active' } }),
  ]));
  const holders = new Map<string, string>();
  for (const k of keys) holders.set(k, await company(`Synthetic Holder ${k}`, [{ kind: 'US-CA-SOS', value: k.slice(1) }]));
  const directoryHolder = await company('Synthetic Directory Holder', [{ kind: 'US-CA-SOS', value: '2001' }]);
  await company('Synthetic Namesake LLC', []);
  const records = await as(steward, (trx) => datasets.records(trx, dataset.id));
  const recordOf = (key: string) => records.find((r) => r.external_key === key)!;

  await t.test('the resolver proposes identifier matches only; statutory only from an official register', async () => {
    const count = await tx(worker, (trx) => datasetsWorker.resolve(trx, dataset.id));
    assert.equal(count, 7);
    const all = await as(steward, (trx) => links.proposals(trx, w.hubId, 'proposed'));
    assert.equal(all.length, 7);
    assert.ok(all.every((l) => l.effect === 'link' && l.target_kind === 'company' && l.scoring_method === 'trustwork-resolve/1' && l.proposed_by_kind === 'resolver'));
    assert.equal(all.find((l) => l.record_id === recordOf('X2001').id)?.statutory_identifier, false, 'an industry directory is not a statutory register');
    assert.equal(all.filter((l) => l.statutory_identifier).length, 6);
    assert.ok(!all.some((l) => l.record_id === recordOf('N3001').id), 'a name alone never produces a proposal');
    assert.equal(await tx(worker, (trx) => datasetsWorker.resolve(trx, dataset.id)), 0, 'open proposals are not repeated');
    for (const l of all) {
      const parsed = LinkProposalSchema.safeParse({ id: l.id, hubId: l.hub_id, left: { kind: 'sourced_record', id: l.record_id }, right: { kind: l.target_kind, id: l.target_id },
        evidence: l.evidence, confidence: l.confidence, proposedBy: { kind: 'pipeline', pipelineId: l.dataset_id, runId: l.id }, status: l.state,
        decidedBy: null, decidedAt: null, effect: 'link' });
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    }
  });

  await t.test('a batch decision covers only statutory identifier evidence and records the sample and counts', async () => {
    const open = await as(steward, (trx) => links.proposals(trx, w.hubId, 'proposed'));
    const statutory = open.filter((l) => l.statutory_identifier).map((l) => l.id);
    const directoryLink = open.find((l) => !l.statutory_identifier)!.id;
    await rejects(cmd(second, (trx, ctx) => links.batchDecide(trx, ctx, w.hubId, [...statutory, directoryLink], statutory.slice(0, 5), 'accepted')), '23514',
      'datasets.batch_requires_statutory_identifier');
    await rejects(cmd(second, (trx, ctx) => links.batchDecide(trx, ctx, w.hubId, statutory, statutory.slice(0, 3), 'accepted')), '23514', 'datasets.sample_required');
    await rejects(cmd(p.otherAgent, (trx, ctx) => links.batchDecide(trx, ctx, w.hubId, statutory, statutory.slice(0, 5), 'accepted')), '42501', 'admin.forbidden');
    const batch = await cmd(second, (trx, ctx) => links.batchDecide(trx, ctx, w.hubId, statutory.slice(1), statutory.slice(1, 6), 'accepted'));
    assert.deepEqual([batch.decision, batch.proposal_count, batch.sample_ids.length, batch.scoring_method, batch.decided_by], ['accepted', 5, 5, 'trustwork-resolve/1', second]);
    const accepted = await as(steward, (trx) => links.proposals(trx, w.hubId, 'accepted'));
    assert.equal(accepted.length, 5);
    assert.ok(accepted.every((l) => l.batch_id === batch.id && l.decided_by === second));
    await rejects(cmd(second, (trx, ctx) => links.batchDecide(trx, ctx, w.hubId, statutory.slice(1, 2), statutory.slice(1, 2), 'rejected')), '23514', 'datasets.invalid_batch');
  });

  await t.test('a person decides single proposals, never their own; a person target needs their confirmation', async () => {
    const directoryLink = (await as(steward, (trx) => links.proposals(trx, w.hubId, 'proposed'))).find((l) => !l.statutory_identifier)!;
    const rejected = await cmd(steward, (trx, ctx) => links.decide(trx, ctx, directoryLink.id, directoryLink.revision, 'rejected'));
    assert.equal(rejected.state, 'rejected');
    await rejects(cmd(steward, (trx, ctx) => links.decide(trx, ctx, directoryLink.id, rejected.revision, 'accepted')), '23514', 'datasets.invalid_transition');

    const namesake = recordOf('N3001');
    const similar = await cmd(steward, (trx, ctx) => links.propose(trx, ctx, namesake.id, 'company', directoryHolder,
      [{ kind: 'name_address_similarity', detail: 'Similar name and city', similarity: '0.71' }], '0.7'));
    assert.equal(similar.statutory_identifier, false);
    await rejects(cmd(steward, (trx, ctx) => links.decide(trx, ctx, similar.id, similar.revision, 'accepted')), '42501', 'datasets.own_proposal');
    await rejects(cmd(p.outsider, (trx, ctx) => links.decide(trx, ctx, similar.id, similar.revision, 'accepted')), '42501', 'admin.forbidden');
    await cmd(second, (trx, ctx) => links.decide(trx, ctx, similar.id, similar.revision, 'accepted'));

    const person = await withMaintenance(admin, async (trx) => (await trx.insertInto('person').values({ display_name: 'Synthetic Licence Holder' }).returning('id').executeTakeFirstOrThrow()).id);
    const toPerson = await cmd(steward, (trx, ctx) => links.propose(trx, ctx, recordOf('R1001').id, 'person', person,
      [{ kind: 'register_officer_match', detail: 'Officer name in the register', similarity: '0.9' }], '0.8'));
    await rejects(cmd(second, (trx, ctx) => links.decide(trx, ctx, toPerson.id, toPerson.revision, 'accepted')), '23514', 'datasets.person_confirmation_required');
    const confirmed = await cmd(steward, (trx, ctx) => links.propose(trx, ctx, recordOf('R1002').id, 'person', person,
      [{ kind: 'subject_confirmation', detail: 'The person confirmed both records are theirs', similarity: null }], '1'));
    assert.equal((await cmd(second, (trx, ctx) => links.decide(trx, ctx, confirmed.id, confirmed.revision, 'accepted'))).state, 'accepted');
  });

  await t.test('a pair marked distinct is withdrawn and never proposed again', async () => {
    const r1 = recordOf('R1001');
    const holder = holders.get('R1001')!;
    const open = (await as(steward, (trx) => links.proposals(trx, w.hubId, 'proposed'))).find((l) => l.record_id === r1.id && l.target_id === holder)!;
    assert.ok(open, 'R1001 was left out of the batch');
    await rejects(cmd(second, (trx, ctx) => links.markDistinct(trx, ctx, r1.id, 'company', holder, 'short')), '23514');
    await cmd(second, (trx, ctx) => links.markDistinct(trx, ctx, r1.id, 'company', holder, 'Different companies that share a reused register number.'));
    assert.equal((await as(steward, (trx) => links.proposal(trx, open.id)))?.state, 'withdrawn');
    assert.equal(await tx(worker, (trx) => datasetsWorker.resolve(trx, dataset.id)), 0);
    await rejects(cmd(steward, (trx, ctx) => links.propose(trx, ctx, r1.id, 'company', holder, [{ kind: 'identifier_match', detail: 'Same number', similarity: '1' }], '0.99')),
      '23514', 'datasets.marked_distinct');
    const acceptedOne = (await as(steward, (trx) => links.proposals(trx, w.hubId, 'accepted'))).find((l) => l.target_kind === 'company' && l.batch_id !== null)!;
    await rejects(cmd(second, (trx, ctx) => links.markDistinct(trx, ctx, acceptedOne.record_id, 'company', acceptedOne.target_id, 'Different companies after all, says the register.')),
      '23514', 'datasets.link_accepted');
  });

  await t.test('a buried record withdraws its open proposals; staff of the hub only read proposals', async () => {
    const extra = await company('Synthetic Late Holder', [{ kind: 'US-CA-SOS', value: '1003' }]);
    assert.equal(await tx(worker, (trx) => datasetsWorker.resolve(trx, dataset.id)), 1);
    const open = (await as(steward, (trx) => links.proposals(trx, w.hubId, 'proposed'))).find((l) => l.target_id === extra)!;
    await cmd(steward, (trx, ctx) => datasets.addDoNotCollect(trx, ctx, w.hubId, 'identifier', '1003', 'objection'));
    assert.equal((await as(steward, (trx) => links.proposal(trx, open.id)))?.state, 'withdrawn');
    assert.deepEqual(await as(p.outsider, (trx) => links.proposals(trx, w.hubId)), []);
    assert.deepEqual(await as(p.otherAgent, (trx) => links.proposals(trx, w.hubId)), []);
    await assert.rejects(tx(env.apiPool, (trx) => datasetsWorker.resolve(trx, dataset.id)), /permission denied/);
  });
});
