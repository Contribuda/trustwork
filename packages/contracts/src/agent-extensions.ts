import { z } from 'zod';
import {
  BUDGET_KIND_BY_ACTION, CapabilityConfirmationSchema, capabilityViolations, ContextKindV2Schema, HUMAN_ONLY_ACTIONS, MandateActionV2Schema, MeterSchema, PrivateDataClassSchema, SideEffectSchema,
  type AgentCapability, type AgentModuleManifest, type CapabilityConfirmation, type MandateActionV2,
} from './agent-catalog.js';
import { DigestSchema, Sha256HexSchema } from './common/digest-schema.js';
import { IdSchema, RevisionSchema, TimestampSchema } from './common/ids.js';
import { compareMoney, NonNegativeMoneySchema, type Money } from './common/money.js';
import {
  AgentExtensionStatusSchema, AgentExtensionVersionRefSchema, AgentModuleKeySchema, consoleCommand, LocalizedNameSchema, ModelJobSchema, type AgentExtensionVersionRef,
} from './hub.js';
import { DataClassSchema } from './retrieval.js';

/**
 * Governed extension registry (AGT-023, ADR 010 decisions 22 and 25): how a hub administrator adds functions, tools,
 * integrations and capabilities to the participant's one agent without ever bypassing a mandate, a budget, a kill
 * switch, a privacy rule, the restricted-places list or the rule that untrusted text never issues commands.
 *
 * An extension is one more ability of the participant's agent, never a separate agent:
 *
 * - its key is its own module key, so a mandate covers it only when the person confirmed that key: no existing mandate
 *   and no extension version can widen what a person already confirmed;
 * - every action names a mandate kind, and each action is an AGT-002 capability with an `extension` source, so
 *   `capabilityViolations`, the shared authority check, the mandate policy, the budget reservation, approvals and the
 *   kill switches apply to it exactly as to a built-in action;
 * - a confirmation policy may never be weaker than the strongest built-in action of the same mandate kind
 *   (`confirmationFloor`);
 * - its data classes, endpoints, cost, adapter and fake, safety suite and extension-scoped model route are declared in a
 *   strict manifest that has no key to disable any of the above. `EXTENSION_MANIFEST_KEYS` is the closed vocabulary; the
 *   database repeats it for any writer that bypasses the API.
 *
 * Lifecycle `draft -> tested -> active -> suspended -> retired`: `tested` comes only from a passing safety suite on the
 * fake adapter, recorded by the worker and never stated by staff; `active` comes only from a hub configuration version of
 * domain `agent_extensions` under the `agents.activate_extension` second-person approval. Whatever an adapter returns is
 * untrusted data: `ExtensionCallOutputSchema` has no field that could carry a command, and the runtime keeps only its
 * digest.
 *
 * The database (packages/data/migrations/agent-extensions) is the authority for every rule; these functions let the API
 * and the console explain a refusal before it happens, and the tests compare both.
 */

export const AGENT_EXTENSIONS_CONTRACT_VERSION = 1 as const;

const uniq = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;
export type AgentExtensionStatus = z.infer<typeof AgentExtensionStatusSchema>;

/* ---------- Manifest ---------- */

/** The extension's key is its module key: capability ids are `<key>.<operation>` and a mandate names the key. */
export const ExtensionKeySchema = AgentModuleKeySchema;
export const ExtensionOperationSchema = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const AdapterIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const HostSchema = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

/** Hostname of an external endpoint (no scheme, no path), with the country it is served from and, when known, the region. */
export const ExtensionEndpointSchema = z.strictObject({
  host: HostSchema,
  country: z.string().regex(/^[A-Z]{2}$/),
  region: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/).nullable(),
}).refine((e) => e.region === null || e.region.startsWith(`${e.country}-`), { message: 'the region lies in the country', path: ['region'] });
export type ExtensionEndpoint = z.infer<typeof ExtensionEndpointSchema>;

/** One structured input of an action. Anything else in a call payload is refused (`extensionInputViolations`). */
export const ExtensionInputFieldSchema = z.strictObject({
  name: z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/),
  type: z.enum(['text', 'integer', 'boolean']),
  required: z.boolean(),
  maxLength: z.int().min(1).max(4000).nullable(),
}).refine((f) => (f.type === 'text') === (f.maxLength !== null), { message: 'text inputs and only text inputs state a maximum length', path: ['maxLength'] });
export type ExtensionInputField = z.infer<typeof ExtensionInputFieldSchema>;

