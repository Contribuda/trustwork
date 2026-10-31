import { z } from 'zod';
import { ADMIN_PERMISSIONS } from './admin.js';
import {
  connectionMayInvoke, isHumanOnlyAction, requiredConnectionScopes, type AgentCapability, type CapabilityRegistry, type ConnectionScope,
  type ExternalConnection, PrivateDataClassSchema, type PrivateDataClass, FirstPartyConfirmationSchema,
} from './agent-catalog.js';
import { DigestSchema } from './common/digest-schema.js';
import { ERROR_CODES } from './common/errors.js';
import { IdSchema, RevisionSchema, TimestampSchema } from './common/ids.js';
import { ProjectionLayerSchema } from './common/projection.js';

/**
 * The Trustwork MCP server (proposed, ADR 013 and docs/engine/mcp-server.md). The MCP tool catalogue is a projection of
 * the one capability registry of AGT-002 (`agent-catalog.ts`, ADR 010 decision 23): every participant tool points at a
 * registry capability and reuses its kind, scopes (`requiredConnectionScopes`), private data classes, mandate kind,
 * confirmation and meters; this file adds only what MCP needs on top: endpoints, tool names and toolsets, annotations,
 * handoff tools for first-party-only steps, the staff surface, connection details, the on-site confirmation challenge,
 * the untrusted-content envelope, per-hub policy and the stable MCP error codes. Pure Zod and pure functions; nothing
 * here runs a server. Implementation: MCP-001 … MCP-090 in docs/engine/work-packages.json.
 */

/* ---------- Protocol pinning ---------- */

/** Revisions the server accepts. `2026-07-28` (stateless, server/discover) is pinned; `2025-11-25` is kept for clients still on the initialize handshake. */
export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25'] as const;
export const McpProtocolVersionSchema = z.enum(MCP_PROTOCOL_VERSIONS);
export type McpProtocolVersion = z.infer<typeof McpProtocolVersionSchema>;
export const MCP_PINNED_PROTOCOL_VERSION: McpProtocolVersion = '2026-07-28';

/* ---------- Endpoints, toolsets and staff scopes ---------- */

/** Three protected resources on each hub origin; each is its own token audience. */
export const MCP_ENDPOINTS = ['public', 'participant', 'admin'] as const;
export const McpEndpointSchema = z.enum(MCP_ENDPOINTS);
export type McpEndpoint = z.infer<typeof McpEndpointSchema>;
export const MCP_ENDPOINT_PATHS: Readonly<Record<McpEndpoint, string>> = { public: '/mcp/public', participant: '/mcp', admin: '/mcp/admin' };

/**
 * Toolsets group participant tools for `tools/list` (a connection sees only the toolsets the person ticked), and prefix
 * tool names. They are an MCP presentation layer over the registry, not a permission: permissions come from the
 * registry capability and the connection.
 */
export const MCP_TOOLSETS = [
  'account', 'agent', 'companies', 'projects', 'plans', 'consultations', 'tasks', 'catalogue', 'procurement', 'sales', 'orders',
  'execution', 'reputation', 'knowledge', 'learning', 'events', 'publications', 'matching', 'messages', 'notifications', 'billing',
  'files', 'hub',
] as const;
export const McpToolsetSchema = z.enum(MCP_TOOLSETS);
export type McpToolset = z.infer<typeof McpToolsetSchema>;
/** Pre-ticked on a new consent screen; the screen adds the toolsets of the person's active modules. */
export const DEFAULT_TOOLSETS: readonly McpToolset[] = ['account', 'agent', 'knowledge', 'notifications', 'hub'];

/** Participant scopes are AGT-002's `ConnectionScope`; staff scopes exist only on `/mcp/admin` and have no `act`. */
export const MCP_STAFF_SCOPES = ['admin.read', 'admin.propose'] as const;
export const McpStaffScopeSchema = z.enum(MCP_STAFF_SCOPES);
export type McpStaffScope = z.infer<typeof McpStaffScopeSchema>;
/** Scopes ticked by default on the participant consent screen; everything else is asked. */
export const DEFAULT_CONNECTION_SCOPES: readonly ConnectionScope[] = ['read.public', 'read.me'];

