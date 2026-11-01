import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withPrincipal } from '@trustwork/data';
import type { Principal } from '@trustwork/contracts';
import { createApp } from '../../apps/api/src/app.js';
import type { IdentityServices } from '../../apps/api/src/modules/identity/identity.module.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { AssistantService, DEFAULT_RUNTIME_SETTINGS } from '../../apps/api/src/modules/assistant/assistant.service.js';
import { assistantPolicySettings } from '../../apps/api/src/modules/assistant/assistant.module.js';
import { UnavailableModel, UnavailableRetrieval, type ModelInput, type ModelPort, type ModelReply } from '../../apps/api/src/modules/assistant/ports.js';
import { createRuntimeAssistantModel, type ModelExecutionPolicyPort } from '../../apps/api/src/modules/models/runtime-assistant.js';
import { FakeModelRegistry } from '../../apps/api/src/modules/models/ports.js';
import { DeterministicModel } from '../../apps/api/src/modules/models/fake.js';
import { PostgresModelReceiptStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { modelCalls } from '../../packages/data/src/repositories/models.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { mandates, runs } from '../../packages/data/src/repositories/assistant.js';
import { egressRules } from '../../packages/data/src/repositories/providers.js';
import type { AssistantModelTurnRow } from '../../packages/data/src/schema/assistant-model.js';
import type { ModelCall, PinnedCandidate } from '../../packages/contracts/src/models.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { durableWorld, syntheticGovernance } from './durable-helpers.js';
import type { RecoveryWorkerConfig } from './recovery-worker.js';

const db = await provisionTestDatabase('models_recovery');
test('real PostgreSQL conversation crash, cancellation and receipt recovery fences', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  const w = await durableWorld(db);
  await db.admin.query(
    "INSERT INTO trustwork.agent_serving_hub(origin,hub_id) VALUES ($1,$2)",
    ['https://trustwork.test', w.hubId],
  );
  const app = await createApp({
    pool: w.pool,
    env: {
      AUTH_PROVIDER_MODE: 'fake',
      PUBLIC_ORIGIN: 'https://trustwork.test',
    },
  });
  t.after(async () => {
    await app.close();
    await w.pool.end();
    await db.close();
  });
  await w.allowPrivate();
  const principal: Principal = {
    ...w.principal,
    emailVerified: true,
    authenticatedAt: new Date().toISOString(),
    membership: null,
    staff: [],
    delegation: null,
  };
  const state = (key: string): RequestState => ({
    requestId: key,
    principal,
    sessionTokenHash: null,
    session: {
      id: w.binding.sessionId,
      personId: w.personId,
      authenticatedAt: new Date(),
      createdAt: new Date(),
      authMethod: 'password',
    },
    client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' },
  });
  const as = <T>(fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(w.pool, w.principal, fn);
  const service = (model: ModelPort) =>
    new AssistantService(
      app.ctx!,
      (app.services as IdentityServices).principals,
      assistantPolicySettings({ hubId: w.hubId }),
      DEFAULT_RUNTIME_SETTINGS,
      model,
      new UnavailableRetrieval(),
    );
  const registry = new FakeModelRegistry();
  const adapter = new DeterministicModel();
  registry.register(w.connection.id, adapter);
  registry.register(w.secondary.id, new DeterministicModel());
  const setup = async () => {
    const budget = await w.budget();
    const mandate = await w.mandate(budget);
    const call = {
      ...(await w.call(mandate.id)),
      dataClasses: ['person_private'] as ModelCall['dataClasses'],
    };
    const policy: ModelExecutionPolicyPort = {
      ...syntheticGovernance,
      async select() {
        return { call, action: w.binding.action, context: w.binding.context };
      },
    };
    return {
      budget,
      mandate,
      call,
      model: createRuntimeAssistantModel(w.pool, registry, policy),
    };
  };
  const input = (turn: AssistantModelTurnRow): ModelInput => ({
    personId: w.personId,
    history: [],
    text: '',
    evidence: [],
    execution: {
      operationId: turn.id,
      runId: turn.run_id,
      hubId: w.hubId,
      principal,
      sessionId: w.binding.sessionId,
    },
  });
  const turnFor = (key: string) => as((trx) => trx.selectFrom('assistant_model_turn').selectAll().where('request_key', '=', key).executeTakeFirstOrThrow());
  const child = (config: Omit<RecoveryWorkerConfig, 'db' | 'binding'>) => {
    const p = fork(new URL('./recovery-worker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    t.after(() => {
      if (p.exitCode === null) p.kill();
    });
    let data: {
      turn?: AssistantModelTurnRow;
      call?: ModelCall;
      calls?: number;
      outcome?: string;
      error?: string;
    } = {};
    let stderr = '';
    p.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    let ready!: () => void;
    const paused = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const done = new Promise<typeof data & { exit: number | null }>((resolve, reject) => {
      p.on('message', (message) => {
        data = { ...data, ...(message as object) };
        if ((message as { paused?: boolean }).paused) ready();
      });
      p.on('error', reject);
      p.on('exit', (exit) => {
        ready();
        if (stderr) reject(new Error(stderr));
        else resolve({ ...data, exit });
      });
    });
    p.send({ ...config, db: db.appConfig, binding: w.binding });
    return {
      paused,
      done,
      data: () => data,
      resume: () => p.send({ resume: true }),
    };
  };
  await t.test('process dies after AST prepare and before model store; fenced recovery finalizes and permits a new turn', async () => {
    const f = await setup();
    const key = randomUUID();
    const text = 'Synthetic prepare crash';
    const crashed = await child({
      mode: 'prepare_die',
      call: f.call,
      key,
      text,
    }).done;
    assert.equal(crashed.exit, 70);
    assert.ok(crashed.turn);
    assert.equal(await as((trx) => modelCalls.get(trx, crashed.turn!.id)), undefined);
    const before = adapter.calls.length;
    const result = await service(f.model).converse({ text }, state(key));
    assert.equal(result.run.id, crashed.turn.run_id);
    assert.equal(result.turns[1]!.content, 'assistant.overlay.stateUnavailable');
    assert.equal((await turnFor(key)).dispatch_closed, true);
    assert.equal(adapter.calls.length, before);
    assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '0');
    assert.equal((await service(f.model).converse({ text: 'New synthetic turn' }, state(randomUUID()))).run.state, 'completed');
  });
  await t.test('second process recovery fences a still-live original before model creation and before admission', async () => {
    for (const mode of ['before_store', 'before_admit'] as const) {
      const f = await setup();
      const key = randomUUID();
      const text = `Synthetic ${mode}`;
      const original = child({ mode, call: f.call, key, text });
      await original.paused;
      const pending = original.data();
      assert.ok(pending.turn);
      assert.ok(pending.call);
      const foreign = new PostgresModelReceiptStore(
        w.pool,
        { personId: w.world.people.officer, authzEpoch: 1 },
        { sessionId: w.world.sessions.officer, authzEpoch: 1 },
      );
      await assert.rejects(foreign.recover(pending.turn.id, w.world.people.officer));
      assert.equal((await turnFor(key)).dispatch_closed, false);
      const recovered = await child({
        mode: 'recover',
        call: pending.call,
        key,
        text,
      }).done;
      assert.equal(recovered.outcome, 'refused');
      assert.equal(recovered.calls, 0);
      original.resume();
      assert.equal((await original.done).calls, 0);
      const result = await service(f.model).converse({ text }, state(key));
      assert.equal(result.run.id, pending.turn.run_id);
      assert.equal(result.turns[1]!.role, 'system');
      assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '0');
      const row = await as((trx) => modelCalls.get(trx, pending.turn!.id));
      assert.equal(row?.state, mode === 'before_store' ? undefined : 'refused');
      if (row) assert.equal(row.invoked, false);
    }
  });
  await t.test('admission committed before recovery is unknown even before the adapter sees the original process', async () => {
    const f = await setup();
    const key = randomUUID();
    const text = 'Synthetic admission gap';
    const original = child({
      mode: 'after_admit',
      call: f.call,
      key,
      text,
    });
    await original.paused;
    const pending = original.data();
    assert.ok(pending.turn);
    assert.ok(pending.call);
    const recovered = await child({
      mode: 'recover',
      call: pending.call,
      key,
      text,
    }).done;
    assert.equal(recovered.outcome, 'outcome_unknown');
    assert.equal(recovered.calls, 0);
    assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '7');
    original.resume();
    assert.equal((await original.done).calls, 1);
    await service(f.model).cancelRun(pending.turn.run_id, { reason: null }, state(randomUUID()));
    assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '7');
    assert.equal((await service(new UnavailableModel()).converse({ text: 'After admission-gap cancel' }, state(randomUUID()))).run.state, 'completed');
  });
  await t.test('cancellation before store/admission closes chat, fences late original and preserves reservation until no-dispatch proof', async () => {
    for (const mode of ['before_store', 'before_admit'] as const) {
      const f = await setup();
      const key = randomUUID();
      const text = 'Synthetic cancellation';
      const original = child({ mode, call: f.call, key, text });
      await original.paused;
      const pending = original.data();
      assert.ok(pending.turn);
      assert.ok(pending.call);
      const cancelled = await service(f.model).cancelRun(pending.turn.run_id, { reason: null }, state(randomUUID()));
      assert.equal(cancelled.state, 'cancelled');
      assert.equal((await turnFor(key)).state, 'completed');
      assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, mode === 'before_store' ? '0' : '7');
      assert.equal((await service(new UnavailableModel()).converse({ text: 'New conversation after cancel' }, state(randomUUID()))).run.state, 'completed');
      const recovered = await child({
        mode: 'recover',
        call: pending.call,
        key,
        text,
      }).done;
      assert.equal(recovered.outcome, 'refused');
      original.resume();
      assert.equal((await original.done).calls, 0);
      assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '0');
      assert.equal((await service(f.model).converse({ text }, state(key))).run.state, 'cancelled');
    }
  });
  await t.test('cancelled unknown effect keeps its hold; revoked governance/context and changed model recover only the original receipt', async () => {
    const f = await setup();
    const key = randomUUID();
    const text = 'Synthetic unknown effect';
    const invoke = adapter.invoke.bind(adapter);
    const reconcile = adapter.reconcile.bind(adapter);
    let calls = 0;
    let lookups = 0;
    let selected = 0;
    adapter.invoke = async () => {
      calls++;
      return { kind: 'unknown' };
    };
    try {
      await assert.rejects(service(f.model).converse({ text }, state(key)));
      const turn = await turnFor(key);
      await service(f.model).cancelRun(turn.run_id, { reason: null }, state(randomUUID()));
      assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '7');
      await w.a.as(w.personId, (trx) => mandates.narrow(trx, f.mandate.id, 1, 'revoked', 'Synthetic revoked context'));
      await w.a.cmd(w.personId, (trx, ctx) =>
        egressRules.set(trx, ctx, {
          connectionId: w.connection.id,
          dataClass: 'person_private',
          decision: 'deny',
          requireInResidency: true,
          requireZeroRetention: true,
          approvalId: null,
        }),
      );
      const restarted = createRuntimeAssistantModel(w.pool, registry, {
        async select() {
          selected++;
          throw new Error('Current context is unavailable');
        },
        async check() {
          throw new Error('Current governance is unavailable');
        },
      });
      adapter.reconcile = async (operationId, pin?: PinnedCandidate) => {
        lookups++;
        assert.equal(operationId, turn.id);
        assert.equal(pin!.modelRevision, 'synthetic-rev-1');
        return {
          kind: 'succeeded',
          text: 'Receipt text must not enter chat',
          costMinorUnits: '5',
          inputTokens: 1,
          outputTokens: 1,
        };
      };
      const recovered = await restarted.recover({
        ...input(turn),
        execution: { ...input(turn).execution!, hubId: null },
      });
      assert.equal(recovered!.text, null);
      assert.equal(calls, 1);
      assert.equal(lookups, 1);
      assert.equal(selected, 0);
      const balance = (await as((trx) => budgets.balance(trx, f.budget)))!;
      assert.equal(balance.heldMinor, '0');
      assert.equal(balance.consumedMinor, '5');
      const replay = await service(restarted).converse({ text }, state(key));
      assert.equal(replay.run.state, 'cancelled');
      assert.equal(replay.turns[1]!.role, 'system');
      assert.equal((await service(new UnavailableModel()).converse({ text: 'New after unknown cancellation' }, state(randomUUID()))).run.state, 'completed');
      const foreign = {
        ...input(turn),
        personId: w.world.people.officer,
        execution: {
          ...input(turn).execution!,
          principal: { ...principal, personId: w.world.people.officer },
          sessionId: w.world.sessions.officer,
        },
      };
      await assert.rejects(restarted.recover(foreign));
      await assert.rejects(
        restarted.recover({
          ...input(turn),
          execution: {
            ...input(turn).execution!,
            sessionId: w.world.sessions.officer,
          },
        }),
      );
      assert.equal(lookups, 1);
    } finally {
      adapter.invoke = invoke;
      adapter.reconcile = reconcile;
      await w.allowPrivate();
    }
  });
  await t.test('default unavailable restart fences a live sender before its model record exists', async () => {
    const f = await setup();
    const key = randomUUID();
    const text = 'Synthetic unavailable prepare gap';
    const original = child({
      mode: 'before_store',
      call: f.call,
      key,
      text,
    });
    await original.paused;
    const pending = original.data();
    assert.ok(pending.turn);
    const unavailable = service(new UnavailableModel());
    const old = await unavailable.converse({ text }, state(key));
    assert.equal(old.run.state, 'failed');
    assert.equal(old.run.id, pending.turn.run_id);
    original.resume();
    assert.equal((await original.done).calls, 0);
    assert.equal(await as((trx) => modelCalls.get(trx, pending.turn!.id)), undefined);
    assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '0');
    assert.equal((await unavailable.converse({ text: 'New after unavailable prepare gap' }, state(randomUUID()))).run.state, 'completed');
  });
  await t.test('default unavailable replacement finalizes pending unknown without releasing it and can replay the old command', async () => {
    const f = await setup();
    const key = randomUUID();
    const text = 'Synthetic unavailable restart';
    const invoke = adapter.invoke.bind(adapter);
    adapter.invoke = async () => ({ kind: 'unknown' });
    try {
      await assert.rejects(service(f.model).converse({ text }, state(key)));
    } finally {
      adapter.invoke = invoke;
    }
    const turn = await turnFor(key);
    const unavailable = service(new UnavailableModel());
    assert.equal((await unavailable.converse({ text: 'New default conversation' }, state(randomUUID()))).run.state, 'completed');
    const replay = await unavailable.converse({ text }, state(key));
    assert.equal(replay.run.id, turn.run_id);
    assert.equal(replay.run.state, 'failed');
    assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '7');
    assert.equal((await as((trx) => modelCalls.get(trx, turn.id)))!.state, 'outcome_unknown');
    assert.equal((await turnFor(key)).dispatch_closed, true);
    await assert.rejects(unavailable.converse({ text: 'Different command' }, state(key)));
    assert.equal(await createRuntimeAssistantModel(w.pool, registry).recover(input(turn)), null);
    assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.heldMinor, '7');
  });
  await t.test('lost reply after committed settlement recovers with default-deny policy, without duplicate call or charge', async () => {
    const f = await setup();
    const key = randomUUID();
    const text = 'Synthetic lost reply';
    const before = adapter.calls.length;
    const invoke = adapter.invoke.bind(adapter);
    adapter.invoke = async (i) => ({
      ...(await invoke(i)),
      kind: 'succeeded',
      text: 'Synthetic lost reply',
      costMinorUnits: '1',
      inputTokens: 1,
      outputTokens: 1,
    });
    const crashing: ModelPort = {
      provider: f.model.provider,
      async respond(i) {
        await f.model.respond(i);
        throw new Error('Synthetic lost reply');
      },
    };
    try {
      await assert.rejects(service(crashing).converse({ text }, state(key)));
    } finally {
      adapter.invoke = invoke;
    }
    const turn = await turnFor(key);
    assert.equal((await as((trx) => modelCalls.get(trx, turn.id)))!.state, 'succeeded');
    await w.a.as(w.personId, (trx) => mandates.narrow(trx, f.mandate.id, 1, 'revoked', 'Synthetic post-effect revocation'));
    const restarted = createRuntimeAssistantModel(w.pool, new FakeModelRegistry());
    const result = await service(restarted).converse({ text }, state(key));
    assert.equal(result.run.id, turn.run_id);
    assert.equal(result.turns[1]!.role, 'system');
    assert.equal(adapter.calls.length, before + 1);
    assert.deepEqual(await service(restarted).converse({ text }, state(key)), result);
    assert.equal((await as((trx) => budgets.balance(trx, f.budget)))!.consumedMinor, '1');
  });
  await t.test('late model tool reply cannot overwrite cancellation or append proposals/effects', async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late: ModelReply = {
      text: 'Late synthetic reply',
      messageKey: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [
        {
          kind: 'propose_backlog_item',
          title: 'Must not exist',
          proposal: {},
        },
      ],
    };
    const model: ModelPort = {
      provider: 'fake',
      async respond() {
        entered();
        await held;
        return late;
      },
    };
    const key = randomUUID();
    const text = 'Synthetic late response';
    const running = service(model).converse({ text }, state(key));
    await ready;
    const turn = await turnFor(key);
    await service(model).cancelRun(turn.run_id, { reason: null }, state(randomUUID()));
    release();
    const result = await running;
    assert.equal(result.run.state, 'cancelled');
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.proposals, []);
    assert.equal((await as((trx) => trx.selectFrom('service_backlog_item').selectAll().where('source_run_id', '=', turn.run_id).execute())).length, 0);
    assert.equal((await as((trx) => trx.selectFrom('conversation_turn').selectAll().where('run_id', '=', turn.run_id).execute())).length, 2);
    assert.equal((await as((trx) => trx.selectFrom('run_step').selectAll().where('run_id', '=', turn.run_id).execute())).length, 0);
    assert.equal((await service(new UnavailableModel()).converse({ text: 'Next after late response' }, state(randomUUID()))).run.state, 'completed');
  });
  await t.test('failed runs and replacement without recover are locally finalizable without model calls', async () => {
    for (const failed of [true, false]) {
      const f = await setup();
      const key = randomUUID();
      const text = 'Synthetic terminal recovery';
      const crashed = await child({
        mode: 'prepare_die',
        call: f.call,
        key,
        text,
      }).done;
      assert.ok(crashed.turn);
      if (failed) await as((trx) => runs.setState(trx, crashed.turn!.run_id, 'failed'));
      let invoked = false;
      const replacement: ModelPort = {
        provider: 'fake',
        async respond() {
          invoked = true;
          throw new Error('Must not run');
        },
      };
      const result = await service(replacement).converse({ text }, state(key));
      assert.equal(result.run.state, 'failed');
      assert.equal(invoked, false);
      assert.equal((await turnFor(key)).state, 'completed');
      assert.equal((await service(new UnavailableModel()).converse({ text: 'New after failure' }, state(randomUUID()))).run.state, 'completed');
    }
  });
});
