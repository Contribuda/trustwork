import { z } from 'zod';
import {
  ConsoleSecondPersonActionSchema,
  DIGEST_ALGORITHM,
  HubConfigVersionSchema,
  HubModesSchema,
  HubSchema,
  HubStaffRoleSchema,
  LaunchGateSchema,
  ProviderCapabilitySchema,
  SodModeSchema,
  type ConsolePermission,
  type HubStaffRole,
} from '@trustwork/contracts/client';
import { isRestricted } from '@trustwork/country-packs';
import { ResidencyConfigPayloadSchema } from '../../../../../packages/contracts/src/hub-core.js';
import { EffectiveAccessSchema, StaffDirectorySchema, StaffInvitationViewSchema } from '../../../../../packages/contracts/src/staff-lifecycle.js';
import { evaluateCommand, invitationSeconds, parseTerritory, requestedModes, requestedProfile, type CommandInput, type CommandOutcome, type ActivationTarget, type ReadyApproval, type RejectCode, type WaitingActivation } from './commands.js';
import { priceCommand, readPrices } from './live-prices.js';
import { isPriceCommand, PRICE_COMMANDS } from '../hubs/[hub]/billing/prices/_commands.js';
import type { ConsoleAccess, ConsoleDataPort, StaffViewer } from './port.js';
import type { ConsoleRequest } from './personas.js';
import { OverviewSchema, QUEUE_IDS, ResidencySchema, type Overview, type QueueId, type Residency } from './read-models.js';
import { ApprovalDecisionSchema, ApprovalRequestSchema, ConsoleNodeSchema, HubRecordSchema, LegalDocumentSchema, type ApprovalDecision, type ApprovalRequest, type ConsoleNode, type HubRecord, type LegalDocument } from './schemas.js';
import type { SectionDef } from './section-types.js';

/**
 * The console's live adapter (HUBC-007): the same port as the fixtures, read from the API with the visitor's session
 * cookie: the viewer, the node, hubs, access, roles, approvals, staff, legal documents, residency and the overview.
 * Everything else answers like the unavailable adapter (empty or `null`, commands `not_found`) until its backend route
 * exists, so a live console never shows a fixture or an invented value. Today that is local additions (the `country`
 * configuration holds no additions), the taxonomy (no console read), brand contrast checks (nothing measures them) and
 * the agent product (HUBC-009).
 *
 * Authority stays with the API: every route here is a staff route behind an elevated session (`ElevationGuard`), and
 * row-level security returns only what the viewer may see. A viewer without a staff role is no viewer (every console
 * route renders "not found"); a staff member without a live elevation sees the elevation gate.
 */

/** The reads this adapter needs: parsed JSON of a 2xx answer, `null` for 404 `access.not_found`, otherwise a rejection. */
export interface ConsoleApi {
  get(path: `/v1/${string}`): Promise<unknown | null>;
  /**
   * A staff mutation with the session cookie, the CSRF header, the browser's origin and `Idempotency-Key` (the same
   * key travels in the body as the console contract asks). Never rejects for an HTTP answer: it reports the status and
   * the error code of the envelope.
   */
  post?(path: `/v1/${string}`, body: Record<string, unknown>, idempotencyKey: string): Promise<{ status: number; code: string | null; body?: unknown }>;
}
export interface ApiPortOptions {
  api: ConsoleApi;
  /** A fresh idempotency key per submission (UUID). */
  newKey?: () => string;
  /** Host name of this deployment (the hub's address in the console); one deployment serves its hubs on one host. */
  siteHost: () => string | Promise<string>;
  engineVersion: string;
  now?: () => Date;
}