/* ---------- Participant and public tools: a projection of the registry ---------- */

/** Tool names fit every major model API (letters, digits, underscore, at most 64) as well as the MCP naming rule. */
export const McpToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/, 'MCP tool name');
const CapabilityIdRefSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100);

/** MCP tool annotations, always emitted explicitly (the protocol defaults are destructive and open-world). Hints only; the server enforces. */
export const McpToolAnnotationsSchema = z.strictObject({
  readOnlyHint: z.boolean(),
  destructiveHint: z.boolean(),
  idempotentHint: z.boolean(),
  openWorldHint: z.boolean(),
});
export type McpToolAnnotations = z.infer<typeof McpToolAnnotationsSchema>;

/**
 * `capability`: the tool invokes a registry capability (read, draft or commit). `handoff`: the tool only returns a link
 * to the first-party page where the person acts: the form of a `govern` capability (never reachable by connections) or
 * another first-party-only page (security, privacy, legal acts, reviews, uploads).
 */
export const McpToolTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('capability'), capabilityId: CapabilityIdRefSchema }),
  z.strictObject({
    kind: z.literal('handoff'),
    opens: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('capability'), capabilityId: CapabilityIdRefSchema }),
      z.strictObject({ kind: z.literal('page'), page: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/), path: z.string().regex(/^\/[A-Za-z0-9_\-[\]/().]*$/).max(200) }),
    ]),
  }),
]);
export type McpToolTarget = z.infer<typeof McpToolTargetSchema>;

export const McpToolSchema = z.strictObject({
  name: McpToolNameSchema,
  toolset: McpToolsetSchema,
  /** English, model-facing; person-facing strings come from locale files at response time. */
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(1024),
  target: McpToolTargetSchema,
  endpoints: z.array(z.enum(['public', 'participant'])).min(1).max(2),
  annotations: McpToolAnnotationsSchema,
  /** Private classes whose fields are removed (and named in `_meta.redactedFields`) unless the connection opted in. Classes the capability needs outright are its `privateDataClasses`. */
  redactableDataClasses: z.array(PrivateDataClassSchema),
  deprecated: z.strictObject({ since: TimestampSchema, sunset: TimestampSchema, replacement: McpToolNameSchema.nullable() }).nullable(),
});
export type McpTool = z.infer<typeof McpToolSchema>;

const OPEN_WORLD_EFFECTS = new Set(['outbound_message', 'publication', 'money_commitment', 'reputation_signal', 'external_call']);
const operationOf = (capabilityId: string) => capabilityId.split('.')[1];

/**
 * Invariants of one tool against the capability it projects (`null` for page handoffs). Empty when valid.
 * - the name is `<toolset>_<operation>` where the operation is the capability's;
 * - a `govern` capability is reachable only through a handoff, and a handoff never invokes anything;
 * - a tool only projects capabilities whose surfaces include `mcp`, `ui` and `agent` (full parity);
 * - annotations follow the kind: nothing is both read-only and committing;
 * - the public endpoint offers only public reads.
 */