/**
 * What one call costs. A charge is reserved from the mandate's budget like any metered step, so a charged action needs a
 * mandate kind that spends a budget, and it names the metered price version it charges under (AGT-004).
 */
export const ExtensionCostSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('per_call'), amount: NonNegativeMoneySchema, meter: MeterSchema, priceVersionId: IdSchema }),
]);
export type ExtensionCost = z.infer<typeof ExtensionCostSchema>;

/** `read` needs no mandate and `govern` is never delegated, so an extension action is a `draft` or a `commit`. */
export const ExtensionActionKindSchema = z.enum(['draft', 'commit']);
export const ExtensionActionSchema = z.strictObject({
  operation: ExtensionOperationSchema,
  title: LocalizedNameSchema,
  kind: ExtensionActionKindSchema,
  /** The mandate kind the action runs under, like a built-in action. An action without one is rejected. */
  mandateKind: MandateActionV2Schema,
  confirmation: CapabilityConfirmationSchema,
  contextKinds: z.array(ContextKindV2Schema).min(1).max(ContextKindV2Schema.options.length),
  inputs: z.array(ExtensionInputFieldSchema).max(30),
  dataClassesRead: z.array(DataClassSchema),
  dataClassesSent: z.array(DataClassSchema),
  privateDataClasses: z.array(PrivateDataClassSchema),
  sideEffects: z.array(SideEffectSchema).min(1),
  /** Hosts of `endpoints` this action calls. */
  endpointHosts: z.array(HostSchema).max(20),
  cost: ExtensionCostSchema,
  /** Only drafts may read untrusted text (files, mail, web pages, other agents' notes). */
  acceptsUntrustedText: z.boolean(),
});
export type ExtensionAction = z.infer<typeof ExtensionActionSchema>;

const ManifestShape = z.strictObject({
  schemaVersion: z.literal(AGENT_EXTENSIONS_CONTRACT_VERSION),
  key: ExtensionKeySchema,
  title: LocalizedNameSchema,
  actions: z.array(ExtensionActionSchema).min(1).max(50),
  /** Every mandate kind a person must confirm to use this extension: exactly those of its actions. */
  requiredMandateKinds: z.array(MandateActionV2Schema).min(1),
  endpoints: z.array(ExtensionEndpointSchema).max(20),
  /** The adapter that reaches the endpoints and its fake; tests and dry runs only ever call the fake. */
  adapter: z.strictObject({ adapterId: AdapterIdSchema, fakeAdapterId: AdapterIdSchema }),
  /** The suite the worker runs on the fake adapter (EVAL-001 harness shape) before activation and after an engine update. */
  safetySuite: z.strictObject({ suiteId: z.string().regex(/^extension\.[a-z][a-z0-9_]{1,40}$/) }),
  /** The extension-scoped model route (KEYS-001): the job it serves; the route itself is scoped to this extension's id. */
  route: z.strictObject({ job: ModelJobSchema }),
});
export type AgentExtensionManifest = z.infer<typeof ManifestShape>;

/**
 * The whole vocabulary of a manifest at any depth, apart from the locale tags under `title`. There is deliberately no key
 * here that could disable mandates, the person's confirmation, sanctions gates, restricted places or payment neutrality;
 * the database refuses every other key (`agent_extensions_manifest_keys`).
 */
export const EXTENSION_MANIFEST_KEYS = [
  'acceptsUntrustedText', 'actions', 'adapter', 'adapterId', 'amount', 'confirmation', 'contextKinds', 'cost', 'country', 'currency', 'dataClassesRead', 'dataClassesSent', 'endpointHosts',
  'endpoints', 'fakeAdapterId', 'host', 'inputs', 'job', 'key', 'kind', 'mandateKind', 'maxLength', 'meter', 'minorUnits', 'name', 'operation', 'priceVersionId', 'privateDataClasses', 'region',
  'required', 'requiredMandateKinds', 'route', 'safetySuite', 'schemaVersion', 'sideEffects', 'suiteId', 'title', 'type',
] as const;
const KNOWN_MANIFEST_KEYS: ReadonlySet<string> = new Set(EXTENSION_MANIFEST_KEYS);

/** Every key of a raw manifest outside the vocabulary (any depth; locale tags under `title` are not walked). */
export function unknownManifestKeys(raw: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') for (const [k, child] of Object.entries(v)) {
      if (!KNOWN_MANIFEST_KEYS.has(k)) out.add(k);
      if (k !== 'title') walk(child);
    }
  };
  walk(raw);
  return [...out].sort();
}

