import { isRestricted } from '@trustwork/country-packs';
import { coveringAssignments, permissionsFor, rolesFor, rolesGranting } from './access.js';
import { evaluateCommand, type CommandInput, type CommandOutcome } from './commands.js';
import { elevationState } from './elevation.js';
import type { ConsoleRequest } from './personas.js';
import type { ConsoleAccess, ConsoleDataPort, StaffViewer } from './port.js';
import type { HubRecord } from './schemas.js';
import { FIXTURE_NOW } from '../_fixtures/ids.js';
import { engagedOutboundSwitch, HUBS, NODE, OVERVIEWS } from '../_fixtures/hubs.js';
import { SETUP_RUNS, sha256 } from '../_fixtures/setup.js';
import { STAFF, STAFF_PERSONAS } from '../_fixtures/staff.js';
import { APPROVAL_DECISIONS, APPROVAL_REQUESTS } from '../hubs/[hub]/approvals/_fixtures.js';
import { STAFF_INVITATIONS } from '../hubs/[hub]/staff/_fixtures.js';
import { BRAND_CHECKS } from '../hubs/[hub]/hub/identity/_fixtures.js';
import { LEGAL_DOCUMENTS, OPERATORS } from '../hubs/[hub]/hub/legal/_fixtures.js';
import { RESIDENCY } from '../hubs/[hub]/hub/residency/_fixtures.js';
import { LOCAL_ADDITIONS } from '../hubs/[hub]/hub/country/_fixtures.js';
import { TAXONOMY } from '../hubs/[hub]/hub/taxonomy/_fixtures.js';
import { productFor } from '../hubs/[hub]/modules/_kit/product.js';

/**
 * Fixture adapter of the console (demo mode only). Synthetic data from `_fixtures` and the section folders, states
 * computed against the fixture clock, scenarios applied per request. Commands go through the shared evaluation and
 * then stop: nothing is stored.
 */

const now = () => new Date(FIXTURE_NOW);
/** The demo viewer's elevated session (BE-004 shape): confirmed with the authenticator app, 15 minutes long. */
const elevationOf = (personId: string) => ({ id: `el-${personId}`, sessionId: `s-${personId}`, personId, factor: 'totp', createdAt: '2026-10-31T11:55:00Z', expiresAt: '2026-10-31T12:10:00Z', revokedAt: null });

function withScenario(record: HubRecord, request: ConsoleRequest): HubRecord {
  if (!request.demo || request.scenario === 'default') return record;
  if (request.scenario === 'maintenance') return { ...record, modes: { ...record.modes, maintenance: true } };
  if (request.scenario === 'kill-switch-engaged') return { ...record, killSwitches: [...record.killSwitches, engagedOutboundSwitch(record.hub.id)] };
  return record;
}

async function viewer(request: ConsoleRequest): Promise<StaffViewer | null> {
  if (!request.demo || !request.persona) return null;
  const personId = STAFF_PERSONAS[request.persona];
  const person = STAFF.people.find((p) => p.id === personId);
  if (!person) return null;
  return { person, elevation: request.scenario === 'elevation-required' ? { state: 'required' } : elevationState(elevationOf(person.id), person.id, now()) };
}

async function access(v: StaffViewer, target: { nodeId: string; hubId: string | null }): Promise<ConsoleAccess> {
  return { roles: rolesFor(STAFF, v.person.id, target, now()), permissions: [...permissionsFor(STAFF, v.person.id, target, now())] };
}