export function mcpToolViolations(tool: McpTool, capability: AgentCapability | null): string[] {
  const out: string[] = [];
  const a = tool.annotations;
  if (!tool.name.startsWith(`${tool.toolset}_`)) out.push('the tool name starts with its toolset');
  if (new Set(tool.endpoints).size !== tool.endpoints.length || new Set(tool.redactableDataClasses).size !== tool.redactableDataClasses.length) out.push('endpoints and classes are distinct');
  if (tool.deprecated && Date.parse(tool.deprecated.sunset) - Date.parse(tool.deprecated.since) < 180 * 24 * 3600 * 1000) out.push('deprecation window is at least 180 days');
  const ref = tool.target.kind === 'capability' ? tool.target.capabilityId : tool.target.opens.kind === 'capability' ? tool.target.opens.capabilityId : null;
  if (ref !== null && (capability === null || capability.id !== ref)) return [...out, `unknown capability ${ref}`];
  if (tool.target.kind === 'handoff') {
    if (!a.readOnlyHint || a.destructiveHint) out.push('a handoff changes nothing itself');
    if (tool.endpoints.includes('public')) out.push('handoffs need a signed-in person');
    if (tool.redactableDataClasses.length) out.push('a handoff returns no private data');
    if (capability && !capability.surfaces.includes('ui')) out.push('a handoff opens a capability that exists in the interface');
    if (capability && capability.kind !== 'govern' && capability.surfaces.includes('mcp')) out.push('a capability reachable over MCP is invoked, not handed off');
    return out;
  }
  if (!capability) return out;
  if (!tool.name.endsWith(`_${operationOf(capability.id)}`)) out.push('the tool name ends with the capability operation');
  if (capability.kind === 'govern') out.push('governance is never invoked by a connection; use a handoff');
  for (const s of ['mcp', 'ui', 'agent'] as const) if (!capability.surfaces.includes(s)) out.push(`the capability lacks the ${s} surface`);
  if (tool.redactableDataClasses.some((d) => capability.privateDataClasses.includes(d))) out.push('a class is either required or redactable, not both');
  switch (capability.kind) {
    case 'read':
      if (!a.readOnlyHint || a.destructiveHint) out.push('reads are read-only and never destructive');
      break;
    case 'draft':
      if (a.readOnlyHint || a.openWorldHint) out.push('drafts write private state only');
      break;
    case 'commit':
      if (a.readOnlyHint) out.push('a commit is never read-only');
      if (capability.sideEffects.some((e) => OPEN_WORLD_EFFECTS.has(e)) !== a.openWorldHint) out.push('openWorldHint follows the side effects');
      break;
  }
  if (tool.endpoints.includes('public')) {
    if (capability.kind !== 'read' || capability.reads.some((r) => r !== 'public') || capability.privateDataClasses.length || tool.redactableDataClasses.length) out.push('the public endpoint offers only public reads');
  }
  return out;
}

/**
 * Coverage of a projection against the registry: every capability that offers the `mcp` surface has exactly one tool,
 * every `govern` capability in the interface has a handoff (so the person's chat can start it), every tool resolves,
 * and tool names are unique. Empty when complete; the CI parity report prints the result.
 */
export function mcpProjectionGaps(registry: CapabilityRegistry, tools: readonly McpTool[]): string[] {
  const out: string[] = [];
  const byId = new Map(registry.capabilities.map((c) => [c.id, c]));
  const names = tools.map((t) => t.name);
  if (new Set(names).size !== names.length) out.push('duplicate tool name');
  const invoked = new Map<string, number>();
  const handedOff = new Set<string>();
  for (const t of tools) {
    const ref = t.target.kind === 'capability' ? t.target.capabilityId : t.target.opens.kind === 'capability' ? t.target.opens.capabilityId : null;
    const cap = ref === null ? null : byId.get(ref) ?? null;
    for (const v of mcpToolViolations(t, cap)) out.push(`${t.name}: ${v}`);
    if (t.target.kind === 'capability') invoked.set(t.target.capabilityId, (invoked.get(t.target.capabilityId) ?? 0) + 1);
    else if (ref) handedOff.add(ref);
  }
  for (const c of registry.capabilities) {
    if (c.kind !== 'govern' && c.surfaces.includes('mcp') && invoked.get(c.id) !== 1) out.push(`${c.id}: needs exactly one MCP tool`);
    if (c.kind === 'govern' && c.surfaces.includes('ui') && !handedOff.has(c.id)) out.push(`${c.id}: governance step without a handoff tool`);
  }
  return out;
}

/** Scopes a tool needs: the registry's derivation for capabilities; a handoff needs only a signed-in person. */
export function mcpToolScopes(tool: McpTool, capability: AgentCapability | null): ConnectionScope[] {
  if (tool.target.kind === 'handoff') return ['read.me'];
  return capability ? requiredConnectionScopes(capability) ?? [] : [];
}

/**
 * What happens when a connection calls a tool: `deny`, `execute` (read, draft, or a commit inside a bound mandate after
 * `evaluateMandateV2`), `confirm_on_site` (a commit lands in the person's decisions and the chat gets the confirmation
 * link) or `handoff`. Built on AGT-002's `connectionMayInvoke`; a toolset the person did not tick is denied.
 */
