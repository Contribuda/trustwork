import assert from 'node:assert/strict';
import { installSyntheticServingHub } from '../../agent-modules/serving-fixture.js';
import { syntheticEffectImplementations, installSyntheticOrderManifest, SYNTHETIC_ORDER_MANIFEST, installSyntheticHumanManifest, SYNTHETIC_HUMAN_MANIFEST } from '../../assistant/manifest-fixture.js';
import { CapabilityAuthority, agentRuntimeGate } from '../../../apps/api/src/modules/agent-modules/authority.js';
import { ENGINE_MANIFESTS } from '../../../apps/api/src/modules/agent-modules/ports.js';
import type { AuthorizedEvidence } from '@trustwork/contracts';
import { HandlerRegistry, silentLogger, Worker } from '@trustwork/worker';
import { fakeEffectProviders, registerAssistant, type AssistantRuntime, type FakeEffectProvider } from '../../../apps/worker/src/assistant/index.js';
import { AssistantService, DEFAULT_RUNTIME_SETTINGS } from '../../../apps/api/src/modules/assistant/assistant.service.js';
import { assistantPolicySettings } from '../../../apps/api/src/modules/assistant/assistant.module.js';
import { assertShareable } from '../../../apps/api/src/modules/assistant/policy.js';
import { FakeRetrieval, ScriptedModel, UnavailableModel, UnavailableRetrieval, type ModelPort } from '../../../apps/api/src/modules/assistant/ports.js';
import type { RetrievalPort } from '../../../apps/api/src/modules/assistant/ports.js';
import { startHarness, type Client } from '../../backend/helpers/app.js';
import { login, seedPersonas, type PersonaKey } from '../../backend/helpers/personas.js';
import { personalBudget, stateOf, workerLogin } from '../../assistant/helpers.js';
import { mandateDraft, type EffectRecord, type IntentRow, type MandateRef, type RuntimeContext, type RuntimeParty, type RuntimeProvider, type TurnResult } from './harness.js';

/**
 * The runtime side of the harness: the AST-001 assistant service with the scripted model and the fake retrieval, the
 * worker with the fake effect providers (orders, payments, channel messages), on a fresh local PostgreSQL database.
 * Nothing leaves the machine: no model, retrieval, order, payment or channel provider is real.
 */

const STEP_UP_REFRESH_MS = 8 * 60_000;

interface Party { key: PersonaKey; personId: string; client: Client; loggedInAt: number }

export interface StartedRuntime extends RuntimeProvider {
  close(): Promise<void>;
}

