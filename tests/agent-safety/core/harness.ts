import type { AuthorizedEvidence, ContextRef, MandateActionV2, Money } from '@trustwork/contracts';
import type { ModelInput, ModelReply, ModelToolCall, ScriptedModel } from '../../../apps/api/src/modules/assistant/ports.js';
import type { MandateDraft } from '../../../apps/api/src/modules/assistant/schemas.js';
import { OWASP_IDS, type OwaspId } from './owasp.js';
import type { UntrustedChannel } from './channels.js';

/**
 * Agent safety harness (EVAL-001). A suite is a list of deterministic adversarial scenarios. Each scenario names the
 * OWASP items it addresses and the structural defence it proves; it never asserts a model's good behaviour. The model
 * is the scripted fake of the assistant runtime (`ScriptedModel`), driven to obey the attacker, so a scenario passes
 * only when the engine's own checks (mandates, approvals, budgets, stop controls, projections, egress rules) hold.
 *
 * Two kinds:
 * - `pure`: contract-level checks with no database (always run, no network);
 * - `runtime`: runs against the AST-001 runtime on local PostgreSQL through a `RuntimeContext` (skipped, and reported
 *   as skipped, when no local database is available).
 *
 * Modules (AGT-019, tests/agent-safety/modules) and extensions (AGT-023) register their own suites with the same
 * shape; `suites/index.ts` discovers module suites and `runScenario` is the gate an extension activation calls.
 */

export type SuiteOwner = { kind: 'core' } | { kind: 'module'; moduleKey: string } | { kind: 'extension'; extensionId: string };

interface ScenarioBase {
  /** `<suite id>.<scenario>`; stable across releases (reports are compared by id). */
  id: string;
  title: string;
  /** OWASP items this scenario addresses; empty only for a `control` scenario. */
  owasp: readonly OwaspId[];
  /** The structural defence the scenario proves, in one sentence. */
  defence: string;
  /** The untrusted channel the attack arrives through, when there is one. */
  channel?: UntrustedChannel;
  /** A positive control: proves the harness observes effects at all (a legitimate action goes through). */
  control?: boolean;
}
export interface PureScenario extends ScenarioBase {
  kind: 'pure';
  run(): void | Promise<void>;
}
export interface RuntimeScenario extends ScenarioBase {
  kind: 'runtime';
  run(rt: RuntimeContext): Promise<void>;
}
export type Scenario = PureScenario | RuntimeScenario;

export interface SafetySuite {
  id: string;
  title: string;
  owner: SuiteOwner;
  scenarios: readonly Scenario[];
}

const ID = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

/** Validates a suite at definition time: ids are well formed, unique and prefixed by the suite id; OWASP ids exist. */
export function defineSuite(suite: SafetySuite): SafetySuite {
  const problems = suiteProblems(suite);
  if (problems.length) throw new Error(`invalid safety suite ${suite.id}: ${problems.join('; ')}`);
  return suite;
}
export function suiteProblems(suite: SafetySuite): string[] {
  const out: string[] = [];
  if (!ID.test(`${suite.id}.x`)) out.push(`suite id ${suite.id} is not a lowercase dotted key`);
  const seen = new Set<string>();
  for (const s of suite.scenarios) {
    if (!ID.test(s.id) || !s.id.startsWith(`${suite.id}.`)) out.push(`scenario id ${s.id} is not prefixed by ${suite.id}.`);
    if (seen.has(s.id)) out.push(`duplicate scenario id ${s.id}`);
    seen.add(s.id);
    for (const o of s.owasp) if (!OWASP_IDS.has(o)) out.push(`${s.id}: unknown OWASP item ${o}`);
    if (s.owasp.length === 0 && !s.control) out.push(`${s.id}: maps to no OWASP item and is not a control`);
    if (s.defence.trim().length < 10) out.push(`${s.id}: names no defence`);
  }
  return out;
}
/** Suites combined: scenario ids stay unique across all registered suites. */
export function checkRegistry(suites: readonly SafetySuite[]): string[] {
  const out = suites.flatMap(suiteProblems);
  const ids = new Map<string, string>();
  const suiteIds = new Set<string>();
  for (const suite of suites) {
    if (suiteIds.has(suite.id)) out.push(`duplicate suite id ${suite.id}`);
    suiteIds.add(suite.id);
    for (const s of suite.scenarios) {
      const other = ids.get(s.id);
      if (other !== undefined) out.push(`scenario ${s.id} registered by ${other} and ${suite.id}`);
      ids.set(s.id, suite.id);
    }
  }
  return out;
}