export function mcpInvocation(tool: McpTool, capability: AgentCapability | null, connection: ExternalConnection, toolsets: readonly McpToolset[]): 'deny' | 'execute' | 'confirm_on_site' | 'handoff' {
  if (connection.status !== 'active' || connection.protocol !== 'mcp' || !toolsets.includes(tool.toolset)) return 'deny';
  if (tool.target.kind === 'handoff') return connection.scopes.includes('read.me') ? 'handoff' : 'deny';
  if (!capability) return 'deny';
  const decision = connectionMayInvoke(capability, connection);
  if (decision === 'deny') return 'deny';
  if (decision === 'propose_only') return 'confirm_on_site';
  if (capability.mandateAction !== null && isHumanOnlyAction(capability.mandateAction)) return 'confirm_on_site';
  return 'execute';
}

/** Tools listed on one endpoint, in deterministic order. The list follows toolsets and hub enablement, not scopes: a call outside the scopes answers `403 insufficient_scope` and the client steps up. */
export function toolsForEndpoint(tools: readonly McpTool[], endpoint: 'public' | 'participant', toolsets: readonly McpToolset[] = MCP_TOOLSETS): McpTool[] {
  return tools.filter((t) => t.endpoints.includes(endpoint) && (endpoint === 'public' || toolsets.includes(t.toolset))).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/* ---------- The staff surface (/mcp/admin) ---------- */

/**
 * Staff tools are not participant capabilities: they read queues, cases (only under an active case grant), statistics and
 * configuration, draft decisions and configuration versions, and hand off to the console. There is no staff commit kind:
 * every decision, second-person approval, case grant, kill switch and activation happens in the console.
 */
export const McpStaffToolSchema = z.strictObject({
  name: z.string().regex(/^admin_[a-z0-9_]{2,57}$/),
  kind: z.enum(['read', 'draft', 'handoff']),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(1024),
  scopes: z.array(McpStaffScopeSchema).min(1),
  staffPermissions: z.array(z.enum(ADMIN_PERMISSIONS)).min(1),
  readsStaffCase: z.boolean(),
  consolePath: z.string().regex(/^\/admin\/[A-Za-z0-9_\-[\]/().]*$/).max(200),
  annotations: McpToolAnnotationsSchema,
}).superRefine((t, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((t.kind === 'draft') !== t.scopes.includes('admin.propose')) issue('staff drafts, and only drafts, need admin.propose');
  if (t.kind !== 'draft' && (!t.annotations.readOnlyHint || t.annotations.destructiveHint)) issue('staff reads and handoffs change nothing');
  if (t.kind === 'draft' && (t.annotations.readOnlyHint || t.annotations.openWorldHint)) issue('staff drafts write private draft state only');
  if (t.kind === 'handoff' && t.readsStaffCase) issue('a handoff returns no case data');
});
export type McpStaffTool = z.infer<typeof McpStaffToolSchema>;

/* ---------- Connections: what the person agreed to ---------- */

/** How the client identified itself: Client ID Metadata Document (preferred), pre-registration, or deprecated dynamic registration. */
export const McpClientRegistrationSchema = z.enum(['client_id_metadata_document', 'pre_registered', 'dynamic_registration']);
const HttpsUrlSchema = z.url({ protocol: /^https$/ }).max(500);

/**
 * MCP details of a participant connection; scopes, private data classes, mandate bindings and the first-party consent
 * live on AGT-002's `ExternalConnection` (protocol `mcp`). Tokens reference the connection; all of this is read
 * server-side on every call.
 */
export const McpConnectionDetailsSchema = z.strictObject({
  connectionId: IdSchema,
  resource: HttpsUrlSchema,
  registration: McpClientRegistrationSchema,
  redirectUriHost: z.string().min(1).max(253),
  loopbackRedirectOnly: z.boolean(),
  toolsets: z.array(McpToolsetSchema).min(1),
  /** Each private class needs its own acknowledgement of the residency warning. */
  privateClassAcknowledgements: z.array(z.strictObject({ dataClass: PrivateDataClassSchema, acknowledgedAt: TimestampSchema })),
  consentExpiresAt: TimestampSchema,
  consentTextVersion: z.int().min(1),
  locale: z.string().min(2).max(35),
});
export type McpConnectionDetails = z.infer<typeof McpConnectionDetailsSchema>;

/** Cross-record rules of an MCP connection. Empty when valid. */
export function mcpConnectionViolations(connection: ExternalConnection, details: McpConnectionDetails): string[] {
  const out: string[] = [];
  if (connection.protocol !== 'mcp' || details.connectionId !== connection.id) out.push('details belong to this MCP connection');
  if (connection.clientId.startsWith('https://') !== (details.registration === 'client_id_metadata_document')) out.push('a URL client id is exactly a Client ID Metadata Document');
  if (!details.resource.endsWith(MCP_ENDPOINT_PATHS.participant)) out.push('a participant connection is audience-bound to /mcp');
  if (new Set(details.toolsets).size !== details.toolsets.length) out.push('toolsets are distinct');
  const acknowledged = new Set(details.privateClassAcknowledgements.map((a) => a.dataClass));
  for (const d of connection.privateDataClasses) if (!acknowledged.has(d)) out.push(`private class ${d} needs its own acknowledgement`);
  const ttl = Date.parse(details.consentExpiresAt) - Date.parse(connection.consent.at);
  if (ttl <= 0 || ttl > 366 * 24 * 3600 * 1000) out.push('consent lasts at most a year before it is asked again');
  return out;
}

/** The pre-ticked state of a new consent screen: public and own account data, no private class, no mandate. */
export function defaultConsentSelection(): { scopes: ConnectionScope[]; privateDataClasses: PrivateDataClass[]; mandateBindings: []; toolsets: McpToolset[] } {
  return { scopes: [...DEFAULT_CONNECTION_SCOPES], privateDataClasses: [], mandateBindings: [], toolsets: [...DEFAULT_TOOLSETS] };
}

/** A staff connection to `/mcp/admin`: staff scopes only, consented in an elevated session, never bound to a mandate. */
export const McpStaffConnectionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  personId: IdSchema,
  clientId: z.string().min(1).max(500),
  registration: McpClientRegistrationSchema,
  resource: HttpsUrlSchema,
  scopes: z.array(McpStaffScopeSchema).min(1),
  consent: FirstPartyConfirmationSchema,
  elevatedSessionId: IdSchema,
  status: z.enum(['active', 'suspended', 'revoked', 'expired']),
  createdAt: TimestampSchema,
  revision: RevisionSchema,
}).superRefine((c, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!c.resource.endsWith(MCP_ENDPOINT_PATHS.admin)) issue('a staff connection is audience-bound to /mcp/admin');
  if (!c.consent.stepUp || c.consent.personId !== c.personId) issue('the staff member consents with step-up');
  if (new Set(c.scopes).size !== c.scopes.length) issue('scopes are distinct');
});
export type McpStaffConnection = z.infer<typeof McpStaffConnectionSchema>;

