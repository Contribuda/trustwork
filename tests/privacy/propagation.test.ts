import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { consumePrivacyPropagation, type PrivacyPropagationPort } from '../../apps/worker/src/privacy/propagation.js';
import { PrivacyPropagationSchema } from '../../packages/contracts/src/privacy.js';
import { gate, provisionWorkerDatabase } from '../worker/helpers/worker-db.js';

test('PRV propagation outbox: explicit adapters, current durable outcomes and cross-process reconciliation', async (t) => {
  const env = await provisionWorkerDatabase('privacy_propagation'); assert.ok(env);
  const worker = env.workerPool(); const root = await mkdtemp(join(tmpdir(), 'privacy-propagation-'));
  t.after(async () => { await env.close(); await rm(root, { recursive: true, force: true }); });
  const seed = async (target: 'retrieval' | 'federation' = 'retrieval') => {
    const instruction = PrivacyPropagationSchema.parse({ version: 1, id: randomUUID(), requestId: randomUUID(), target,
      subject: { kind: 'person', id: randomUUID() }, digest: '1'.repeat(64), modules: ['privacy'], operation: 'apply_retained_redaction' });
    await env.db.admin.query('INSERT INTO trustwork.privacy_propagation(id,request_id,target,decision_digest,payload) VALUES($1,$2,$3,$4,$5)',
      [instruction.id, instruction.requestId, target, instruction.digest, JSON.stringify(instruction)]);
    return instruction;
  };
  const state = async (id: string) => (await env.db.admin.query('SELECT state FROM trustwork.privacy_propagation WHERE id=$1', [id])).rows[0].state;
  await t.test('API cannot inspect or acknowledge delivery; missing target adapter is not success', async () => {
    const instruction = await seed('federation');
    await assert.rejects(env.apiPool.query('SELECT * FROM trustwork.privacy_propagation'));
    await assert.rejects(env.apiPool.query('SELECT trustwork.privacy_propagation_get($1)', [instruction.id]));
    await assert.rejects(env.apiPool.query('SELECT trustwork.privacy_propagation_record($1,$2,$3)', [instruction.id, instruction.digest, 'fabricated']));
    assert.equal(await consumePrivacyPropagation(worker, instruction.id), 'unavailable');
    assert.equal(await state(instruction.id), 'pending');
    await assert.rejects(consumePrivacyPropagation(worker, instruction.id, { target: 'retrieval', apply: async () => ({ receipt: 'wrong' }), reconcile: async () => ({ state: 'unknown' }) }), /binding/);
    assert.equal(await state(instruction.id), 'pending');
  });
  for (const target of ['retrieval', 'federation'] as const) {
    await t.test(`${target} duplicate consumers serialize and acknowledge the exact instruction once`, async () => {
      const instruction = await seed(target); const entered = gate(); const release = gate(); let applies = 0;
      const port: PrivacyPropagationPort = { target, reconcile: async () => ({ state: 'unknown' }), apply: async (i) => {
        assert.deepEqual(i, instruction); applies++; entered.open(); await release.promise; return { receipt: 'synthetic-owning-receipt' };
      } };
      const first = consumePrivacyPropagation(worker, instruction.id, port); await entered.promise;
      assert.equal(await state(instruction.id), 'outcome_unknown', 'unknown marker committed before the effect');
      const second = consumePrivacyPropagation(worker, instruction.id, port); release.open();
      assert.deepEqual(await Promise.all([first, second]), ['acknowledged', 'acknowledged']); assert.equal(applies, 1);
      await assert.rejects(worker.query('SELECT trustwork.privacy_propagation_record($1,$2,$3)', [instruction.id, instruction.digest, 'different']));
    });
  }
  await t.test('process death after the effect preserves unknown; restart reconciles and never sends twice', async () => {
    const instruction = await seed(); const receiptPath = join(root, 'receipt.json');
    const child = fork(new URL('./fixtures/propagation-process.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit'); t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    const message = once(child, 'message'); child.send({ connectionString: env.workerUrl, id: instruction.id, receiptPath });
    assert.deepEqual((await message)[0], { applied: true }); child.kill('SIGKILL'); await exited;
    assert.equal(await state(instruction.id), 'outcome_unknown'); let applies = 0;
    const port: PrivacyPropagationPort = { target: 'retrieval', apply: async () => { applies++; throw new Error('must reconcile'); }, reconcile: async (i) => {
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { id: string; digest: string; receipt: string };
      assert.equal(receipt.id, i.id); assert.equal(receipt.digest, i.digest); return { state: 'applied', receipt: receipt.receipt };
    } };
    assert.equal(await consumePrivacyPropagation(worker, instruction.id, { ...port, reconcile: async () => ({ state: 'unknown' }) }), 'outcome_unknown');
    assert.equal(await consumePrivacyPropagation(worker, instruction.id, port), 'acknowledged'); assert.equal(applies, 0);
  });
  await t.test('authoritative absence permits one retry with the same key, never a new operation', async () => {
    const instruction = await seed(); let applies = 0;
    const port: PrivacyPropagationPort = { target: 'retrieval', reconcile: async () => ({ state: 'absent' }), apply: async (i) => {
      applies++; assert.equal(i.id, instruction.id); if (applies === 1) throw new Error('synthetic connection lost before effect'); return { receipt: 'synthetic-retry' };
    } };
    await assert.rejects(consumePrivacyPropagation(worker, instruction.id, port), /connection lost/);
    assert.equal(await state(instruction.id), 'outcome_unknown'); assert.equal(await consumePrivacyPropagation(worker, instruction.id, port), 'acknowledged'); assert.equal(applies, 2);
  });
});
