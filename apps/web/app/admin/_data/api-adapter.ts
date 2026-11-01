import { z } from 'zod';
import {
  ConsoleSecondPersonActionSchema,
  DIGEST_ALGORITHM,
  HubConfigVersionSchema,
  HubModesSchema,
  HubSchema,
  LaunchGateSchema,
  SodModeSchema,
  type ConsolePermission,
  type HubStaffRole,
} from '@trustwork/contracts/client';
import type { ConsoleAccess, ConsoleDataPort, StaffViewer } from './port.js';
import type { ConsoleRequest } from './personas.js';
import { ApprovalDecisionSchema, ApprovalRequestSchema, ConsoleNodeSchema, HubRecordSchema, type ApprovalDecision, type ApprovalRequest, type ConsoleNode, type HubRecord } from './schemas.js';
import type { SectionDef } from './section-types.js';

/**
 * The console's live adapter (HUBC-007): the same port as the fixtures, read from the API with the visitor's session
 * cookie. First slice: the viewer, the node, hubs, access, roles and approvals. Everything else answers like the
 * unavailable adapter (empty or `null`, commands `not_found`) until its backend route exists, so a live console never
 * shows a fixture or an invented value.
 *
 * Authority stays with the API: every route here is a staff route behind an elevated session (`ElevationGuard`), and
 * row-level security returns only what the viewer may see. A viewer without a staff role is no viewer (every console
 * route renders "not found"); a staff member without a live elevation sees the elevation gate.
 */

/** The reads this adapter needs: parsed JSON of a 2xx answer, `null` for 404 `access.not_found`, otherwise a rejection. */
export interface ConsoleApi {
  get(path: `/v1/${string}`): Promise<unknown | null>;
}
export interface ApiPortOptions {
  api: ConsoleApi;
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
const DefinitionsViewSchema = z.object({ items: z.array(z.object({ role: z.string(), permissions: z.array(z.string()) })) });
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
const ApprovalsViewSchema = z.object({ items: z.array(z.unknown()) });

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
    const view = NodeViewSchema.safeParse(await api.get('/v1/admin/node'));
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
    const list = HubsViewSchema.safeParse(await api.get('/v1/admin/hubs'));
    if (!list.success) return [];
    const records = await Promise.all(list.data.items.map(record));
    return records.filter((r): r is HubRecord => r !== null);
  }

  async function access(v: StaffViewer, target: { nodeId: string; hubId: string | null }): Promise<ConsoleAccess> {
    const query = target.hubId ? `hubId=${target.hubId}` : `nodeId=${target.nodeId}`;
    const view = AccessViewSchema.safeParse(await api.get(`/v1/admin/access?${query}`));
    void v; // the API answers for the session's own person; the viewer argument only keeps the port's signature
    if (!view.success) return { roles: [], permissions: [] };
    return { roles: view.data.roles as HubStaffRole[], permissions: view.data.permissions as ConsolePermission[] };
  }

  async function rolesGranting(section: SectionDef): Promise<HubStaffRole[]> {
    const view = DefinitionsViewSchema.safeParse(await api.get('/v1/admin/staff/definitions'));
    if (!view.success) return [];
    const read = section.read;
    return view.data.items.filter((d) => read === 'staff' || read.some((p) => d.permissions.includes(p))).map((d) => d.role as HubStaffRole);
  }

  async function approvals(hubId: string): Promise<{ requests: ApprovalRequest[]; decisions: ApprovalDecision[] }> {
    const list = ApprovalsViewSchema.safeParse(await api.get(`/v1/admin/approvals?hubId=${hubId}`));
    const requests: ApprovalRequest[] = [];
    const decisions: ApprovalDecision[] = [];
    for (const raw of list.data?.items ?? []) {
      const a = ApprovalViewSchema.safeParse(raw);
      if (!a.success) continue;
      const action = ConsoleSecondPersonActionSchema.safeParse(a.data.action);
      if (!action.success || a.data.scope.kind !== 'hub' || a.data.scope.hubId !== hubId) continue;
      const digest = { algorithm: DIGEST_ALGORITHM, value: a.data.actionDigest };
      const scope = { kind: 'hub' as const, hubId };
      if (a.data.status === 'pending' || a.data.status === 'withdrawn') {
        const parsed = ApprovalRequestSchema.safeParse({
          id: a.data.id, hubId, action: action.data, scope, actionDigest: digest,
          // The API voids a request whose action changed; what it still lists is current.
          currentDigest: digest, requestedBy: a.data.requestedBy, reason: { value: a.data.reason, lang: 'und' }, requestedAt: a.data.requestedAt,
          expiresAt: a.data.requestExpiresAt, changes: [{ field: 'action', before: { kind: 'none' }, after: { kind: 'key', key: action.data } }],
          state: a.data.status, synthetic: false,
        });
        if (parsed.success) requests.push(parsed.data);
      } else if (a.data.status === 'approved' && a.data.approvedBy && a.data.approvedAt && a.data.expiresAt) {
        const parsed = ApprovalDecisionSchema.safeParse({
          requestId: a.data.id, hubId, action: action.data, requestedBy: a.data.requestedBy, decision: 'approve', decidedBy: a.data.approvedBy, decidedAt: a.data.approvedAt,
          approval: { id: a.data.id, action: action.data, scope, actionDigest: digest, requestedBy: a.data.requestedBy, approvedBy: a.data.approvedBy, approvedAt: a.data.approvedAt, expiresAt: a.data.expiresAt, revokedAt: a.data.revokedAt },
          synthetic: false,
        });
        if (parsed.success) decisions.push(parsed.data);
      }
      // A decline is not listed yet: the approval view has no decision time, and the console never shows an invented one.
    }
    return { requests, decisions };
  }

  return {
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
    people: async () => [],
    overview: async () => null,
    approvals,
    legal: async () => ({ operator: null, documents: [] }),
    residency: async () => null,
    localAdditions: async () => [],
    taxonomy: async () => [],
    brandChecks: async () => [],
    product: async () => null,
    // The live setup wizard reads `/v1/setup` itself (HUB-004, setup/_live); the console port has no setup run.
    setup: async () => null,
    // Commands are wired one by one with their backend routes; until then live mode refuses them as not found.
    command: async () => ({ status: 'not_found' }),
  };
}