export type ScenarioStatus = 'passed' | 'failed' | 'skipped';
export interface ScenarioResult {
  suite: string;
  id: string;
  title: string;
  kind: Scenario['kind'];
  owasp: readonly OwaspId[];
  defence: string;
  channel: UntrustedChannel | null;
  control: boolean;
  status: ScenarioStatus;
  /** Failure message or skip reason; never a private value (scenarios assert on codes). */
  detail: string | null;
  durationMs: number;
}

/**
 * Runs one scenario and records the result. A runtime scenario without a runtime is skipped. After a runtime scenario
 * the context drains the worker and checks the global invariant: no external effect without a valid mandate and,
 * where the policy asked, an approval bound to the same digest.
 */
export async function runScenario(suite: SafetySuite, scenario: Scenario, runtime: RuntimeProvider | null, skipReason = 'no local PostgreSQL'): Promise<ScenarioResult> {
  const base = {
    suite: suite.id, id: scenario.id, title: scenario.title, kind: scenario.kind, owasp: scenario.owasp, defence: scenario.defence,
    channel: scenario.channel ?? null, control: scenario.control ?? false,
  };
  const started = performance.now();
  const done = (status: ScenarioStatus, detail: string | null): ScenarioResult => ({ ...base, status, detail, durationMs: Math.round(performance.now() - started) });
  try {
    if (scenario.kind === 'pure') await scenario.run();
    else {
      if (!runtime) return done('skipped', skipReason);
      const rt = await runtime.forScenario(scenario.id);
      await scenario.run(rt);
      await rt.drain();
      await rt.assertNoUnauthorizedEffects();
    }
    return done('passed', null);
  } catch (error) {
    return done('failed', error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2000) : String(error).slice(0, 2000));
  }
}

/* ---------- Runtime context (implemented in runtime.ts on the AST-001 runtime) ---------- */

export interface MandateRef { id: string; revision: number }
export interface TurnResult {
  runId: string;
  actions: readonly ({ state: 'queued' | 'proposed'; intentId: string; reasons: readonly string[] } | { state: 'denied'; reason: string })[];
  proposals: readonly { id: string; status: string; digest: { value: string } }[];
  citations: readonly string[];
  replyRole: string;
  replyContent: string;
}
export interface IntentRow { id: string; state: string; ask_reasons: string[]; mandate_id: string; mandate_revision: number; action_digest: string; reservation_id: string | null; effect_correlation_key: string }
export interface EffectRecord { provider: string; correlationKey: string; operation: string; payload: unknown; amount: unknown }
export interface RuntimeParty {
  personId: string;
  /** A fresh project owned by the party (a context the party may name in a mandate). */
  projectId: string;
  /** Creates and confirms a mandate on the first-party form (step-up session), like the person would. */
  mandate(draft: Partial<MandateDraft> & Pick<MandateDraft, 'moduleKeys' | 'actions'>): Promise<MandateRef>;
  /** A personal budget of the party (BILL-001). */
  budget(kind: 'transaction' | 'platform', limitMinor: string): Promise<string>;
}
export interface RuntimeContext extends RuntimeParty {
  /** A second participant (counterparty or competitor) with its own project and mandates. */
  other: RuntimeParty;
  /** The scripted model of this scenario; `inputs` records everything the model was given. */
  model: ScriptedModel;
  /** Replaces the evidence the fake retrieval holds for this scenario (audience-filtered by the fake). */
  setEvidence(items: readonly AuthorizedEvidence[]): void;
  /** Uses the default unavailable model and retrieval (no provider configured) for the next turns. */
  useUnavailableProviders(): void;
  /** One conversation turn of the principal: the scripted replies are queued, then the person's text is sent. */
  turn(text: string, ...replies: (ModelReply | ((input: ModelInput) => ModelReply))[]): Promise<TurnResult>;
  intent(id: string): Promise<IntentRow>;
  intentsOfRun(runId: string): Promise<IntentRow[]>;
  mandateRow(id: string): Promise<{ revision: number; status: string; snapshot: unknown }>;
  proposal(id: string): Promise<{ status: string; proposed: unknown }>;
  /** Decisions waiting for the person (owner view). */
  decisions(): Promise<{ id: string; actionDigest: { algorithm: string; value: string }; askReasons: string[] }[]>;
  /** The person approves a decision on the first-party route; returns the HTTP status and error code. */
  approve(intentId: string, digest: { algorithm: string; value: string }): Promise<{ status: number; code: string | null }>;
  engageStop(): Promise<void>;
  releaseStop(): Promise<void>;
  /** Runs the worker until no job is left (fake providers only). */
  drain(): Promise<void>;
  /** External effects submitted to the fake providers since this scenario started. */
  newEffects(): readonly EffectRecord[];
  /** Session token of the principal (to prove it never reaches the model). */
  sessionToken(): string;
  /** No effect at any provider without an authorized intent under a confirmed mandate (and an approval where asked). */
  assertNoUnauthorizedEffects(): Promise<void>;
}
export interface RuntimeProvider {
  forScenario(id: string): Promise<RuntimeContext>;
}