/* ---------- What a declaration requires ---------- */

/**
 * The mandate kinds a declared side effect needs; a side effect not listed here needs none in particular. A declaration
 * decides which kill switches apply and which confirmation floor an action meets, so an action cannot reach a person's
 * channel under `research` and step around the `outbound_messages` switch and the floor of `communicate`.
 */
export const SIDE_EFFECT_MANDATE_KINDS: Readonly<Partial<Record<z.infer<typeof SideEffectSchema>, readonly MandateActionV2[]>>> = {
  outbound_message: ['communicate'],
  publication: ['publish', 'maintain_profile'],
  money_commitment: ['place_order', 'accept_order', 'register', 'release_payment'],
  reputation_signal: ['record_evidence', 'confirm_execution'],
};
/**
 * The egress classes that can carry each party-private class. The two vocabularies differ: `privateDataClasses` says what
 * an action touches, `dataClassesSent` what the egress matrix decides on. One of these must be declared as sent.
 */
export const PRIVATE_CLASS_EGRESS: Readonly<Record<z.infer<typeof PrivateDataClassSchema>, readonly z.infer<typeof DataClassSchema>[]>> = {
  negotiation_constraints: ['deal_party_private'],
  budgets: ['person_private', 'company_private', 'deal_party_private'],
  private_projects: ['project_restricted'],
  drafts: ['person_private', 'company_private'],
};

/* ---------- Confirmation floor ---------- */

const CONFIRMATION_RANK: Readonly<Record<CapabilityConfirmation, number>> = { none: 0, mandate: 1, person_each: 2, person_each_step_up: 3, first_party_form: 4, first_party_step_up: 5 };
export function confirmationRank(c: CapabilityConfirmation): number {
  return CONFIRMATION_RANK[c];
}
/**
 * The weakest confirmation an extension action of this mandate kind may declare: the strongest built-in action of the same
 * kind, at least `mandate` for a commit, and a person each time for human-only kinds. Comparing against the strongest
 * built-in is deliberate: an extension never gets a lighter path to an effect than the engine itself offers.
 */
export function confirmationFloor(kind: 'draft' | 'commit', mandateKind: MandateActionV2, builtIn: readonly Pick<AgentCapability, 'mandateAction' | 'confirmation'>[]): CapabilityConfirmation {
  const candidates: CapabilityConfirmation[] = builtIn.filter((c) => c.mandateAction === mandateKind).map((c) => c.confirmation);
  if (kind === 'commit') candidates.push('mandate');
  if (HUMAN_ONLY_ACTIONS.includes(mandateKind)) candidates.push('person_each');
  return candidates.reduce<CapabilityConfirmation>((strongest, c) => (CONFIRMATION_RANK[c] > CONFIRMATION_RANK[strongest] ? c : strongest), 'none');
}

/* ---------- From a manifest to capabilities ---------- */

/** The module version of an extension version: the policy names it like any module (`3` is `3.0.0`). */
export function extensionModuleVersion(version: number): string {
  return `${version}.0.0`;
}
export function extensionCapabilityId(key: string, operation: string): string {
  return `${key}.${operation}`;
}
/** Input and output are the same two strict schemas for every extension; `inputs` narrows the input per action. */
const CALL_INPUT_REF = { contract: 'agent-extensions', schema: 'ExtensionCallInputSchema', version: AGENT_EXTENSIONS_CONTRACT_VERSION } as const;
const CALL_OUTPUT_REF = { contract: 'agent-extensions', schema: 'ExtensionCallOutputSchema', version: AGENT_EXTENSIONS_CONTRACT_VERSION } as const;
/** One locale key for every extension action: administrators' wording is hub data (`title`), not product copy. */
export const EXTENSION_CAPABILITY_LABEL_KEY = 'agentExtensions.capabilityLabel';