/* ---------- Confirmation on the first-party surface ---------- */

export const CONFIRMATION_MAX_TTL_MS = 15 * 60 * 1000;
export const McpConfirmationStatusSchema = z.enum(['pending', 'confirmed', 'declined', 'expired', 'consumed']);
export type McpConfirmationStatus = z.infer<typeof McpConfirmationStatusSchema>;
const CONFIRMATION_TRANSITIONS: Record<McpConfirmationStatus, readonly McpConfirmationStatus[]> = {
  pending: ['confirmed', 'declined', 'expired'],
  confirmed: ['consumed', 'expired'],
  declined: [],
  expired: [],
  consumed: [],
};
export function confirmationTransitionAllowed(from: McpConfirmationStatus, to: McpConfirmationStatus): boolean {
  return CONFIRMATION_TRANSITIONS[from].includes(to);
}

/**
 * A commit that no bound mandate pre-authorizes lands in the person's decisions (`connectionMayInvoke` → propose_only);
 * this challenge is how the chat reaches that decision: a URL-mode elicitation (or a plain link) to `/confirm/<id>` on
 * the hub origin. The page renders the action from first-party records, never text from the model. The challenge binds
 * the person, the connection, the capability version, the action intent and its digest; it is single-use and short-lived.
 */
export const McpConfirmationChallengeSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/, 'unguessable opaque id'),
  personId: IdSchema,
  connectionId: IdSchema,
  capabilityId: CapabilityIdRefSchema,
  capabilityVersion: z.int().min(1),
  actionIntentId: IdSchema,
  actionDigest: DigestSchema,
  mandateRef: z.strictObject({ mandateId: IdSchema, revision: RevisionSchema }).nullable(),
  confirmation: z.enum(['mandate', 'person_each', 'person_each_step_up']),
  confirmUrl: HttpsUrlSchema,
  status: McpConfirmationStatusSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  consumedAt: TimestampSchema.nullable(),
}).superRefine((c, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const ttl = Date.parse(c.expiresAt) - Date.parse(c.createdAt);
  if (ttl <= 0 || ttl > CONFIRMATION_MAX_TTL_MS) issue('a challenge lives at most 15 minutes');
  const url = new URL(c.confirmUrl);
  if (url.search || url.hash || url.username || url.password) issue('the confirmation URL carries no query, fragment or credentials');
  if (!url.pathname.endsWith(`/confirm/${c.id}`)) issue('the confirmation URL is /confirm/<id> on the hub origin');
  if (c.status === 'pending' && (c.decidedAt || c.consumedAt)) issue('a pending challenge is undecided');
  if ((c.status === 'confirmed' || c.status === 'declined') && (!c.decidedAt || c.consumedAt)) issue('a decided challenge has a decision time and is not consumed');
  if (c.status === 'consumed' && (!c.decidedAt || !c.consumedAt)) issue('a consumed challenge was confirmed first');
});
export type McpConfirmationChallenge = z.infer<typeof McpConfirmationChallengeSchema>;