const MeSchema = z.object({
  person: z.object({ id: z.string().min(1), displayName: z.string().min(1).max(200).nullable() }),
  principal: z.object({ staff: z.array(z.string()).default([]) }),
});
const ElevationViewSchema = z.object({ elevationId: z.string().min(1), expiresAt: z.iso.datetime() });
const NodeViewSchema = z.object({ nodeId: z.string().min(1), label: z.string().min(1).max(120) });
const HubViewSchema = z.object({ hub: HubSchema, createdAt: z.iso.datetime() });
const HubsViewSchema = z.object({ items: z.array(HubViewSchema) });
const ConfigItemsSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });
const ChecklistSchema = z.object({ gates: z.array(z.record(z.string(), z.unknown())) });
const SodViewSchema = z.object({ mode: SodModeSchema });
const AccessViewSchema = z.object({ roles: z.array(z.string()), permissions: z.array(z.string()) });
/** `GET /v1/admin/staff/definitions`: every released definition version (`{ definitions }`, ADM-001 `toDefinition`). */
const DefinitionsViewSchema = z.object({ definitions: z.array(z.object({ role: z.string(), permissions: z.array(z.string()) }).passthrough()) });
/** `GET /v1/admin/staff/definitions` with versions and scopes (the role catalogue of HC-150). */
const CatalogueViewSchema = z.object({ definitions: z.array(z.object({ role: HubStaffRoleSchema, version: z.number().int(), scopes: z.array(z.enum(['platform', 'node', 'hub'])) }).passthrough()) });
const ApprovalViewSchema = z.object({
  id: z.string(),
  action: z.string(),
  scope: z.object({ kind: z.string(), hubId: z.string().optional(), nodeId: z.string().optional() }),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().min(1),
  requestedBy: z.string(),
  requestedAt: z.iso.datetime(),
  requestExpiresAt: z.iso.datetime(),
  status: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  declinedBy: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
/** A hub command answer (`ConsoleCommandResult`, plus the drafted version for configuration drafts). */
const CommandAnswerSchema = z.object({
  result: z.object({ outcome: z.enum(['applied', 'pending_second_person', 'queued']), objectId: z.string(), revision: z.number().int() }),
  version: z.object({ id: z.string(), revision: z.number().int(), activation: z.object({ secondPersonAction: z.string() }).nullable().optional() }).optional(),
});
/** `GET /v1/admin/staff/invitations` and the answer of apply (`applied`, or `pending_second_person` when a second person is asked first). */
const InvitationsViewSchema = z.object({ invitations: z.array(StaffInvitationViewSchema) });
const InvitationApplySchema = z.object({ result: z.object({ outcome: z.enum(['applied', 'pending_second_person']) }) });
/** The machine reason a refusal carries in its envelope (ADM-001 `adminRefusal`). */
const RefusalSchema = z.object({ details: z.object({ reason: z.string() }) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `GET /v1/admin/hubs/:hubId/legal`: one version per document kind and language, with the counsel approvals. */
const LegalViewSchema = z.object({
  documents: z.array(z.object({
    id: z.string(), hubId: z.string(), kind: z.string(), locale: z.string(), version: z.number().int(), status: z.string(), counselApprovalId: z.string().nullable(),
    activatedAt: z.string().nullable(),
  }).passthrough()),
  counselApprovals: z.array(z.object({ id: z.string(), counselName: z.string(), firm: z.string(), approvedOn: z.string(), scopeNote: z.string() }).passthrough()),
});
/** A stored version and the second-person action and digest that activate it (HUB-001 views). */
const ActivatableSchema = z.object({
  id: z.string(), status: z.string(), revision: z.number().int(), draftedBy: z.string().nullable().optional(), draftedAt: z.string().nullable().optional(),
  activation: z.object({ secondPersonAction: z.string(), actionDigest: z.string() }).nullable().optional(),
}).passthrough();
const ActivatableListSchema = z.object({ items: z.array(ActivatableSchema) });
const ActivatableDocsSchema = z.object({ documents: z.array(ActivatableSchema) });
/** `GET /v1/admin/approvals`: requests waiting for the viewer, the viewer's own requests, and decided ones. */
const ApprovalsViewSchema = z.object({ forMe: z.array(z.unknown()).default([]), mine: z.array(z.unknown()).default([]), decided: z.array(z.unknown()).default([]) });

/* The lists the overview counts: each answers for the viewer, under row-level security, up to the route's own limit. */
const ModerationCasesSchema = z.object({ cases: z.array(z.object({ status: z.string() }).passthrough()) });
const SupportCasesSchema = z.object({ cases: z.array(z.object({ hubId: z.string().nullable(), status: z.string() }).passthrough()) });
const ListItemsSchema = z.object({ items: z.array(z.object({ state: z.string() }).passthrough()) });
const ConnectionsSchema = z.object({ items: z.array(z.object({ mode: z.string(), status: z.string(), capabilities: z.array(z.string()) }).passthrough()) });
const ScreeningListsSchema = z.object({ items: z.array(z.object({ hubId: z.string().nullable(), status: z.string(), freshness: z.object({ ageSeconds: z.number().nullable() }).passthrough() }).passthrough()) });
/** Staff decide these moderation cases and support cases; a case waiting for its requester is not waiting for staff. */
const OPEN_MODERATION = new Set(['open', 'in_review', 'appealed']);
const OPEN_SUPPORT = new Set(['open', 'triaged', 'in_progress']);

/** The keys a strict contract schema allows, so an API view with extra fields (activation hints, digests) still parses. */
function pick(row: Record<string, unknown>, schema: { shape: Record<string, unknown> }): Record<string, unknown> {
  return Object.fromEntries(Object.keys(schema.shape).map((k) => [k, row[k] ?? null]));
}
const shapeOf = (schema: unknown): { shape: Record<string, unknown> } => {
  // Refined schemas wrap their object; both expose `shape` through the inner definition.
  const s = schema as { shape?: Record<string, unknown>; _def?: { schema?: { shape: Record<string, unknown> } } };
  return { shape: s.shape ?? s._def?.schema?.shape ?? {} };
};

/** HTTP status of a rejection from the transport (`ApiFailure`), or null. */
function statusOf(error: unknown): number | null {
  return error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : null;
}

/** A read the viewer may not make (401/403) shows nothing; any other failure stays a failure. */
async function orNothing<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403) return null;
    throw error;
  }
}

export function createApiConsolePort(options: ApiPortOptions): ConsoleDataPort {
  const { api } = options;
  const now = options.now ?? (() => new Date());

  async function viewer(request: ConsoleRequest): Promise<StaffViewer | null> {
    if (request.demo) return null;
    const me = MeSchema.safeParse(await api.get('/v1/me'));
    if (!me.success || me.data.principal.staff.length === 0) return null;
    const { person } = me.data;
    const consolePerson = { id: person.id, displayName: person.displayName ?? person.id, nameLang: 'und', synthetic: false };
    try {
      const view = ElevationViewSchema.safeParse(await api.get('/v1/admin/session'));
      const live = view.success && Date.parse(view.data.expiresAt) > now().getTime();
      return { person: consolePerson, elevation: live ? { state: 'elevated', until: view.data.expiresAt } : { state: 'required' } };
    } catch (error) {
      // 401/403: the session has no live elevation (or lost its staff role between the two reads).
      if (statusOf(error) === 401 || statusOf(error) === 403) return { person: consolePerson, elevation: { state: 'required' } };
      throw error;
    }
  }

  async function node(): Promise<ConsoleNode | null> {
    // An unelevated staff session may not read the node (403): the console then shows the elevation gate, never an error.
    const view = NodeViewSchema.safeParse(await orNothing(api.get('/v1/admin/node')));
    if (!view.success) return null;
    return ConsoleNodeSchema.parse({ id: view.data.nodeId, name: view.data.label, domain: await options.siteHost(), engineVersion: options.engineVersion, synthetic: false });
  }

  /** One hub as the console loads it; null when the hub has no active `modes` configuration (nothing to show honestly). */
  async function record(view: z.infer<typeof HubViewSchema>): Promise<HubRecord | null> {
    const hubId = view.hub.id;
    const [current, versions, checklist, sod] = await Promise.all([
      api.get(`/v1/admin/hubs/${hubId}/config/current`),
      api.get(`/v1/admin/hubs/${hubId}/config`),
      api.get(`/v1/admin/hubs/${hubId}/launch`),
      api.get(`/v1/admin/staff/sod?hubId=${hubId}`).catch((error: unknown) => (statusOf(error) === 403 ? null : Promise.reject(error))),
    ]);
    const currentItems = ConfigItemsSchema.safeParse(current);
    const modesRow = currentItems.success ? currentItems.data.items.find((i) => i.domain === 'modes') : undefined;
    const modes = HubModesSchema.safeParse(modesRow?.payload);
    if (!modes.success) return null;
    const configShape = shapeOf(HubConfigVersionSchema);
    const configVersions = (ConfigItemsSchema.safeParse(versions).data?.items ?? [])
      .map((v) => HubConfigVersionSchema.safeParse(pick(v, configShape)))
      .flatMap((r) => (r.success ? [r.data] : []));
    const gateShape = shapeOf(LaunchGateSchema);
    const gates = (ChecklistSchema.safeParse(checklist).data?.gates ?? [])
      .map((g) => LaunchGateSchema.safeParse(pick({ ...g, hubId }, gateShape)))
      .flatMap((r) => (r.success ? [r.data] : []));
    const domain = await options.siteHost();
    const activated = configVersions.map((v) => v.activatedAt).filter((t): t is string => typeof t === 'string').sort();
    return HubRecordSchema.parse({
      hub: view.hub,
      modes: modes.data,
      example: null,
      domain,
      // Without `admin.staff.read` the directory is not visible; the reduced mode is the safe reading (more approvals, not fewer).
      sodMode: SodViewSchema.safeParse(sod).data?.mode ?? 'reduced',
      gates,
      configVersions,
      // No hub-level read of provider budgets or kill switches exists yet (KEYS-001 serves them per connection).
      budgets: [],
      killSwitches: [],
      updatedAt: activated.at(-1) ?? view.createdAt,
      synthetic: false,
    });
  }

  async function hubs(request: ConsoleRequest): Promise<HubRecord[]> {
    if (request.demo) return [];
    const list = HubsViewSchema.safeParse(await orNothing(api.get('/v1/admin/hubs')));
    if (!list.success) return [];
    const records = await Promise.all(list.data.items.map(record));
    return records.filter((r): r is HubRecord => r !== null);
  }

  async function access(v: StaffViewer, target: { nodeId: string; hubId: string | null }): Promise<ConsoleAccess> {
    const query = target.hubId ? `hubId=${target.hubId}` : `nodeId=${target.nodeId}`;
    const view = AccessViewSchema.safeParse(await orNothing(api.get(`/v1/admin/access?${query}`)));
    void v; // the API answers for the session's own person; the viewer argument only keeps the port's signature
    if (!view.success) return { roles: [], permissions: [] };
    return { roles: view.data.roles as HubStaffRole[], permissions: view.data.permissions as ConsolePermission[] };
  }

  async function rolesGranting(section: SectionDef): Promise<HubStaffRole[]> {
    const view = DefinitionsViewSchema.safeParse(await orNothing(api.get('/v1/admin/staff/definitions')));
    if (!view.success) return [];
    const read = section.read;
    return [...new Set(view.data.definitions.filter((d) => read === 'staff' || read.some((p) => d.permissions.includes(p))).map((d) => d.role as HubStaffRole))];
  }

  /**
   * The changes around second-person approvals, matched by activation digest (the API binds an approval to it, so a
   * changed draft never matches):
   * - `ready`: the viewer's approved, unconsumed requests whose draft still waits to be applied;
   * - `waiting`: sensitive drafts with no open or approved request yet, which a staff member other than the drafter
   *   asks a second person to activate.
   */
  async function pendingChanges(hubId: string, rows: readonly unknown[], viewerId: string): Promise<{ ready: ReadyApproval[]; waiting: WaitingActivation[] }> {
    const listed = rows.map((r) => ApprovalViewSchema.safeParse(r)).flatMap((r) => (r.success ? [r.data] : []))
      .filter((a) => a.scope.kind === 'hub' && a.scope.hubId === hubId);
    const live = (a: (typeof listed)[number]) => a.revokedAt === null && (a.expiresAt === null || Date.parse(a.expiresAt) > now().getTime());
    const approved = listed.filter((a) => a.status === 'approved' && live(a) && a.requestedBy === viewerId);
    // A draft with an open request, or with an approval that someone still applies, is not waiting.
    const claimed = new Set(listed.filter((a) => a.status === 'pending' || (a.status === 'approved' && live(a))).map((a) => `${a.action}:${a.actionDigest}`));
    const [versions, legal] = await Promise.all([orNothing(api.get(`/v1/admin/hubs/${hubId}/config`)), orNothing(api.get(`/v1/admin/hubs/${hubId}/legal`))]);
    const targets = [
      ...(ActivatableListSchema.safeParse(versions).data?.items ?? []).map((v) => ({ kind: 'config' as const, v, label: String((v as { domain?: unknown }).domain ?? '') })),
      ...(ActivatableDocsSchema.safeParse(legal).data?.documents ?? []).map((v) => ({ kind: 'legal' as const, v, label: `${String((v as { kind?: unknown }).kind ?? '')} ${String((v as { locale?: unknown }).locale ?? '')}`.trim() })),
    ].filter((t) => t.v.status === 'draft' && t.v.activation);
    const target = (t: (typeof targets)[number]): ActivationTarget => ({ kind: t.kind, id: t.v.id, revision: t.v.revision, label: t.label });
    const ready: ReadyApproval[] = [];
    for (const a of approved) {
      const action = ConsoleSecondPersonActionSchema.safeParse(a.action);
      const match = targets.find((t) => t.v.activation!.actionDigest === a.actionDigest && t.v.activation!.secondPersonAction === a.action);
      if (action.success && match) ready.push({ requestId: a.id, action: action.data, target: target(match) });
    }
    const waiting: WaitingActivation[] = [];
    for (const t of targets) {
      const action = ConsoleSecondPersonActionSchema.safeParse(t.v.activation!.secondPersonAction);
      if (!action.success || claimed.has(`${action.data}:${t.v.activation!.actionDigest}`) || !t.v.draftedBy || !t.v.draftedAt) continue;
      waiting.push({ action: action.data, target: target(t), draftedBy: t.v.draftedBy, draftedAt: t.v.draftedAt });
    }
    return { ready, waiting };
  }

  async function approvals(hubId: string, viewerId: string | null = null): Promise<{ requests: ApprovalRequest[]; decisions: ApprovalDecision[]; ready: ReadyApproval[]; waiting: WaitingActivation[] }> {
    const list = ApprovalsViewSchema.safeParse(await orNothing(api.get(`/v1/admin/approvals?hubId=${hubId}`)));
    const requests: ApprovalRequest[] = [];
    const decisions: ApprovalDecision[] = [];
    const seen = new Set<string>();
    const rows = list.success ? [...list.data.forMe, ...list.data.mine, ...list.data.decided] : [];
    for (const raw of rows) {
      const a = ApprovalViewSchema.safeParse(raw);
      if (!a.success || seen.has(a.data.id)) continue;
      seen.add(a.data.id);
      const action = ConsoleSecondPersonActionSchema.safeParse(a.data.action);
      if (!action.success || a.data.scope.kind !== 'hub' || a.data.scope.hubId !== hubId) continue;
      const digest = { algorithm: DIGEST_ALGORITHM, value: a.data.actionDigest };
      const scope = { kind: 'hub' as const, hubId };
      if (a.data.status === 'pending' || a.data.status === 'withdrawn') {
        const parsed = ApprovalRequestSchema.safeParse({
          id: a.data.id, hubId, action: action.data, scope, actionDigest: digest,
          // The API voids a request whose action changed; what it still lists is current.
          currentDigest: digest, requestedBy: a.data.requestedBy, reason: { value: a.data.reason, lang: 'und' }, requestedAt: a.data.requestedAt,
          expiresAt: a.data.requestExpiresAt, changes: [{ field: 'action', before: { kind: 'none' }, after: { kind: 'key', key: `approvals.actions.${action.data}` } }],
          state: a.data.status, synthetic: false,
        });
        if (parsed.success) requests.push(parsed.data);
      } else if ((a.data.status === 'approved' || a.data.status === 'consumed') && a.data.approvedBy && a.data.approvedAt && a.data.expiresAt) {
        const parsed = ApprovalDecisionSchema.safeParse({
          requestId: a.data.id, hubId, action: action.data, requestedBy: a.data.requestedBy, decision: 'approve', decidedBy: a.data.approvedBy, decidedAt: a.data.approvedAt,
          approval: { id: a.data.id, action: action.data, scope, actionDigest: digest, requestedBy: a.data.requestedBy, approvedBy: a.data.approvedBy, approvedAt: a.data.approvedAt, expiresAt: a.data.expiresAt, revokedAt: a.data.revokedAt },
          synthetic: false,
        });
        if (parsed.success) decisions.push(parsed.data);
      }
      // A decline is not listed yet: the approval view has no decision time, and the console never shows an invented one.
    }
    // Only the viewer's own approvals can be applied by the viewer: without an explicit viewer, the session's person.
    const me = viewerId ?? (MeSchema.safeParse(await orNothing(api.get('/v1/me'))).data?.person.id ?? null);
    const { ready, waiting } = list.success && me ? await pendingChanges(hubId, rows, me) : { ready: [], waiting: [] };
    return { requests, decisions, ready, waiting };
  }

  /**
   * The hub's data residency from its active `residency` configuration version. Which region serves each service and who
   * the sub-processors are is recorded nowhere yet, so both stay empty and the screen says so; the legal regime likewise.
   */
  async function residency(hubId: string): Promise<Residency | null> {
    const current = ConfigItemsSchema.safeParse(await orNothing(api.get(`/v1/admin/hubs/${hubId}/config/current`)));
    const row = current.success ? current.data.items.find((i) => i.domain === 'residency') : undefined;
    const payload = ResidencyConfigPayloadSchema.safeParse(row?.payload);
    const version = z.int().min(1).safeParse(row?.version);
    if (!payload.success || !version.success) return null;
    return ResidencySchema.parse({
      hubId, country: payload.data.hostingCountry, regime: 'not_recorded', version: version.data, hostingRegion: payload.data.hostingRegion, personalDataCountries: payload.data.personalDataCountries,
      note: payload.data.note ?? null, services: [], subProcessors: [], synthetic: false,
    });
  }

  /**
   * The overview from the lists that exist: counts of what waits for staff (each list answers for this viewer, up to its
   * route's limit), the oldest screening list and the capabilities still served by a fake provider. A queue with no read
   * or a read the viewer may not make is `uncounted`, never zero. Legal documents due, expiring licences and the health
   * checks have no read yet: `null`, and no health tiles.
   */
  async function overview(hubId: string): Promise<Overview | null> {
    const hub = encodeURIComponent(hubId);
    const [moderation, support, links, alerts, connections, lists] = await Promise.all([
      orNothing(api.get(`/v1/admin/moderation/cases?hubId=${hub}`)),
      orNothing(api.get('/v1/admin/support/cases')),
      orNothing(api.get(`/v1/admin/hubs/${hub}/record-links?state=proposed`)),
      orNothing(api.get(`/v1/admin/hubs/${hub}/pipeline-alerts`)),
      orNothing(api.get(`/v1/admin/hubs/${hub}/providers/connections`)),
      orNothing(api.get('/v1/admin/screening/lists')),
    ]);
    const counts = new Map<QueueId, number>();
    const moderationCases = ModerationCasesSchema.safeParse(moderation);
    if (moderationCases.success) counts.set('reports', moderationCases.data.cases.filter((c) => OPEN_MODERATION.has(c.status)).length);
    const supportCases = SupportCasesSchema.safeParse(support);
    if (supportCases.success) {
      const here = supportCases.data.cases.filter((c) => c.hubId === hubId);
      counts.set('support_cases', here.filter((c) => OPEN_SUPPORT.has(c.status)).length);
      counts.set('grant_requests', here.filter((c) => c.status === 'grant_requested').length);
    }
    const proposals = ListItemsSchema.safeParse(links);
    if (proposals.success) counts.set('link_proposals', proposals.data.items.filter((l) => l.state === 'proposed').length);
    const open = ListItemsSchema.safeParse(alerts);
    if (open.success) counts.set('alerts', open.data.items.filter((a) => a.state === 'open').length);
    const served = ConnectionsSchema.safeParse(connections);
    const fakeProviders = served.success
      ? [...new Set(served.data.items.filter((c) => c.mode === 'fake' && c.status === 'enabled').flatMap((c) => c.capabilities))].flatMap((c) => {
          const capability = ProviderCapabilitySchema.safeParse(c);
          return capability.success ? [capability.data] : [];
        })
      : null;
    const ages = (ScreeningListsSchema.safeParse(lists).data?.items ?? []).filter((l) => l.status === 'active' && (l.hubId === null || l.hubId === hubId)).flatMap((l) => (l.freshness.ageSeconds === null ? [] : [l.freshness.ageSeconds]));
    return OverviewSchema.parse({
      hubId, queues: [...counts].map(([id, count]) => ({ id, count, nearestDeadline: null })), uncounted: QUEUE_IDS.filter((q) => !counts.has(q)),
      compliance: { legalDocumentsDue: null, screeningListAgeDays: ages.length ? Math.floor(Math.max(...ages) / 86_400) : null, expiringSourceLicences: null, fakeProviders },
      health: [], updatedAt: now().toISOString(), synthetic: false,
    });
  }

  /** The console commands wired to API routes so far; everything else is `not_found` in live mode. */
  const LIVE_COMMANDS = new Set<CommandInput['command']>([
    ...PRICE_COMMANDS,
    'approvals.decide', 'approvals.withdraw', 'approvals.apply', 'approvals.request_activation', 'staff.assign', 'staff.revoke', 'staff.invite', 'staff.invitation_apply', 'staff.invitation_withdraw', 'identity.save', 'modes.save', 'modules.toggle', 'lifecycle.request',
    'launch.mark_passed', 'residency.request_change', 'legal.draft',
  ]);

  /** An API refusal as a console reject code (the API decides; the console only words it). */
  function refusal(status: number, code: string | null): CommandOutcome {
    if (status === 404) return { status: 'not_found' };
    const as = (c: RejectCode): CommandOutcome => ({ status: 'rejected', code: c, field: null, detail: [] });
    if (status === 401) return as('elevation_required');
    if (status === 403) return as(code === 'access.second_approver_required' ? 'own_request' : 'denied');
    if (status === 409) return as('request_void');
    return as('invalid');
  }

  /** A refused invitation command: the specific reason when the envelope names one the console has words for. */
  function invitationRefusal(answer: { status: number; code: string | null; body?: unknown }): CommandOutcome {
    const as = (code: RejectCode): CommandOutcome => ({ status: 'rejected', code, field: null, detail: [] });
    const reason = RefusalSchema.safeParse(answer.body).data?.details.reason;
    if (reason === 'invitation_open') return { status: 'rejected', code: 'invitation_open', field: 'email', detail: [] };
    if (reason === 'self_grant') return { status: 'rejected', code: 'self_grant', field: 'email', detail: [] };
    if (reason === 'invitation_expired') return as('invitation_expired');
    if (reason === 'invalid_transition') return as('invitation_closed');
    if (reason === 'not_requester') return as('not_inviter');
    if (reason === 'approval_not_approved') return as('second_person_pending');
    return refusal(answer.status, answer.code);
  }

  async function command(request: ConsoleRequest, input: CommandInput): Promise<CommandOutcome> {
    if (request.demo || !LIVE_COMMANDS.has(input.command) || !api.post) return { status: 'not_found' };
    const v = await viewer(request);
    const hub = v && input.hubSlug ? (await hubs(request)).find((h) => h.hub.slug === input.hubSlug) ?? null : null;
    if (!v || !hub) return { status: 'not_found' };
    const acc = await access(v, { nodeId: hub.hub.nodeId, hubId: hub.hub.id });
    const { requests, decisions, ready, waiting } = await approvals(hub.hub.id, v.person.id);
    const staffCommand = input.command === 'staff.assign' || input.command === 'staff.revoke';
    const staffView = staffCommand ? await port.staff(hub.hub.id, true) : null;
    const catalogue = input.command === 'staff.assign' || input.command === 'staff.invite' ? await port.roleCatalogue() : [];
    const invitations = input.command.startsWith('staff.invit') ? (await port.staffInvitations(hub.hub.id)) ?? [] : [];
    // The same checks as everywhere in the console first (role, elevation, reason, own request, digest); the API repeats them as the authority.
    const checked = evaluateCommand(input, { viewer: v, access: acc, hub, now: now(), offline: false, requests, documents: [], setup: null, isRestricted, ready, waiting, staff: staffView, catalogue, invitations, decisions });
    if (checked.status !== 'demo_not_saved') return checked;
    const f = input.fields;
    const newKey = options.newKey ?? (() => crypto.randomUUID());
    const send = (path: `/v1/${string}`, rest: Record<string, unknown>) => {
      const k = newKey();
      return api.post!(path, { contractVersion: '1.0.0', idempotencyKey: k, reason: input.reason.trim(), ...rest }, k);
    };
    const settled = (answer: { status: number; code: string | null; body?: unknown }): CommandOutcome => {
      if (answer.status < 200 || answer.status >= 300) return refusal(answer.status, answer.code);
      const parsed = CommandAnswerSchema.safeParse(answer.body);
      return parsed.success && parsed.data.result.outcome === 'pending_second_person' ? { status: 'pending_second_person', secondPerson: checked.secondPerson } : { status: 'applied' };
    };
    const hubPath = `/v1/admin/hubs/${encodeURIComponent(hub.hub.id)}` as const;
    // A configuration version drafted, then activated with its revision (a sensitive domain answers pending_second_person).
    const draftAndActivate = async (domain: string, payload: Record<string, unknown>): Promise<CommandOutcome> => {
      const drafted = await send(`${hubPath}/config`, { domain, payload });
      if (drafted.status < 200 || drafted.status >= 300) return refusal(drafted.status, drafted.code);
      const version = CommandAnswerSchema.safeParse(drafted.body).data?.version;
      if (!version) return { status: 'rejected', code: 'invalid', field: null, detail: [] };
      // A sensitive domain: the drafter never activates their own version; it waits for another staff member.
      if (version.activation) {
        const action = ConsoleSecondPersonActionSchema.safeParse(version.activation.secondPersonAction);
        return { status: 'draft_saved', secondPerson: action.success ? action.data : null };
      }
      return settled(await send(`${hubPath}/config/${encodeURIComponent(version.id)}/activate`, { expectedRevision: version.revision, approvalId: null }));
    };
    if (input.command === 'staff.assign') {
      // A hub role from the latest released definition; the API checks the grantor, conflicts and sensitivity again.
      const definition = catalogue.find((d) => d.role === f.role)!;
      return settled(await send('/v1/admin/staff/assignments', { personId: f.personId, role: definition.role, scope: { kind: 'hub', hubId: hub.hub.id }, definitionVersion: definition.version }));
    }
    if (input.command === 'staff.revoke') {
      return settled(await send(`/v1/admin/staff/assignments/${encodeURIComponent(f.assignmentId ?? '')}/revoke`, {}));
    }
    if (input.command === 'staff.invite') {
      // One role at this hub, from its latest released definition, for an address; the API refuses the inviter's own address.
      const definition = catalogue.find((d) => d.role === f.role)!;
      const answer = await send('/v1/admin/staff/invitations', { email: (f.email ?? '').trim(), role: definition.role, scope: { kind: 'hub', hubId: hub.hub.id }, definitionVersion: definition.version,
        validForSeconds: invitationSeconds(f.validForDays) });
      return answer.status >= 200 && answer.status < 300 ? { status: 'applied' } : invitationRefusal(answer);
    }
    if (input.command === 'staff.invitation_apply') {
      // The first apply of a sensitive role asks a second person; once approved, the same call assigns the role.
      const answer = await send(`/v1/admin/staff/invitations/${encodeURIComponent(f.invitationId ?? '')}/apply`, {});
      if (answer.status < 200 || answer.status >= 300) return invitationRefusal(answer);
      return InvitationApplySchema.safeParse(answer.body).data?.result.outcome === 'pending_second_person' ? { status: 'pending_second_person', secondPerson: 'staff.assign_sensitive_role' } : { status: 'applied' };
    }
    if (isPriceCommand(input.command)) {
      const post = (path: `/v1/${string}`, rest: Record<string, unknown>) => api.post!(path, { reason: input.reason.trim(), ...rest }, newKey());
      return priceCommand(input.command, f, { post, send, read: () => readPrices(api, orNothing, hub.hub.id, v.person.id, now()), form: { currency: hub.hub.currency, now: now() }, viewerId: v.person.id, hubId: hub.hub.id });
    }
    if (input.command === 'staff.invitation_withdraw') {
      const answer = await send(`/v1/admin/staff/invitations/${encodeURIComponent(f.invitationId ?? '')}/withdraw`, {});
      return answer.status >= 200 && answer.status < 300 ? { status: 'applied' } : invitationRefusal(answer);
    }
    if (input.command === 'approvals.request_activation') {
      // Activation without an approval by someone other than the drafter: the API opens the second-person request.
      const item = waiting.find((w) => w.target.id === f.targetId)!;
      const route = item.target.kind === 'config' ? `${hubPath}/config/${encodeURIComponent(item.target.id)}/activate` : `${hubPath}/legal/${encodeURIComponent(item.target.id)}/activate`;
      return settled(await send(route as `/v1/${string}`, { expectedRevision: item.target.revision, approvalId: null }));
    }
    if (input.command === 'approvals.apply') {
      // The approved change itself, with the approval: the version's own activation route and its current revision.
      const item = ready.find((r) => r.requestId === f.requestId)!;
      const route = item.target.kind === 'config' ? `${hubPath}/config/${encodeURIComponent(item.target.id)}/activate` : `${hubPath}/legal/${encodeURIComponent(item.target.id)}/activate`;
      return settled(await send(route as `/v1/${string}`, { expectedRevision: item.target.revision, approvalId: item.requestId }));
    }
    if (input.command === 'legal.draft') {
      // A new draft version of one document in one hub language; activation needs counsel approval and a second person.
      return settled(await send(`${hubPath}/legal`, { kind: f.kind, locale: f.locale, body: f.body ?? '' }));
    }
    if (input.command === 'residency.request_change') {
      // Hosting and personal data in the named country; the API asks a second person (`hub.change_residency`).
      const country = (f.country ?? '').trim().toUpperCase();
      return draftAndActivate('residency', { hostingCountry: country, hostingRegion: null, personalDataCountries: [country] });
    }
    if (input.command === 'modes.save' || input.command === 'modules.toggle') {
      // A new `modes` configuration version, then its activation (a raise to supervised autonomy asks a second person).
      const modes = requestedModes(input, hub);
      if (!modes) return { status: 'rejected', code: 'invalid', field: null, detail: [] };
      return draftAndActivate('modes', modes);
    }
    if (input.command === 'identity.save') {
      // The profile (names, languages, default language, time zone, currency) with the hub revision, then a new territory
      // through its own route; nothing is sent when nothing changes.
      const profile = requestedProfile(input, hub);
      if ('field' in profile) return { status: 'rejected', code: 'invalid', field: profile.field, detail: [] };
      const territory = (f.addTerritory ?? '').trim() ? parseTerritory(f.addTerritory ?? '') : null;
      if (!profile.changed && !territory) return { status: 'rejected', code: 'invalid', field: null, detail: [] };
      if (profile.changed) {
        const answer = await send(`${hubPath}/profile`, { name: profile.name, defaultLocale: profile.defaultLocale, locales: profile.locales, timeZone: profile.timeZone,
          currency: profile.currency, brandOverlay: hub.hub.brandOverlay, expectedRevision: hub.hub.revision });
        if (answer.status < 200 || answer.status >= 300 || !territory) return settled(answer);
      }
      return settled(await send(`${hubPath}/territories`, { territory: { level: territory!.level, code: territory!.code } }));
    }
    if (input.command === 'lifecycle.request') {
      return settled(await send(`${hubPath}/lifecycle`, { to: f.to, expectedRevision: hub.hub.revision, approvalId: null }));
    }
    if (input.command === 'launch.mark_passed') {
      // The API records a gate check against an evidence record (its id); a free-text reference is not evidence.
      const evidence = (f.evidence ?? '').trim();
      if (!UUID.test(evidence)) return { status: 'rejected', code: 'invalid', field: 'evidence', detail: [] };
      return settled(await send(`${hubPath}/launch/check`, { gate: f.gate, evidenceRef: evidence }));
    }
    const key = newKey();
    const base = { contractVersion: '1.0.0', idempotencyKey: key, reason: input.reason.trim() };
    const id = encodeURIComponent(f.requestId ?? '');
    const call =
      input.command === 'approvals.withdraw'
        ? api.post(`/v1/admin/approvals/${id}/withdraw`, base, key)
        : f.decision === 'approve'
          ? api.post(`/v1/admin/approvals/${id}/approve`, { ...base, actionDigest: f.digest ?? '' }, key)
          : api.post(`/v1/admin/approvals/${id}/decline`, base, key);
    const answer = await call;
    return answer.status >= 200 && answer.status < 300 ? { status: 'applied' } : refusal(answer.status, answer.code);
  }

  const port: ConsoleDataPort = {
    source: 'api',
    now,
    viewer,
    node,
    hubs,
    async hub(slug, request) {
      return (await hubs(request)).find((h) => h.hub.slug === slug) ?? null;
    },
    access,
    rolesGranting,
    // No staff directory read for display names yet; screens fall back to the person id.
    // Names come only from the ADM-004 staff directories of the hubs the viewer covers: staff are named to staff, and
    // nobody else is named at all.
    async people(ids) {
      if (ids.length === 0) return [];
      const list = HubsViewSchema.safeParse(await orNothing(api.get('/v1/admin/hubs')));
      const found = new Map<string, { id: string; displayName: string; nameLang: string; synthetic: false }>();
      for (const item of list.success ? list.data.items : []) {
        const view = StaffDirectorySchema.safeParse(await orNothing(api.get(`/v1/admin/staff/directory?hubId=${encodeURIComponent(item.hub.id)}`)));
        for (const e of view.success ? view.data.entries : []) if (ids.includes(e.personId)) found.set(e.personId, { id: e.personId, displayName: e.displayName, nameLang: 'und', synthetic: false });
      }
      return [...found.values()];
    },
    async staff(hubId) {
      const view = StaffDirectorySchema.safeParse(await orNothing(api.get(`/v1/admin/staff/directory?hubId=${encodeURIComponent(hubId)}`)));
      return view.success ? view.data : null;
    },
    async effectiveAccess(hubId, personId) {
      const view = EffectiveAccessSchema.safeParse(await orNothing(api.get(`/v1/admin/staff/effective-access?hubId=${encodeURIComponent(hubId)}&personId=${encodeURIComponent(personId)}`)));
      return view.success ? { roles: view.data.roles, permissions: view.data.permissions } : null;
    },
    async roleCatalogue() {
      const view = CatalogueViewSchema.safeParse(await orNothing(api.get('/v1/admin/staff/definitions')));
      if (!view.success) return [];
      const latest = new Map<string, { role: HubStaffRole; version: number; scopes: Array<'platform' | 'node' | 'hub'> }>();
      for (const d of view.data.definitions) if ((latest.get(d.role)?.version ?? 0) < d.version) latest.set(d.role, { role: d.role, version: d.version, scopes: d.scopes });
      return [...latest.values()];
    },
    async staffInvitations(hubId) {
      const view = InvitationsViewSchema.safeParse(await orNothing(api.get(`/v1/admin/staff/invitations?hubId=${encodeURIComponent(hubId)}`)));
      return view.success ? view.data.invitations : null;
    },
    overview,
    approvals,
    // One console document per stored version (the API keeps a version per kind and language); the operator record has no
    // read yet, so it stays empty rather than invented.
    async legal(hubId) {
      const view = LegalViewSchema.safeParse(await orNothing(api.get(`/v1/admin/hubs/${hubId}/legal`)));
      if (!view.success) return { operator: null, documents: [] };
      const documents: LegalDocument[] = [];
      for (const d of view.data.documents) {
        const counsel = view.data.counselApprovals.find((c) => c.id === d.counselApprovalId) ?? null;
        const status = d.status === 'draft' ? (counsel ? 'counsel_approved' : 'draft') : d.status;
        const parsed = LegalDocumentSchema.safeParse({
          id: d.id, hubId: d.hubId, kind: d.kind, version: d.version, status, locales: [d.locale],
          counselApproval: counsel ? { by: counsel.counselName, firm: counsel.firm, at: `${counsel.approvedOn.slice(0, 10)}T00:00:00.000Z`, scope: counsel.scopeNote.slice(0, 280) } : null,
          effectiveFrom: d.status === 'active' || d.status === 'superseded' ? d.activatedAt : null, synthetic: false,
        });
        if (parsed.success) documents.push(parsed.data);
      }
      return { operator: null, documents };
    },
    residency,
    localAdditions: async () => [],
    taxonomy: async () => [],
    brandChecks: async () => [],
    product: async () => null,
    // HC-91: fees, sale prices and usage prices of the hub this deployment serves (`live-prices.ts`).
    async prices(hubId) {
      const me = MeSchema.safeParse(await orNothing(api.get('/v1/me'))).data?.person.id ?? null;
      return readPrices(api, orNothing, hubId, me, now());
    },
    // The live setup wizard reads `/v1/setup` itself (HUB-004, setup/_live); the console port has no setup run.
    setup: async () => null,
    // Commands are wired one by one with their backend routes (LIVE_COMMANDS); the others are not found in live mode.
    command,
  };
  return port;
}