/** One action as the AGT-002 capability the shared registry, the mandate policy and the dispatcher all read. */
export function extensionActionCapability(manifest: Pick<AgentExtensionManifest, 'key'>, action: ExtensionAction, source: { extensionId: string; version: number }): AgentCapability {
  return {
    id: extensionCapabilityId(manifest.key, action.operation),
    version: source.version,
    source: { kind: 'extension', extensionId: source.extensionId, extensionVersion: source.version },
    kind: action.kind,
    input: CALL_INPUT_REF,
    output: CALL_OUTPUT_REF,
    mandateAction: action.mandateKind,
    contextKinds: action.contextKinds,
    confirmation: action.confirmation,
    budgetKind: action.kind === 'commit' ? BUDGET_KIND_BY_ACTION[action.mandateKind] : null,
    reads: action.privateDataClasses.length > 0 ? ['party_private'] : ['public'],
    privateDataClasses: action.privateDataClasses,
    sideEffects: action.sideEffects,
    acceptsUntrustedText: action.acceptsUntrustedText,
    meters: action.cost.kind === 'per_call' ? [action.cost.meter] : [],
    surfaces: ['ui', 'agent'],
    status: 'live',
    labelKey: EXTENSION_CAPABILITY_LABEL_KEY,
  };
}
export function extensionCapabilities(manifest: AgentExtensionManifest, source: { extensionId: string; version: number }): AgentCapability[] {
  return manifest.actions.map((a) => extensionActionCapability(manifest, a, source));
}

/**
 * The module entry a hub enables for an activated extension version. It carries no capabilities of its own: those join
 * through the registry's `extensions` list, and only while the hub policy lists this version.
 */
export function extensionModuleManifest(manifest: AgentExtensionManifest, version: number): AgentModuleManifest {
  return {
    key: manifest.key, version: extensionModuleVersion(version), family: 'connectivity', status: 'live', actions: [...manifest.requiredMandateKinds], capabilities: [],
    meters: [...new Set(manifest.actions.flatMap((a) => (a.cost.kind === 'per_call' ? [a.cost.meter] : [])))], suits: [], freeFloor: [], safetySuite: 'tests/agent-extensions/safety.test.ts',
  };
}

/* ---------- Refusals ---------- */

/** Every reason code the registry and its runtime report (locale keys `agentExtensions.reasons.<code>`). */
export const AGENT_EXTENSION_REASONS = [
  // Registration.
  'manifest_invalid', 'guard_rail', 'action_without_mandate_kind', 'action_kind_refused', 'confirmation_below_built_in', 'capability_invalid', 'restricted_endpoint', 'endpoint_undeclared',
  'key_reserved', 'charge_without_budget', 'side_effect_needs_mandate_kind', 'data_classes_undeclared', 'private_class_not_sent',
  // Lifecycle and activation.
  'invalid_transition', 'revision_conflict', 'suite_required', 'suite_stale', 'suite_pending', 'version_not_ready', 'route_missing', 'egress_denied', 'price_version_unavailable',
  'drafter_cannot_approve', 'one_version_per_extension',
  // A call.
  'extension_inactive', 'extension_killed', 'version_changed', 'input_invalid', 'amount_below_cost', 'output_refused', 'adapter_unavailable',
] as const;
export const AgentExtensionReasonSchema = z.enum(AGENT_EXTENSION_REASONS);
export type AgentExtensionReason = z.infer<typeof AgentExtensionReasonSchema>;
export interface ExtensionRefusal { code: AgentExtensionReason; detail: string }