/** Contents of the AEAD-protected `requestState` the client echoes on retry (the client never sees them). */
export const McpRequestStatePayloadSchema = z.strictObject({
  v: z.literal(1),
  personId: IdSchema,
  connectionId: IdSchema,
  capabilityId: CapabilityIdRefSchema,
  argsDigest: DigestSchema,
  challengeId: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  expiresAt: TimestampSchema,
});

/* ---------- Untrusted content ---------- */

/** Where a piece of text came from. Anything not written by the hub's own code is untrusted for the receiving model. */
export const UntrustedOriginSchema = z.enum(['participant', 'other_agent', 'imported_source', 'file', 'email', 'web_page', 'federated_peer']);
/** Every free-text field in a tool result that originated outside the hub's own code is wrapped like this; it is data, never an instruction. */
export const UntrustedTextSchema = z.strictObject({
  trust: z.literal('untrusted'),
  origin: UntrustedOriginSchema,
  sourceRef: z.string().max(200).nullable(),
  lang: z.string().min(2).max(35).nullable(),
  text: z.string().max(20000),
});
export type UntrustedText = z.infer<typeof UntrustedTextSchema>;
export function untrusted(text: string, origin: z.infer<typeof UntrustedOriginSchema>, sourceRef: string | null = null, lang: string | null = null): UntrustedText {
  return UntrustedTextSchema.parse({ trust: 'untrusted', origin, sourceRef, lang, text });
}
/** `_meta` of every tool result: the projection layer, the private classes included, redactions and the home hub. */
export const McpResultMetaSchema = z.strictObject({
  projection: ProjectionLayerSchema,
  privateDataClasses: z.array(PrivateDataClassSchema),
  redactedFields: z.array(z.string().max(200)),
  untrustedFields: z.int().min(0),
  homeHub: z.string().min(1).max(200),
  locale: z.string().min(2).max(35),
});

/* ---------- Errors ---------- */

