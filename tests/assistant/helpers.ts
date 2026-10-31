import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createPool, withPrincipal, type DataPool, type Transaction } from '@trustwork/data';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { AssistantService, DEFAULT_RUNTIME_SETTINGS } from '../../apps/api/src/modules/assistant/assistant.service.js';
import { assistantPolicySettings } from '../../apps/api/src/modules/assistant/assistant.module.js';
import { AssistantMandateStore } from '../../apps/api/src/modules/assistant/mandate-store.js';
import { FakeRetrieval, ScriptedModel } from '../../apps/api/src/modules/assistant/ports.js';
import type { MandateDraft } from '../../apps/api/src/modules/assistant/schemas.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { WORKER_ROLE } from '../../packages/data/src/config.js';
import { principalFor } from '../data/helpers/seed.js';
import type { Client, Harness, Response } from '../backend/helpers/app.js';

export const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
export const UNTIL = '2027-12-31T00:00:00.000Z';

export function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

/** A first-party mandate draft for the person's own agent (the server adds id, principal, revision and confirmation). */
export function draft(over: Partial<MandateDraft> & Pick<MandateDraft, 'moduleKeys' | 'actions' | 'contexts'>): MandateDraft {
  return {
    onBehalfOf: null, grantee: { kind: 'own_agent' }, limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null },
    conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [], escalation: { kind: 'ask_principal' }, validUntil: UNTIL, ...over,
  };
}

export interface MandateView { id: string; revision: number; status: string; digest: { value: string } | null; mandate: { limits: unknown; actions: string[] } }
export interface IntentView { id: string; state: string; actionDigest: { algorithm: string; value: string }; askReasons: string[]; origin: string; amount: unknown }

/** Request state of a signed-in client, for calling services directly (same as the module tests). */
export async function stateOf(h: Harness, client: Client, requestId: string): Promise<RequestState> {
  const token = client.sessionCookie as string;
  const resolved = await h.services().principals.resolve(token);
  assert.ok(resolved);
  return { requestId, principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
}

export function as<T>(h: Harness, personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> {
  return principalFor(h.db.admin, personId).then((p) => withPrincipal(h.pool, p, fn));
}

/** A personal budget of the person (BILL-001 definer, inside their own principal transaction). */
export function personalBudget(h: Harness, personId: string, kind: 'transaction' | 'platform', limitMinor: string): Promise<string> {
  return as(h, personId, (trx) => budgets.grant(trx, { kind, owner: 'person', projectId: null, employeePersonId: null, periodFrom: new Date(Date.now() - 3600_000), periodTo: new Date(Date.now() + 365 * 86400_000), limitMinor, currency: 'USD' }));
}

export function assistantService(h: Harness, model = new ScriptedModel(), retrieval = new FakeRetrieval([])): { service: AssistantService; model: ScriptedModel; retrieval: FakeRetrieval } {
  const service = new AssistantService(h.created.ctx!, h.services().principals, assistantPolicySettings({ hubId: null }), DEFAULT_RUNTIME_SETTINGS, model, retrieval);
  return { service, model, retrieval };
}
export function mandateStore(h: Harness): AssistantMandateStore {
  return new AssistantMandateStore(h.pool, assistantPolicySettings({ hubId: null }), h.clock);
}

/** A login that is a member of trustwork_worker only, on the harness database (several simulated worker processes). */
export async function workerLogin(h: Harness): Promise<{ pool(max?: number): DataPool; close(): Promise<void> }> {
  const role = `trustwork_worker_test_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await h.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT IN ROLE ${WORKER_ROLE}`);
  const url = `postgresql://${role}:${password}@${String(h.db.appConfig.host)}:${Number(h.db.appConfig.port)}/${h.db.databaseName}`;
  const pools: DataPool[] = [];
  return {
    pool(max = 4) {
      const pool = createPool({ connectionString: url, max });
      pools.push(pool);
      return pool;
    },
    async close() {
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
      await h.db.admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    },
  };
}

interface PgError { code?: string; hint?: string; message?: string }
export async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}