/** Every rule a parsed manifest breaks on its own, with no outside facts. Empty when consistent. */
export function manifestConsistencyRefusals(m: AgentExtensionManifest): ExtensionRefusal[] {
  const out: ExtensionRefusal[] = [];
  const hosts = new Set(m.endpoints.map((e) => e.host));
  if (!uniq(m.actions.map((a) => a.operation))) out.push({ code: 'manifest_invalid', detail: 'actions' });
  if (!uniq(m.endpoints.map((e) => e.host))) out.push({ code: 'manifest_invalid', detail: 'endpoints' });
  if (!uniq(m.requiredMandateKinds)) out.push({ code: 'manifest_invalid', detail: 'requiredMandateKinds' });
  const declared = new Set(m.requiredMandateKinds);
  const used = new Set(m.actions.map((a) => a.mandateKind));
  if (declared.size !== used.size || [...used].some((k) => !declared.has(k))) out.push({ code: 'manifest_invalid', detail: 'requiredMandateKinds' });
  if (m.safetySuite.suiteId !== `extension.${m.key}`) out.push({ code: 'manifest_invalid', detail: 'safetySuite' });
  if (m.adapter.adapterId === m.adapter.fakeAdapterId) out.push({ code: 'manifest_invalid', detail: 'adapter' });
  for (const a of m.actions) {
    const id = extensionCapabilityId(m.key, a.operation);
    for (const [name, list] of [['dataClassesRead', a.dataClassesRead], ['dataClassesSent', a.dataClassesSent], ['endpointHosts', a.endpointHosts], ['inputs', a.inputs.map((i) => i.name)]] as const) {
      if (!uniq(list as readonly string[])) out.push({ code: 'manifest_invalid', detail: `${id}:${name}` });
    }
    for (const h of a.endpointHosts) if (!hosts.has(h)) out.push({ code: 'endpoint_undeclared', detail: `${id}:${h}` });
    if (a.dataClassesSent.length > 0 && a.endpointHosts.length === 0) out.push({ code: 'endpoint_undeclared', detail: id });
    if (a.sideEffects.includes('external_call') && a.dataClassesSent.length === 0) out.push({ code: 'data_classes_undeclared', detail: id });
    for (const effect of a.sideEffects) {
      const kinds = SIDE_EFFECT_MANDATE_KINDS[effect];
      if (kinds && !kinds.includes(a.mandateKind)) out.push({ code: 'side_effect_needs_mandate_kind', detail: `${id}:${effect}` });
    }
    for (const c of a.privateDataClasses) if (!PRIVATE_CLASS_EGRESS[c].some((d) => a.dataClassesSent.includes(d))) out.push({ code: 'private_class_not_sent', detail: `${id}:${c}` });
    if (a.sideEffects.includes('external_call') !== (a.endpointHosts.length > 0)) out.push({ code: 'endpoint_undeclared', detail: `${id}:external_call` });
    if (a.cost.kind === 'per_call' && BigInt(a.cost.amount.minorUnits) > 0n && (a.kind !== 'commit' || BUDGET_KIND_BY_ACTION[a.mandateKind] === null)) out.push({ code: 'charge_without_budget', detail: id });
    for (const message of capabilityViolations(extensionActionCapability(m, a, { extensionId: '00000000-0000-4000-8000-000000000000', version: 1 }))) out.push({ code: 'capability_invalid', detail: `${id}:${message}` });
  }
  return out;
}

/** The manifest schema with the rules above, for readers of a stored manifest. */
export const AgentExtensionManifestSchema = ManifestShape.superRefine((m, ctx) => {
  for (const r of manifestConsistencyRefusals(m)) ctx.addIssue({ code: 'custom', message: `${r.code}: ${r.detail}`, path: [] });
});

export interface ManifestFacts {
  /** The module keys and capabilities of the engine: an extension never takes a built-in key or a lighter confirmation. */
  builtIn: readonly Pick<AgentCapability, 'mandateAction' | 'confirmation'>[];
  engineModuleKeys: readonly string[];
  /** Restricted-places predicate (`isRestricted` of `@trustwork/country-packs`) for one place code. */
  isRestricted: (code: string) => boolean;
}

/** A country-code top-level domain of a host (`.xx`), upper-cased; generic domains answer null. */
export function hostCountry(host: string): string | null {
  const tld = host.split('.').at(-1) ?? '';
  return tld.length === 2 ? tld.toUpperCase() : null;
}
function endpointRestricted(e: ExtensionEndpoint, isRestricted: (code: string) => boolean): boolean {
  const tld = hostCountry(e.host);
  return isRestricted(e.country) || (e.region !== null && isRestricted(e.region)) || (tld !== null && isRestricted(tld));
}