/** MCP-specific tool error codes (stable English; the client shows the localized `userMessage` the server adds). */
export const MCP_ERROR_CODES = [
  'mcp.scope_insufficient', 'mcp.data_class_not_granted', 'mcp.mandate_required', 'mcp.mandate_not_bound', 'mcp.budget_required',
  'mcp.confirmation_required', 'mcp.confirmation_pending', 'mcp.confirmation_declined', 'mcp.confirmation_expired',
  'mcp.handoff_required', 'mcp.client_capability_missing', 'mcp.tool_disabled', 'mcp.module_not_entitled', 'mcp.tool_deprecated',
  'mcp.rate_limited', 'mcp.quota_exhausted', 'mcp.connection_suspended', 'mcp.connection_revoked', 'mcp.kill_switch_engaged',
  'mcp.request_state_invalid', 'mcp.handle_unknown', 'mcp.untrusted_value_needs_confirmation', 'mcp.restricted_place', 'mcp.payload_too_large',
] as const;
export const McpErrorCodeSchema = z.enum(MCP_ERROR_CODES);
export type McpErrorCode = z.infer<typeof McpErrorCodeSchema>;
/** Body of a tool execution error (`isError: true`): an MCP code or an engine code from common/errors. */
export const McpToolErrorSchema = z.strictObject({
  code: z.enum([...MCP_ERROR_CODES, ...ERROR_CODES]),
  /** English, for the model; never private values or hints about objects the caller may not know exist. */
  message: z.string().min(1).max(500),
  /** Localized for the person by the server, from the locale key `mcp.error.<code>`. */
  userMessage: z.string().min(1).max(500),
  retryable: z.boolean(),
  /** Present when the person can act on the site: a confirmation or a handoff page. */
  siteUrl: HttpsUrlSchema.nullable(),
});
export type McpToolError = z.infer<typeof McpToolErrorSchema>;
const MCP_RETRYABLE = new Set<McpErrorCode>(['mcp.confirmation_pending', 'mcp.rate_limited']);
export function mcpErrorRetryable(code: McpErrorCode): boolean {
  return MCP_RETRYABLE.has(code);
}

/* ---------- Per-hub MCP policy ---------- */

/**
 * The MCP part of the hub's external-agents policy (console HC-82), next to AGT-002's protection limits (connections per
 * person, idle expiry, public records per connection). A hub can switch endpoints and tools off, lower limits and choose
 * its client trust policy; it can never enable a tool whose capability is off, widen a scope, a data class or a
 * confirmation rule, or lengthen token lifetimes beyond the engine bounds.
 */
export const McpHubPolicySchema = z.strictObject({
  endpoints: z.strictObject({ public: z.boolean(), participant: z.boolean(), admin: z.boolean() }),
  disabledTools: z.array(McpToolNameSchema),
  clientTrust: z.enum(['any_https_client', 'listed_clients_only']),
  listedClients: z.array(z.strictObject({ clientId: z.string().min(1).max(500), displayName: z.string().min(1).max(120) })),
  dynamicRegistration: z.boolean(),
  publicCitedAnswers: z.boolean(),
  accessTokenTtlSeconds: z.int().min(60).max(900),
  refreshAbsoluteDays: z.int().min(1).max(365),
  /** Token buckets per connection (public: per client address and client id). Commits are counted per hour. */
  ratePerMinute: z.strictObject({ read: z.int().min(1).max(600), draft: z.int().min(1).max(120), public: z.int().min(1).max(120) }),
  commitsPerHour: z.int().min(1).max(120),
  maxUploadBytes: z.int().min(1).max(25 * 1024 * 1024),
  revision: RevisionSchema,
}).superRefine((p, ctx) => {
  if (p.clientTrust === 'listed_clients_only' && !p.listedClients.length) ctx.addIssue({ code: 'custom', message: 'listed-only trust needs at least one listed client' });
});
export type McpHubPolicy = z.infer<typeof McpHubPolicySchema>;
/** Engine defaults; the admin endpoint and anonymous cited answers start off. */
export const DEFAULT_MCP_HUB_POLICY: McpHubPolicy = {
  endpoints: { public: true, participant: true, admin: false },
  disabledTools: [],
  clientTrust: 'any_https_client',
  listedClients: [],
  dynamicRegistration: true,
  publicCitedAnswers: false,
  accessTokenTtlSeconds: 900,
  refreshAbsoluteDays: 180,
  ratePerMinute: { read: 60, draft: 20, public: 30 },
  commitsPerHour: 30,
  maxUploadBytes: 10 * 1024 * 1024,
  revision: 1,
};