export const fixtureConsolePort: ConsoleDataPort = {
  source: 'fixtures',
  now,
  viewer,
  async node() {
    return NODE;
  },
  async hubs(request) {
    return HUBS.map((h) => withScenario(h, request));
  },
  async hub(slug, request) {
    const found = HUBS.find((h) => h.hub.slug === slug);
    return found ? withScenario(found, request) : null;
  },
  access,
  async rolesGranting(section) {
    return rolesGranting(section, STAFF);
  },
  async people(ids) {
    return STAFF.people.filter((p) => ids.includes(p.id));
  },
  // HC-150 on fixtures: the synthetic staff whose active assignments cover the hub. Every demo staff member has an
  // authenticator enrolled except the Support Agent, so the "no second factor" state is visible.
  async staff(hubId, detail) {
    const record = HUBS.find((h) => h.hub.id === hubId);
    if (!record) return null;
    const target = { nodeId: record.hub.nodeId, hubId };
    const entries = STAFF.people.flatMap((p) => {
      const covering = coveringAssignments(STAFF, p.id, target, now());
      if (!covering.length) return [];
      return [{
        personId: p.id, displayName: p.displayName,
        roles: detail ? covering.map((a) => ({ assignmentId: a.id, role: a.role, scope: a.scope, validUntil: a.validUntil, breakglass: a.breakglass })) : null,
        secondFactor: detail ? (p.id === 'p-support-agent' ? 'none' as const : 'enrolled' as const) : null,
      }];
    });
    return { hubId, detail, entries };
  },
  async effectiveAccess(hubId, personId) {
    const record = HUBS.find((h) => h.hub.id === hubId);
    if (!record) return null;
    const target = { nodeId: record.hub.nodeId, hubId };
    const roles = rolesFor(STAFF, personId, target, now());
    return roles.length ? { roles, permissions: [...permissionsFor(STAFF, personId, target, now())].sort() } : null;
  },
  async roleCatalogue() {
    const latest = new Map<string, (typeof STAFF.definitions)[number]>();
    for (const d of STAFF.definitions) if ((latest.get(d.role)?.version ?? 0) < d.version) latest.set(d.role, d);
    return [...latest.values()].map((d) => ({ role: d.role, version: d.version, scopes: d.scopes }));
  },
  async staffInvitations(hubId) {
    return HUBS.some((h) => h.hub.id === hubId) ? STAFF_INVITATIONS.filter((i) => i.scope.kind !== 'hub' || i.scope.hubId === hubId) : null;
  },
  async overview(hubId) {
    return OVERVIEWS.find((o) => o.hubId === hubId) ?? null;
  },
  async approvals(hubId) {
    return { requests: APPROVAL_REQUESTS.filter((r) => r.hubId === hubId), decisions: APPROVAL_DECISIONS.filter((d) => d.hubId === hubId) };
  },
  async legal(hubId) {
    return { operator: OPERATORS.find((o) => o.hubId === hubId) ?? null, documents: LEGAL_DOCUMENTS.filter((d) => d.hubId === hubId) };
  },
  async residency(hubId) {
    return RESIDENCY.find((r) => r.hubId === hubId) ?? null;
  },
  async localAdditions(hubId) {
    return [...(LOCAL_ADDITIONS[hubId] ?? [])];
  },
  // The demo claims screen reads its own fixtures; only live mode uses this read.
  claims: async () => null,
  async taxonomy(hubId) {
    return TAXONOMY.filter((t) => t.hubId === hubId);
  },
  async brandChecks(hubId) {
    return [...(BRAND_CHECKS[hubId] ?? [])];
  },
  async product(hubId) {
    return productFor(hubId);
  },
  async setup(token) {
    if (!token) return null;
    const hash = sha256(token);
    const run = SETUP_RUNS.find((r) => r.state.setupTokenHash === hash);
    if (!run || run.state.finishedAt !== null || Date.parse(run.state.setupTokenExpiresAt) <= now().getTime()) return null;
    return run;
  },
  async command(request, input: CommandInput): Promise<CommandOutcome> {
    const v = await viewer(request);
    const hub = input.hubSlug ? await this.hub(input.hubSlug, request) : null;
    const acc = v && hub ? await access(v, { nodeId: hub.hub.nodeId, hubId: hub.hub.id }) : { roles: [], permissions: [] };
    return evaluateCommand(input, {
      viewer: v,
      access: acc,
      hub,
      now: now(),
      offline: request.demo && request.scenario === 'offline',
      requests: hub ? APPROVAL_REQUESTS.filter((r) => r.hubId === hub.hub.id) : [],
      documents: hub ? LEGAL_DOCUMENTS.filter((d) => d.hubId === hub.hub.id) : [],
      setup: input.setupToken ? await this.setup(input.setupToken) : null,
      isRestricted,
      product: hub ? productFor(hub.hub.id) : null,
      staff: hub && input.command.startsWith('staff.') ? await this.staff(hub.hub.id, true) : null,
      catalogue: input.command === 'staff.assign' || input.command === 'staff.invite' ? await this.roleCatalogue() : [],
      invitations: hub && input.command.startsWith('staff.') ? (await this.staffInvitations(hub.hub.id)) ?? [] : [],
      decisions: hub ? APPROVAL_DECISIONS.filter((d) => d.hubId === hub.hub.id) : [],
    });
  },
};