/** Why a raw action object has no usable mandate kind, before the schema reports a generic problem. */
function rawActionRefusals(raw: unknown): ExtensionRefusal[] {
  const actions = (raw as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return [];
  const out: ExtensionRefusal[] = [];
  actions.forEach((a: unknown, i) => {
    const action = (a ?? {}) as { operation?: unknown; mandateKind?: unknown; kind?: unknown };
    const name = typeof action.operation === 'string' ? action.operation : String(i);
    if (action.mandateKind === undefined || action.mandateKind === null || !MandateActionV2Schema.safeParse(action.mandateKind).success) out.push({ code: 'action_without_mandate_kind', detail: name });
    if (action.kind === 'read' || action.kind === 'govern') out.push({ code: 'action_kind_refused', detail: name });
  });
  return out;
}

/**
 * Every reason a raw manifest is refused at registration; empty when it may be stored as a draft. Checks in the order of
 * what an administrator most needs to know: a guard-rail key, an action without a mandate kind, then the schema, the
 * manifest's own consistency, the confirmation floor and the restricted places.
 */
export function manifestRefusals(raw: unknown, facts: ManifestFacts): ExtensionRefusal[] {
  const out: ExtensionRefusal[] = [...unknownManifestKeys(raw).map((k): ExtensionRefusal => ({ code: 'guard_rail', detail: k })), ...rawActionRefusals(raw)];
  if (out.length > 0) return out;
  const parsed = ManifestShape.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ code: 'manifest_invalid', detail: i.path.join('.') || '(manifest)' }));
  const m = parsed.data;
  out.push(...manifestConsistencyRefusals(m));
  if (facts.engineModuleKeys.includes(m.key)) out.push({ code: 'key_reserved', detail: m.key });
  for (const a of m.actions) {
    const floor = confirmationFloor(a.kind, a.mandateKind, facts.builtIn);
    if (CONFIRMATION_RANK[a.confirmation] < CONFIRMATION_RANK[floor]) out.push({ code: 'confirmation_below_built_in', detail: `${extensionCapabilityId(m.key, a.operation)}:${floor}` });
  }
  for (const e of m.endpoints) if (endpointRestricted(e, facts.isRestricted)) out.push({ code: 'restricted_endpoint', detail: e.host });
  return out;
}

/* ---------- Lifecycle ---------- */

const TRANSITIONS: Readonly<Record<AgentExtensionStatus, readonly AgentExtensionStatus[]>> = {
  draft: ['tested', 'retired'],
  tested: ['active', 'suspended', 'retired'],
  active: ['suspended', 'retired'],
  suspended: ['tested', 'retired'],
  retired: [],
};
/** `suspended -> tested` needs a new passing suite; returning to `active` needs a new configuration version. */
export function extensionTransitionAllowed(from: AgentExtensionStatus, to: AgentExtensionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The payload of a hub configuration version of domain `agent_extensions`: the complete list of active versions. */
export const AgentExtensionsConfigPayloadSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_EXTENSIONS_CONTRACT_VERSION),
  activeVersions: z.array(z.strictObject({ extensionId: IdSchema, versionId: IdSchema, manifestDigest: Sha256HexSchema })).max(200),
}).refine((p) => uniq(p.activeVersions.map((v) => v.extensionId)), { message: 'one active version per extension', path: ['activeVersions'] });
export type AgentExtensionsConfigPayload = z.infer<typeof AgentExtensionsConfigPayloadSchema>;

/* ---------- Safety suite ---------- */

export const ExtensionSafetyRunStateSchema = z.enum(['requested', 'passed', 'failed']);
export const ExtensionScenarioResultSchema = z.strictObject({
  id: z.string().regex(/^extension\.[a-z0-9_.-]{1,160}$/),
  status: z.enum(['passed', 'failed']),
  owasp: z.array(z.string().regex(/^(LLM|ASI)\d{2}$/)),
  /** A reason code or an assertion message, never a private value. */
  detail: z.string().max(500).nullable(),
});
/** What the worker reports for one run (the same scenario shape as `trustwork.agent-safety-report/1`). */
export const ExtensionSafetyReportSchema = z.strictObject({
  schema: z.literal('trustwork.agent-safety-report/1'),
  suiteId: z.string().regex(/^extension\.[a-z][a-z0-9_]{1,40}$/),
  engineVersion: z.string().min(1).max(40),
  onFakeAdapter: z.literal(true),
  manifestDigest: Sha256HexSchema,
  scenarios: z.array(ExtensionScenarioResultSchema).min(1).max(500),
  passed: z.boolean(),
}).refine((r) => r.passed === r.scenarios.every((s) => s.status === 'passed'), { message: 'a run passes only when every scenario passed', path: ['passed'] });
export type ExtensionSafetyReport = z.infer<typeof ExtensionSafetyReportSchema>;

/* ---------- A call ---------- */

/** Structured call arguments: scalars only, so no input can carry a nested document or an instruction object. */
export const ExtensionCallInputSchema = z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/), z.union([z.string().max(4000), z.int(), z.boolean()]));
export type ExtensionCallInput = z.infer<typeof ExtensionCallInputSchema>;
/** Field names that would make a value look like an instruction to the runtime. */
const COMMAND_KEY = /command|instruction|tool|mandate|approv|confirm|execute|authori[sz]e|prompt|system/i;
/**
 * What an adapter may return: a summary and flat scalar facts. No field here is read as a command; the runtime treats the
 * whole value as untrusted data and keeps only its digest.
 */