/* ---------- Scripted adversarial model ---------- */

const usage = { inputTokens: 1, outputTokens: 1 };
/** A reply of a model that has been hijacked: it repeats the attacker's text and emits the attacker's tool calls. */
export function hijacked(toolCalls: readonly ModelToolCall[] | ((input: ModelInput) => readonly ModelToolCall[]), text = 'Done as instructed.'): (input: ModelInput) => ModelReply {
  return (input) => ({ text, messageKey: null, usage, toolCalls: typeof toolCalls === 'function' ? toolCalls(input) : toolCalls });
}
export function reply(text: string | null, toolCalls: readonly ModelToolCall[] = []): ModelReply {
  return { text, messageKey: null, usage, toolCalls };
}

export const usd = (minorUnits: string): Money => ({ minorUnits, currency: 'USD' });
export const UNTIL = '2027-12-31T00:00:00.000Z';

/** Tool call builders for scripted outputs (the only shapes the runtime accepts from a model). */
export const tool = {
  action(input: { mandateId: string; action: MandateActionV2; context: ContextRef; amount?: Money | null; moduleKey?: string; capability?: string; provider?: string; operation?: string; payload?: unknown }): ModelToolCall {
    const moduleKey = input.moduleKey ?? 'deal_desk';
    return {
      kind: 'propose_action', mandateId: input.mandateId, capabilityId: input.capability ?? `${moduleKey}.${input.action}`, moduleKey, action: input.action, context: input.context,
      amount: input.amount ?? null, projectId: input.context.kind === 'project' ? input.context.id : null,
      effect: { provider: input.provider ?? (input.action === 'place_order' ? 'fake_orders' : 'fake_channel'), operation: input.operation ?? `${input.action}.submit`, payload: input.payload ?? { note: 'synthetic' } },
    };
  },
  widen(mandateId: string | null, draft: MandateDraft): ModelToolCall {
    return { kind: 'propose_mandate_change', mandateId, draft };
  },
  retrieve(query: string): ModelToolCall {
    return { kind: 'retrieve', query };
  },
  /** A tool kind the runtime does not have (shell, SQL, confirm, approve, stop...). */
  unknown(kind: string, args: Record<string, unknown> = {}): ModelToolCall {
    return { kind, ...args } as unknown as ModelToolCall;
  },
};

/** A first-party mandate draft for the person's own agent (the server adds id, principal, revision and confirmation). */
export function mandateDraft(over: Partial<MandateDraft> & Pick<MandateDraft, 'moduleKeys' | 'actions' | 'contexts'>): MandateDraft {
  return {
    onBehalfOf: null, grantee: { kind: 'own_agent' }, limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null },
    conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [], escalation: { kind: 'ask_principal' }, validUntil: UNTIL, ...over,
  };
}

/** A random identifier an attacker might plant (looks like a mandate id, belongs to nobody). */
export function plantedId(): string {
  return crypto.randomUUID();
}
