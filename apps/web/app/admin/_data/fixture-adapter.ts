import { isRestricted } from '@trustwork/country-packs';
import { permissionsFor, rolesFor, rolesGranting } from './access.js';
import { evaluateCommand, type CommandInput, type CommandOutcome } from './commands.js';
import type { ConsoleRequest } from './personas.js';
import type { ConsoleAccess, ConsoleDataPort, StaffViewer } from './port.js';
import type { HubRecord } from './schemas.js';
import { FIXTURE_NOW } from '../_fixtures/ids.js';
import { engagedOutboundSwitch, HUBS, NODE, OVERVIEWS } from '../_fixtures/hubs.js';
import { SETUP_RUNS, sha256 } from '../_fixtures/setup.js';
import { STAFF, STAFF_PERSONAS } from '../_fixtures/staff.js';
import { APPROVAL_DECISIONS, APPROVAL_REQUESTS } from '../hubs/[hub]/approvals/_fixtures.js';
import { BRAND_CHECKS } from '../hubs/[hub]/hub/identity/_fixtures.js';
import { LEGAL_DOCUMENTS, OPERATORS } from '../hubs/[hub]/hub/legal/_fixtures.js';
import { RESIDENCY } from '../hubs/[hub]/hub/residency/_fixtures.js';
import { LOCAL_ADDITIONS } from '../hubs/[hub]/hub/country/_fixtures.js';
import { TAXONOMY } from '../hubs/[hub]/hub/taxonomy/_fixtures.js';

/**
 * Fixture adapter of the console (demo mode only). Synthetic data from `_fixtures` and the section folders, states
 * computed against the fixture clock, scenarios applied per request. Commands go through the shared evaluation and
 * then stop: nothing is stored.
 */

const now = () => new Date(FIXTURE_NOW);
const ELEVATED_UNTIL = '2026-10-31T12:30:00Z';

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
  return { person, elevation: request.scenario === 'elevation-required' ? { state: 'required' } : { state: 'elevated', until: ELEVATED_UNTIL } };
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
  async taxonomy(hubId) {
    return TAXONOMY.filter((t) => t.hubId === hubId);
  },
  async brandChecks(hubId) {
    return [...(BRAND_CHECKS[hubId] ?? [])];
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
    });
  },
};