export const ExtensionCallOutputSchema = z.strictObject({
  summary: z.string().max(4000),
  facts: z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/), z.union([z.string().max(1000), z.number(), z.boolean()])),
}).refine((o) => Object.keys(o.facts).every((k) => !COMMAND_KEY.test(k)), { message: 'an extension output carries no command field', path: ['facts'] });
export type ExtensionCallOutput = z.infer<typeof ExtensionCallOutputSchema>;

/** Every way a call payload departs from the action's declared inputs. Empty when it may be sent. */
export function extensionInputViolations(action: Pick<ExtensionAction, 'inputs'>, payload: unknown): string[] {
  const parsed = ExtensionCallInputSchema.safeParse(payload);
  if (!parsed.success) return ['payload'];
  const out: string[] = [];
  const declared = new Map(action.inputs.map((f) => [f.name, f]));
  for (const [name, value] of Object.entries(parsed.data)) {
    const field = declared.get(name);
    if (!field) {
      out.push(name);
      continue;
    }
    const fits = field.type === 'text' ? typeof value === 'string' && value.length <= (field.maxLength as number) : field.type === 'integer' ? typeof value === 'number' : typeof value === 'boolean';
    if (!fits) out.push(name);
  }
  for (const f of action.inputs) if (f.required && parsed.data[f.name] === undefined) out.push(f.name);
  return [...new Set(out)].sort();
}

/** Whether a proposed amount covers the action's declared cost: an agent cannot propose its way under a price. */
export function extensionAmountCovers(action: Pick<ExtensionAction, 'cost'>, amount: Money | null): boolean {
  if (action.cost.kind === 'none') return true;
  if (BigInt(action.cost.amount.minorUnits) === 0n) return true;
  return amount !== null && amount.currency === action.cost.amount.currency && compareMoney(amount, action.cost.amount) >= 0;
}

/** Why a proposed call is refused before anything is recorded; null when it may go on to the mandate's own decision. */
export function extensionCallRefusal(action: Pick<ExtensionAction, 'inputs' | 'cost'>, call: { amount: Money | null; payload: unknown }): 'input_invalid' | 'amount_below_cost' | null {
  if (extensionInputViolations(action, call.payload).length > 0) return 'input_invalid';
  return extensionAmountCovers(action, call.amount) ? null : 'amount_below_cost';
}

export const EXTENSION_CALL_OUTCOMES = ['started', 'succeeded', 'failed', 'refused', 'unknown'] as const;
export const ExtensionCallOutcomeSchema = z.enum(EXTENSION_CALL_OUTCOMES);

/* ---------- Views ---------- */

const SafetyRunViewSchema = z.strictObject({
  id: IdSchema, versionId: IdSchema, state: ExtensionSafetyRunStateSchema, engineVersion: z.string().min(1).max(40).nullable(), manifestDigest: Sha256HexSchema, reportDigest: Sha256HexSchema.nullable(),
  scenarioCount: z.int().min(0), failedCount: z.int().min(0), requestedAt: TimestampSchema, completedAt: TimestampSchema.nullable(),
});
export const ExtensionSafetyRunViewSchema = SafetyRunViewSchema;
export type ExtensionSafetyRunView = z.infer<typeof SafetyRunViewSchema>;

export const ExtensionVersionViewSchema = z.strictObject({
  ref: AgentExtensionVersionRefSchema,
  manifest: ManifestShape,
  revision: RevisionSchema,
  statusReason: z.string().max(500).nullable(),
  latestRun: SafetyRunViewSchema.nullable(),
});
export type ExtensionVersionView = z.infer<typeof ExtensionVersionViewSchema>;
export const ExtensionViewSchema = z.strictObject({ id: IdSchema, hubId: IdSchema, key: ExtensionKeySchema, versions: z.array(ExtensionVersionViewSchema) });
export type ExtensionView = z.infer<typeof ExtensionViewSchema>;

/**
 * One audited call, by digest. Staff see what ran and how it ended, never who asked or what was sent: no person, no
 * payload and no intent appear here.
 */
export const ExtensionCallViewSchema = z.strictObject({
  id: IdSchema, extensionId: IdSchema, versionId: IdSchema, capabilityId: z.string().max(100), outcome: ExtensionCallOutcomeSchema, refusal: z.string().max(100).nullable(),
  inputDigest: DigestSchema, outputDigest: DigestSchema.nullable(), startedAt: TimestampSchema, finishedAt: TimestampSchema.nullable(),
});
export type ExtensionCallView = z.infer<typeof ExtensionCallViewSchema>;