export async function startRuntime(label = 'agent_safety'): Promise<StartedRuntime | null> {
  const h = await startHarness(label);
  if (!h) return null;
  await installSyntheticServingHub(h);
  await installSyntheticOrderManifest(h);
  await installSyntheticHumanManifest(h);
  const worker = await workerLogin(h);
  const seed = await seedPersonas(h);
  const providers = fakeEffectProviders();
  const runtime: AssistantRuntime = { pool: worker.pool(6), providers: providers.all, implementations: syntheticEffectImplementations(providers.all), hubId: null, log: silentLogger };
  const w = new Worker({ pool: runtime.pool, registry: registerAssistant(new HandlerRegistry(), runtime), config: { workerId: 'agent-safety', leaseSeconds: 30, retryJitter: 0 }, tasks: () => [] });
  const fakes = providers.all as FakeEffectProvider[];
  const effectsSince = (marks: readonly number[] = []): EffectRecord[] =>
    fakes.flatMap((p, i) => p.submissions.slice(marks[i] ?? 0).map((s) => ({ provider: p.name, correlationKey: s.correlationKey, operation: s.operation, payload: s.payload, amount: s.amount })));
  const allEffects = () => effectsSince();

  const parties = new Map<PersonaKey, Party>();
  async function party(key: PersonaKey): Promise<Party> {
    let p = parties.get(key);
    if (!p) {
      const client = h!.client();
      await login(client, key);
      p = { key, personId: seed.people[key], client, loggedInAt: Date.now() };
      parties.set(key, p);
    } else if (Date.now() - p.loggedInAt > STEP_UP_REFRESH_MS) {
      await login(p.client, key);
      p.loggedInAt = Date.now();
    }
    return p;
  }

  // Idle means two consecutive passes in which the runner leased nothing and the relay published nothing: an effect
  // enqueued through the outbox after one empty pass (a loaded CI runner) is still drained. A job that failed with a
  // retryable error (for example a serialization conflict between two dispatches on a loaded runner) waits for its
  // backoff of 5 seconds or more; the scenarios judge outcomes, not timing (the backoff itself is covered by the worker
  // tests), so the harness makes such retries due now instead of declaring the worker idle with work still queued.
  async function drain(): Promise<void> {
    let quiet = 0;
    for (let i = 0; i < 100; i++) {
      const leased = await w.runner.tick();
      await w.idle();
      const relayed = await w.relay.relayOnce();
      quiet = leased === 0 && relayed === 0 ? quiet + 1 : 0;
      if (quiet === 2) {
        const due = await h!.db.admin.query("UPDATE trustwork.job SET next_at = now() WHERE state = 'queued' AND next_at > now()");
        if (!due.rowCount) return;
        quiet = 0;
        continue;
      }
      if (quiet === 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the worker did not become idle');
  }

  let requests = 0;
  async function runtimeParty(p: Party, scenarioId: string): Promise<RuntimeParty> {
    const created = await p.client.post('/v1/projects', { owner: { kind: 'person', id: p.personId }, name: `Safety ${scenarioId}`.slice(0, 120), summary: null, leaderPersonId: null });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = (created.body as { id: string }).id;
    return {
      personId: p.personId,
      projectId,
      async mandate(spec) {
        const draft = mandateDraft({ contexts: [{ kind: 'project', id: projectId }], ...spec });
        const r = await p.client.post('/v1/assistant/mandates', { draft });
        assert.equal(r.status, 201, `mandate confirmation failed: ${JSON.stringify(r.body)}`);
        const body = r.body as MandateRef;
        return { id: body.id, revision: body.revision };
      },
      budget: (kind, limitMinor) => personalBudget(h!, p.personId, kind, limitMinor),
    };
  }

  async function assertNoUnauthorizedEffects(): Promise<void> {
    for (const effect of allEffects()) {
      const { rows } = await h!.db.admin.query<{
        state: string; ask_reasons: string[]; action_digest: string; mandate_revision: number; principal_person_id: string; mandate_principal: string; confirmed: boolean; effect: { provider: string; operation: string; payload: unknown } | null; approvals: number;
      }>(
        `SELECT ai.state, ai.ask_reasons, ai.action_digest, ai.mandate_revision, ai.principal_person_id, m.principal_person_id AS mandate_principal,
                (m.snapshot->'confirmation') IS NOT NULL AND m.snapshot->'confirmation' <> 'null'::jsonb AS confirmed, ai.effect,
                (SELECT count(*)::int FROM trustwork.approval a WHERE a.action_intent_id = ai.id AND a.action_digest = ai.action_digest AND a.mandate_revision = ai.mandate_revision AND a.approver_person_id = ai.principal_person_id) AS approvals
           FROM trustwork.action_intent ai JOIN trustwork.mandate m ON m.id = ai.mandate_id WHERE ai.effect_correlation_key = $1`,
        [effect.correlationKey],
      );
      const row = rows[0];
      assert.ok(row, `effect ${effect.provider}/${effect.operation} has no action intent`);
      assert.ok(row.confirmed, 'effect under a mandate without first-party confirmation');
      assert.equal(row.principal_person_id, row.mandate_principal, 'effect under another person\'s mandate');
      assert.notEqual(row.state, 'proposed', 'effect of an action still waiting for the person');
      if (row.ask_reasons.length > 0) assert.ok(row.approvals >= 1, `effect of an asked action (${row.ask_reasons.join(',')}) without an approval bound to its digest`);
      assert.ok(row.effect, 'effect without a recorded structured effect');
      assert.equal(row.effect.provider, effect.provider, 'provider differs from the authorized effect');
      assert.deepEqual(effect.payload, row.effect.payload, 'payload differs from the authorized effect');
      assertShareable(effect.payload);
    }
  }

  return {
    async forScenario(id: string): Promise<RuntimeContext> {
      const me = await party('petr');
      const them = await party('anna');
      const self = await runtimeParty(me, id);
      const other = await runtimeParty(them, id);
      const marks = fakes.map((p) => p.submissions.length);
      const model = new ScriptedModel();
      let retrieval: RetrievalPort = new FakeRetrieval([]);
      let activeModel: ModelPort = model;
      const service = () => new AssistantService(h!.created.ctx!, h!.services().principals, assistantPolicySettings({ hubId: null }), DEFAULT_RUNTIME_SETTINGS, activeModel, retrieval, agentRuntimeGate(new CapabilityAuthority({ hubId: null, manifests: [...ENGINE_MANIFESTS, SYNTHETIC_ORDER_MANIFEST, SYNTHETIC_HUMAN_MANIFEST] })));
      const intentColumns = 'id, state, ask_reasons, mandate_id, mandate_revision, action_digest, reservation_id, effect_correlation_key';
      return {
        ...self,
        other,
        model,
        setEvidence(items: readonly AuthorizedEvidence[]) {
          retrieval = new FakeRetrieval(items);
        },
        useUnavailableProviders() {
          activeModel = new UnavailableModel();
          retrieval = new UnavailableRetrieval();
        },
        async turn(text, ...replies): Promise<TurnResult> {
          for (const r of replies) model.push(r);
          const result = await service().converse({ text }, await stateOf(h!, me.client, `req-safety-${++requests}`));
          const answer = result.turns[1]!;
          return {
            runId: result.run.id,
            actions: result.actions,
            proposals: result.proposals.map((p) => ({ id: p.id, status: p.status, digest: p.digest })),
            citations: result.citations,
            replyRole: answer.role,
            replyContent: answer.content,
          };
        },
        async intent(intentId) {
          const { rows } = await h!.db.admin.query<IntentRow>(`SELECT ${intentColumns} FROM trustwork.action_intent WHERE id = $1`, [intentId]);
          assert.ok(rows[0], `intent ${intentId} not found`);
          return rows[0];
        },
        async intentsOfRun(runId) {
          return (await h!.db.admin.query<IntentRow>(`SELECT ${intentColumns} FROM trustwork.action_intent WHERE run_id = $1 ORDER BY created_at`, [runId])).rows;
        },
        async mandateRow(mandateId) {
          const { rows } = await h!.db.admin.query<{ revision: number; status: string; snapshot: unknown }>('SELECT revision, status, snapshot FROM trustwork.mandate WHERE id = $1', [mandateId]);
          assert.ok(rows[0], `mandate ${mandateId} not found`);
          return rows[0];
        },
        async proposal(proposalId) {
          const { rows } = await h!.db.admin.query<{ status: string; proposed: unknown }>('SELECT status, proposed FROM trustwork.mandate_proposal WHERE id = $1', [proposalId]);
          assert.ok(rows[0], `proposal ${proposalId} not found`);
          return rows[0];
        },
        async decisions() {
          const r = await me.client.get('/v1/assistant/decisions');
          assert.equal(r.status, 200);
          return (r.body as { decisions: { id: string; actionDigest: { algorithm: string; value: string }; askReasons: string[] }[] }).decisions;
        },
        async approve(intentId, digest) {
          const r = await me.client.post(`/v1/assistant/decisions/${intentId}/approve`, { digest });
          return { status: r.status, code: (r.body as { code?: string } | null)?.code ?? null };
        },
        async engageStop() {
          const r = await me.client.post('/v1/assistant/stop');
          assert.equal(r.status, 200, JSON.stringify(r.body));
        },
        async releaseStop() {
          const r = await me.client.post('/v1/assistant/stop/release');
          assert.equal(r.status, 200, JSON.stringify(r.body));
        },
        drain,
        newEffects: () => effectsSince(marks),
        sessionToken: () => me.client.sessionCookie ?? '',
        assertNoUnauthorizedEffects,
      };
    },
    async close() {
      await worker.close();
      await h.close();
    },
  };
}

