import test from 'node:test';
import { buildAgentWorld } from '../agent-modules/helpers.js';
import assert from 'node:assert/strict';
import { AssistantService, DEFAULT_RUNTIME_SETTINGS } from '../../apps/api/src/modules/assistant/assistant.service.js';
import { assistantPolicySettings } from '../../apps/api/src/modules/assistant/assistant.module.js';
import { UnavailableRetrieval, type ModelInput, type ModelPort, type ModelReply } from '../../apps/api/src/modules/assistant/ports.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { stateOf } from '../assistant/helpers.js';
import { bindCompletion, InTransactionCompletion } from '../../apps/api/src/common/idempotency/completion.js';
import { assistantModelTurns } from '../../packages/data/src/repositories/assistant-model.js';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';

const h = await startHarness('models_ast_boundary');
test('AST model boundary commits before effect, serializes conversation and finalizes exactly once', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  await buildAgentWorld(h);
  h.clock.reset();
  await seedPersonas(h);
  const client = h.client();
  await login(client, 'petr');
  let calls = 0;
  let recoveries = 0;
  const success: ModelReply = { text: 'Synthetic model reply', messageKey: null, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  let handler: (i: ModelInput) => Promise<ModelReply> = async () => success;
  let recovery: ModelReply | null = null;
  const model: ModelPort = {
    provider: 'fake',
    async respond(input) {
      calls++;
      return handler(input);
    },
    async recover() {
      recoveries++;
      return recovery;
    },
  };
  const service = new AssistantService(
    h.created.ctx!,
    h.services().principals,
    assistantPolicySettings({ hubId: null }),
    DEFAULT_RUNTIME_SETTINGS,
    model,
    new UnavailableRetrieval(),
  );
  const state = (key: string) => stateOf(h, client, key);
  await t.test('adapter observes committed incoming turn/run; replay produces one answer without calling model', async () => {
    handler = async (input) => {
      assert.ok(input.execution);
      const row = (
        await h.db.admin.query('SELECT t.*,r.principal_person_id FROM trustwork.assistant_model_turn t JOIN trustwork.run r ON r.id=t.run_id WHERE t.id=$1', [
          input.execution.operationId,
        ])
      ).rows[0];
      assert.equal(row.state, 'pending');
      assert.equal(row.principal_person_id, input.personId);
      assert.equal(row.result, null);
      assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.conversation_turn WHERE id=$1', [row.asked_id])).rows[0].n, 1);
      return success;
    };
    const before = calls;
    const first = await service.converse({ text: 'Synthetic committed input' }, await state('model-boundary-one'));
    const again = await service.converse({ text: 'Synthetic committed input' }, await state('model-boundary-one'));
    assert.deepEqual(again, first);
    assert.equal(calls, before + 1);
    assert.equal(first.turns.length, 2);
    await assert.rejects(service.converse({ text: 'different' }, await state('model-boundary-one')));
  });
  await t.test('overlapping turns and duplicate pending request never dispatch twice', async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    handler = async () => {
      entered();
      await hold;
      return success;
    };
    const before = calls;
    const one = service.converse({ text: 'Synthetic blocked input' }, await state('model-boundary-two'));
    await ready;
    await assert.rejects(service.converse({ text: 'Another turn' }, await state('model-boundary-three')));
    await assert.rejects(service.converse({ text: 'Synthetic blocked input' }, await state('model-boundary-two')));
    assert.equal(calls, before + 1);
    release();
    await one;
  });
  await t.test('crash after fake effect keeps pending intent; retry uses receipt lookup only', async () => {
    handler = async () => {
      throw new Error('Synthetic crash after fake effect');
    };
    const before = calls;
    await assert.rejects(service.converse({ text: 'Synthetic crash input' }, await state('model-boundary-crash')));
    await withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.agent_serving_hub SET active = false`.execute(trx));
    await assert.rejects(service.converse({ text: 'No fresh dispatch after binding withdrawal' }, await state('model-boundary-unavailable')));
    await assert.rejects(service.converse({ text: 'Synthetic crash input' }, await state('model-boundary-crash')));
    assert.equal(calls, before + 1);
    recovery = success;
    const recovered = await service.converse({ text: 'Synthetic crash input' }, await state('model-boundary-crash'));
    assert.equal(recovered.run.state, 'completed');
    assert.equal(calls, before + 1);
    assert.ok(recoveries >= 2);
    await withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.agent_serving_hub SET active = true`.execute(trx));
  });
  await t.test('HTTP completion failure rolls back final response but retains committed intent and stable operation', async () => {
    handler = async () => success;
    recovery = success;
    const s = await state('original-http-request');
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    // A nonexistent lease forces completion failure at the actual PrincipalService transaction boundary.
    bindCompletion(s, new InTransactionCompletion(key, new Date(), 200, () => new Date(Date.now() + 60000)));
    const before = calls;
    await assert.rejects(service.converse({ text: 'Synthetic final commit failure' }, s));
    const pending = (await h.db.admin.query('SELECT * FROM trustwork.assistant_model_turn WHERE request_key=$1', [key])).rows[0];
    assert.equal(pending.state, 'pending');
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.conversation_turn WHERE run_id=$1', [pending.run_id])).rows[0].n, 1);
    const retry = await state(key);
    const result = await service.converse({ text: 'Synthetic final commit failure' }, retry);
    assert.equal(result.run.id, pending.run_id);
    assert.equal(calls, before + 1);
    const other = h.client();
    await login(other, 'anna');
    const foreign = await stateOf(h, other, 'foreign');
    assert.ok(foreign.principal);
    assert.equal(await withPrincipal(h.pool, foreign.principal, (trx) => assistantModelTurns.get(trx, pending.id)), undefined);
    await assert.rejects(withPrincipal(h.pool, foreign.principal, (trx) => assistantModelTurns.finish(trx, pending.id, {})));
  });
});