/** The console's reference for a stored version (the `guards` are literals: no extension can switch them off). */
export function extensionVersionRef(input: {
  id: string; extensionId: string; hubId: string; version: number; manifest: AgentExtensionManifest; manifestDigest: string; status: AgentExtensionStatus; draftedBy: string; approvedBy: string | null;
  approvalId: string | null; activatedConfigVersionId: string | null; safetySuite: AgentExtensionVersionRef['safetySuite'];
}): AgentExtensionVersionRef {
  const { manifest: m } = input;
  return {
    id: input.id, extensionId: input.extensionId, hubId: input.hubId, key: m.key, version: input.version, manifestDigest: { algorithm: 'trustwork-digest-1', value: input.manifestDigest },
    capabilityIds: m.actions.map((a) => extensionCapabilityId(m.key, a.operation)), dataClassesRead: [...new Set(m.actions.flatMap((a) => a.dataClassesRead))], dataClassesSent: [...new Set(m.actions.flatMap((a) => a.dataClassesSent))],
    endpoints: m.endpoints.map((e) => ({ host: e.host, country: e.country })), adapterId: m.adapter.adapterId, hasFakeAdapter: true,
    guards: { mandates: true, budgets: true, approvals: true, killSwitches: true, egress: true, privacyRules: true, restrictedPlaces: true, untrustedTextNeverCommands: true },
    safetySuite: input.safetySuite, status: input.status, draftedBy: input.draftedBy, approvedBy: input.approvedBy, approvalId: input.approvalId, activatedConfigVersionId: input.activatedConfigVersionId,
  };
}

/* ---------- Console commands ---------- */

/** `manifest` is not parsed by the command schema: `manifestRefusals` reports why, with a reason an administrator can act on. */
export const DraftExtensionVersionCommandSchema = consoleCommand({ manifest: z.record(z.string(), z.unknown()) });
export type DraftExtensionVersionCommand = z.infer<typeof DraftExtensionVersionCommandSchema>;
export const RequestSafetyRunCommandSchema = consoleCommand({ expectedRevision: RevisionSchema });
export type RequestSafetyRunCommand = z.infer<typeof RequestSafetyRunCommandSchema>;
/** Proposes the next list of active versions as a hub configuration version; the versions named here join it. */
export const DraftExtensionActivationCommandSchema = consoleCommand({ versionIds: z.array(IdSchema).min(1).max(50) });
export type DraftExtensionActivationCommand = z.infer<typeof DraftExtensionActivationCommandSchema>;
/** Without `approvalId` this asks a second person (`agents.activate_extension`); the requester then calls again with it. */
export const ActivateExtensionsCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, approvalId: IdSchema.nullable() });
export type ActivateExtensionsCommand = z.infer<typeof ActivateExtensionsCommandSchema>;
export const SuspendExtensionVersionCommandSchema = consoleCommand({ expectedRevision: RevisionSchema });
export type SuspendExtensionVersionCommand = z.infer<typeof SuspendExtensionVersionCommandSchema>;
export const RetireExtensionVersionCommandSchema = consoleCommand({ expectedRevision: RevisionSchema });
export type RetireExtensionVersionCommand = z.infer<typeof RetireExtensionVersionCommandSchema>;

/** Every schema of this contract, for the JSON schema export and the registry test. */
export const AGENT_EXTENSIONS_SCHEMAS = {
  AgentExtensionManifest: AgentExtensionManifestSchema, AgentExtensionsConfigPayload: AgentExtensionsConfigPayloadSchema, ExtensionSafetyReport: ExtensionSafetyReportSchema,
  ExtensionCallInput: ExtensionCallInputSchema, ExtensionCallOutput: ExtensionCallOutputSchema, ExtensionVersionView: ExtensionVersionViewSchema, ExtensionView: ExtensionViewSchema,
  ExtensionCallView: ExtensionCallViewSchema, DraftExtensionVersionCommand: DraftExtensionVersionCommandSchema, RequestSafetyRunCommand: RequestSafetyRunCommandSchema,
  DraftExtensionActivationCommand: DraftExtensionActivationCommandSchema, ActivateExtensionsCommand: ActivateExtensionsCommandSchema, SuspendExtensionVersionCommand: SuspendExtensionVersionCommandSchema,
  RetireExtensionVersionCommand: RetireExtensionVersionCommandSchema,
} as const;

