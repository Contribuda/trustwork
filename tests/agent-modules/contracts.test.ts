import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import * as m from '../../packages/contracts/src/agent-modules.js';
import { AgentModuleManifestSchema, agentDispatchBlocked, type AgentCapability } from '../../packages/contracts/src/agent-catalog.js';
import { CONFIG_PAYLOAD_SCHEMAS } from '../../packages/contracts/src/hub-core.js';
import { KillSwitchScopeSchema } from '../../packages/contracts/src/hub.js';
import { IDEMPOTENT_ROUTES } from '../../apps/api/src/common/idempotency/routes.js';
import { IDEMPOTENT } from '../../apps/api/src/common/request.js';
import { AdminAgentModulesController, AgentJobsController } from '../../apps/api/src/modules/agent-modules/agent-modules.controller.js';
import { jobApprovalPolicy } from '../../apps/api/src/modules/agent-modules/jobs.service.js';
import { ENGINE_MANIFESTS } from '../../apps/api/src/modules/agent-modules/ports.js';
import { PLANNER, PLANNER_COMMIT, PLANNER_READ, REGISTRY, usHubPolicy, withSwitch } from './fixtures.js';

/**
 * AGT-003 without a database: manifest-bounded hub policies (no widening), eligibility, defaults within maximums, job
 * templates and triggers in the principal's time zone and the hub calendar, the guard rails no configuration key can
 * switch off (schema test), the surface-independent capability check, the preview diff, the additive kill-switch scope,
 * and the rule that no module code path branches on a country code.
 */
const HUB = 'hub-us-demo';
const person = { kind: 'person' as const, planKey: 'free', companyVerified: false };

test('engine manifests load, and the engine default policy is a valid document that switches nothing off', () => {
  assert.ok(ENGINE_MANIFESTS.length >= 5);
  for (const manifest of ENGINE_MANIFESTS) assert.ok(AgentModuleManifestSchema.safeParse(manifest).success, manifest.key);
  const def = m.engineDefaultPolicy(HUB, REGISTRY);
  assert.ok(m.AgentPolicyDraftSchema.safeParse(def).success);
  assert.deepEqual(m.policyDocumentViolations(def, REGISTRY), []);
  for (const manifest of ENGINE_MANIFESTS) for (const c of manifest.capabilities) assert.equal(m.capabilityRefusal(def, REGISTRY, c.id, person), null, c.id);
  // Commitment modules never act for an unverified company, even by default.
  const task = ENGINE_MANIFESTS.find((x) => x.key === 'task_marketplace')!;
  assert.equal(m.capabilityRefusal(def, REGISTRY, 'task_marketplace.accept_offer', { kind: 'company_member', planKey: 'free', companyVerified: false }), 'module.verified_company_required');
  assert.equal(m.capabilityRefusal(def, REGISTRY, 'task_marketplace.accept_offer', { kind: 'company_member', planKey: 'free', companyVerified: true }), null);
  assert.ok(task.actions.includes('place_order'));
  // A module without a manifest is not governed (yet); kill switches still apply to it.
  assert.equal(m.capabilityRefusal(def, REGISTRY, 'deal_desk.place_order', person), null);
});

test('a hub never widens a module beyond its manifest: actions, capabilities (tools) and data classes', () => {
  const ok = usHubPolicy(HUB);
  assert.deepEqual(m.policyDocumentViolations(ok, REGISTRY), []);
  const planner = ok.modules[0]!;
  const widen = (patch: Partial<typeof planner>) => m.policyDocumentViolations({ ...ok, modules: [{ ...planner, ...patch }, ok.modules[1]!] }, REGISTRY);
  assert.ok(widen({ actions: [...planner.actions, 'place_order'] }).some((p) => p.startsWith('widening: project_planner action place_order')));
  assert.ok(widen({ capabilityIds: [...planner.capabilityIds, 'project_planner.export_everything'] }).some((p) => p.includes('capability project_planner.export_everything')));
  assert.ok(widen({ dataClasses: ['private_projects', 'budgets', 'negotiation_constraints'] }).some((p) => p.includes('data class negotiation_constraints')));
  // Narrowing is fine, as long as each kept capability keeps what it needs.
  assert.deepEqual(widen({ actions: ['prepare'], capabilityIds: ['project_planner.get_plan', 'project_planner.draft_plan'] }), []);
  assert.ok(widen({ actions: ['prepare'], capabilityIds: [PLANNER_COMMIT] }).some((p) => p.includes(`capability ${PLANNER_COMMIT} needs action publish`)));
  assert.ok(widen({ dataClasses: [] }).some((p) => p.includes('needs its private data classes')));
  // Unknown modules and lowered free floors are refused (AGT-002 hubPolicyViolations).
  const unknown = { ...ok, policy: { ...ok.policy, enabledModules: [...ok.policy.enabledModules, { moduleKey: 'order_desk', moduleVersion: '1.0.0', freeQuota: [], settings: {} }] } };
  assert.ok(m.policyDocumentViolations(unknown, REGISTRY).includes('unknown module order_desk@1.0.0'));
  const lowered = { ...ok, policy: { ...ok.policy, enabledModules: ok.policy.enabledModules.map((e) => ({ ...e, freeQuota: [] })) } };
  assert.ok(m.policyDocumentViolations(lowered, REGISTRY).some((p) => p.startsWith('free floor reduced')));
  assert.ok(m.policyDocumentViolations({ ...ok, policy: { ...ok.policy, activeExtensionVersionIds: ['missing-extension'] } }, REGISTRY).some((p) => p.includes('not an activated registry version')));
  // Extensions add capabilities only when their version is active in the policy.
  const extension: AgentCapability = { ...PLANNER.capabilities.find((c) => c.id === PLANNER_READ)!, id: 'project_planner.weather_window', source: { kind: 'extension', extensionId: 'ext-weather', extensionVersion: 1 }, labelKey: 'ext.weather' };
  const registry = { ...REGISTRY, extensions: [{ extensionVersionId: 'extv-1', moduleKey: 'project_planner', capabilities: [extension] }] };
  const withExtension = { ...ok, modules: [{ ...planner, capabilityIds: [...planner.capabilityIds, extension.id] }, ok.modules[1]!] };
  assert.ok(m.policyDocumentViolations(withExtension, registry).some((p) => p.includes('weather_window')));
  assert.deepEqual(m.policyDocumentViolations({ ...withExtension, policy: { ...withExtension.policy, activeExtensionVersionIds: ['extv-1'] } }, registry), []);
});

test('eligibility, defaults within maximums, and job templates that never hold money or human-only verbs', () => {
  const ok = usHubPolicy(HUB);
  const task = ENGINE_MANIFESTS.find((x) => x.key === 'task_marketplace')!;
  const commit = {
    ...ok,
    policy: { ...ok.policy, enabledModules: [...ok.policy.enabledModules, { moduleKey: task.key, moduleVersion: task.version, freeQuota: task.freeFloor, settings: {} }] },
    modules: [...ok.modules, {
      moduleKey: task.key, status: 'active' as const, principalKinds: ['person' as const, 'company_member' as const], verifiedCompanyRequired: false, actions: [...task.actions],
      capabilityIds: task.capabilities.map((c) => c.id), dataClasses: ['private_projects' as const, 'budgets' as const, 'drafts' as const, 'negotiation_constraints' as const],
      limits: { runsPerDay: 10, actionsPerDay: 10, concurrentRuns: 1, outreachPerWeek: 5 },
    }],
  };
  assert.ok(m.policyDocumentViolations(commit, REGISTRY).some((p) => p.startsWith('eligibility: task_marketplace')));
  assert.deepEqual(m.policyDocumentViolations({ ...commit, modules: commit.modules.map((x) => (x.moduleKey === task.key ? { ...x, verifiedCompanyRequired: true } : x)) }, REGISTRY), []);
  const noOutreach = { ...commit, modules: commit.modules.map((x) => (x.moduleKey === task.key ? { ...x, verifiedCompanyRequired: true, limits: { ...x.limits, outreachPerWeek: null } } : x)) };
  assert.ok(m.policyDocumentViolations(noOutreach, REGISTRY).some((p) => p.includes('needs outreach per week')));
  const ps = ok.participantSettings;
  const bad = (p: Partial<typeof ps>) => m.policyDocumentViolations({ ...ok, participantSettings: { ...ps, ...p } }, REGISTRY);
  assert.ok(bad({ outreachPerWeek: { default: 11, max: 10 } }).some((p) => p.includes('outreach per week above its maximum')));
  assert.ok(bad({ reportCadence: { default: 'daily', max: 'weekly' } }).some((p) => p.includes('report cadence')));
  assert.ok(bad({ approval: { defaultMode: 'pre_authorized', loosestMode: 'ask_first' } }).some((p) => p.includes('approval default')));
  assert.ok(bad({ channels: { defaults: ['sms'], allowed: ['platform'] } }).some((p) => p.includes('default channel')));
  // Participants may tighten, never widen beyond the hub maximum.
  assert.equal(m.participantSettingAllowed(ps, { key: 'outreachPerWeek', value: 2 }), true);
  assert.equal(m.participantSettingAllowed(ps, { key: 'outreachPerWeek', value: 11 }), false);
  assert.equal(m.participantSettingAllowed({ ...ps, approval: { defaultMode: 'ask_each', loosestMode: 'ask_first' } }, { key: 'approval', mode: 'pre_authorized' }), false);
  assert.equal(m.participantSettingAllowed(ps, { key: 'channels', value: ['sms'] }), false);
  assert.equal(m.participantSettingAllowed(ps, { key: 'scheduleIntervalMinutes', value: 30 }), false);
  const template = ok.jobTemplates[0]!;
  const job = (patch: Partial<typeof template>) => m.policyDocumentViolations({ ...ok, jobTemplates: [{ ...template, ...patch }] }, REGISTRY);
  assert.ok(job({ actions: ['publish', 'record_evidence'], triggerKinds: ['request'], defaultTrigger: { kind: 'request' } }).length === 0);
  assert.ok(job({ moduleKey: 'profile_keeper', actions: ['maintain_profile'] }).length === 0);
  assert.ok(job({ moduleKey: 'reputation_builder' }).some((p) => p.includes('module not enabled')));
  assert.ok(job({ defaultTrigger: { kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=9,10', timeZone: 'America/New_York' } }).some((p) => p.includes('below its minimum interval')));
  assert.ok(job({ minIntervalMinutes: 60 }).length === 0);
  assert.ok(job({ defaultTrigger: { kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=99', timeZone: 'America/New_York' } }).some((p) => p.includes('invalid default schedule')));
  assert.ok(m.policyDocumentViolations({ ...ok, participantSettings: { ...ps, scheduleMinIntervalMinutes: 2880 } }, REGISTRY).some((p) => p.includes('interval below the hub minimum')));
  for (const action of ['place_order', 'confirm_execution', 'generate_deliverable', 'release_payment'] as const) {
    assert.ok(m.policyDocumentViolations({ ...commit, modules: commit.modules.map((x) => (x.moduleKey === task.key ? { ...x, verifiedCompanyRequired: true } : x)), jobTemplates: [{ ...template, moduleKey: task.key, actions: [action] }] }, REGISTRY)
      .some((p) => p.includes(`${action} is never a standing job`) || p.includes(`action ${action} not offered`)), action);
  }
  // A job's mandate proposal never pre-authorizes more than the hub default or the engine default of a verb.
  assert.deepEqual(jobApprovalPolicy('pre_authorized', ['prepare']), { mode: 'pre_authorized' });
  assert.deepEqual(jobApprovalPolicy('pre_authorized', ['prepare', 'publish']), { mode: 'ask_each' });
  assert.deepEqual(jobApprovalPolicy('ask_first', ['prepare']), { mode: 'ask_first', count: 3 });
  assert.deepEqual(jobApprovalPolicy('ask_above', ['prepare']), { mode: 'ask_each' });
});

/** Every property name of a JSON schema, at any depth. */
function propertyNames(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const s of schema) propertyNames(s, out);
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === 'properties' && v && typeof v === 'object') for (const name of Object.keys(v)) out.add(name);
      propertyNames(v, out);
    }
  }
  return out;
}

test('schema test: no hub configuration key can disable mandates, confirmations, sanctions gates, restricted places or payment neutrality', () => {
  // Every key a hub administrator sets (the preview is computed by the server, it is not a setting).
  const names = propertyNames(z.toJSONSchema(m.AgentPolicyDraftSchema, { unrepresentable: 'any' }));
  assert.ok(names.size > 40, 'the walk found the document');
  for (const name of names) assert.doesNotMatch(name, m.GUARD_RAIL_KEY_PATTERN, `agents domain key ${name}`);
  // Strict at every level: an extra key that would switch a guard rail off does not parse.
  const doc = usHubPolicy(HUB);
  for (const bad of [
    { ...doc, requireMandates: false }, { ...doc, policy: { ...doc.policy, skipConfirmation: true } }, { ...doc, modules: [{ ...doc.modules[0]!, sanctionsGate: 'off' }, doc.modules[1]!] },
    { ...doc, capabilities: [{ capabilityId: PLANNER_READ, offForHub: true, offForPrincipalKinds: [], offForPlans: [], allowRestrictedPlaces: true }] },
    { ...doc, participantSettings: { ...doc.participantSettings, paymentNeutrality: false } },
  ]) assert.equal(m.AgentPolicyDraftSchema.safeParse(bad).success, false);
  // The free-form module settings map is the one open place: guard-rail keys are refused there too.
  const settings = { ...doc, policy: { ...doc.policy, enabledModules: doc.policy.enabledModules.map((e) => ({ ...e, settings: { disableMandates: true, skipScreening: true } })) } };
  assert.ok(m.AgentPolicyDraftSchema.safeParse(settings).success, 'the map accepts the shape');
  const problems = m.policyDocumentViolations(settings, REGISTRY);
  assert.ok(problems.includes('guard rail: settings key disableMandates') && problems.includes('guard rail: settings key skipScreening'), problems.join('; '));
  assert.ok(m.policyDocumentViolations({ ...doc, policy: { ...doc.policy, forbiddenPreAuthorization: [] } }, REGISTRY).includes('guard rail: release_payment is never pre-authorized'));
  assert.deepEqual(m.guardRailKeys({ a: [{ b: { restrictedPlacesOverride: 1 } }], confirmations: 'none' }), ['confirmations', 'restrictedPlacesOverride']);
  // Across every typed hub configuration domain: no key that switches one of these guard rails off.
  const disabling = /(disable|skip|bypass|waive|exempt|without|ignore|allow).{0,24}(mandate|confirm|sanction|screen|restrict|neutral)|(mandate|confirm|sanction|screen|restrict|neutral).{0,24}(off|disabled|skip|bypass|waive|exempt|optional)/i;
  for (const [domain, schema] of Object.entries(CONFIG_PAYLOAD_SCHEMAS)) {
    for (const name of propertyNames(z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' }))) assert.doesNotMatch(name, disabling, `${domain}.${name}`);
  }
});

test('the capability check is surface-independent and answers the same for hub, participant type and plan switches', () => {
  const doc = usHubPolicy(HUB);
  const member = { kind: 'company_member' as const, planKey: 'free', companyVerified: false };
  const pro = { kind: 'person' as const, planKey: 'pro', companyVerified: false };
  assert.equal(m.capabilityRefusal(doc, REGISTRY, PLANNER_COMMIT, person), null);
  assert.equal(m.capabilityRefusal(withSwitch(doc, { capabilityId: PLANNER_COMMIT, offForHub: true, offForPrincipalKinds: [], offForPlans: [] }), REGISTRY, PLANNER_COMMIT, person), 'capability.off_for_hub');
  const byKind = withSwitch(doc, { capabilityId: PLANNER_COMMIT, offForHub: false, offForPrincipalKinds: ['company_member'], offForPlans: [] });
  assert.equal(m.capabilityRefusal(byKind, REGISTRY, PLANNER_COMMIT, member), 'capability.off_for_principal_kind');
  assert.equal(m.capabilityRefusal(byKind, REGISTRY, PLANNER_COMMIT, person), null);
  const byPlan = withSwitch(doc, { capabilityId: PLANNER_COMMIT, offForHub: false, offForPrincipalKinds: [], offForPlans: ['free'] });
  assert.equal(m.capabilityRefusal(byPlan, REGISTRY, PLANNER_COMMIT, person), 'capability.off_for_plan');
  assert.equal(m.capabilityRefusal(byPlan, REGISTRY, PLANNER_COMMIT, pro), null);
  // A capability left out of the module's list is off for the hub; one the manifest never had is unknown.
  const narrowed = { ...doc, modules: [{ ...doc.modules[0]!, capabilityIds: [PLANNER_READ] }, doc.modules[1]!] };
  assert.equal(m.capabilityRefusal(narrowed, REGISTRY, PLANNER_COMMIT, person), 'capability.off_for_hub');
  assert.equal(m.capabilityRefusal(doc, REGISTRY, 'project_planner.export_everything', person), 'capability.unknown');
  assert.equal(m.capabilityRefusal({ ...doc, modules: [{ ...doc.modules[0]!, status: 'draft' }, doc.modules[1]!] }, REGISTRY, PLANNER_READ, person), 'module.not_serving');
  assert.equal(m.capabilityRefusal({ ...doc, modules: [{ ...doc.modules[0]!, principalKinds: ['company_member'] }, doc.modules[1]!] }, REGISTRY, PLANNER_READ, person), 'module.not_eligible');
  const disabled = { ...doc, policy: { ...doc.policy, enabledModules: doc.policy.enabledModules.filter((e) => e.moduleKey !== 'project_planner') }, modules: [doc.modules[1]!] };
  assert.equal(m.capabilityRefusal(disabled, REGISTRY, PLANNER_READ, person), 'module.not_enabled');
  // Every refusal has one explanation key, shown alike on every surface.
  for (const reason of Object.keys(m.REFUSAL_MESSAGE_KEYS)) assert.match(m.REFUSAL_MESSAGE_KEYS[reason as keyof typeof m.REFUSAL_MESSAGE_KEYS], /^agentModules\.refusal\.[a-zA-Z]+$/);
});

test('the preview diff names changed modules and capabilities, narrowed modules, participant types and plans, never people', () => {
  const before = usHubPolicy(HUB);
  const after = withSwitch({ ...before, modules: [{ ...before.modules[0]!, capabilityIds: before.modules[0]!.capabilityIds.filter((id) => id !== PLANNER_COMMIT) }, before.modules[1]!] },
    { capabilityId: 'profile_keeper.add_experience', offForHub: false, offForPrincipalKinds: ['company_representative'], offForPlans: ['free'] });
  const diff = m.diffPolicies(before, after, REGISTRY);
  assert.deepEqual(diff.modules, [{ moduleKey: 'project_planner', change: 'narrowed' }]);
  assert.deepEqual(diff.capabilities, [{ capabilityId: 'profile_keeper.add_experience', change: 'narrowed' }], 'a new switch narrows');
  assert.deepEqual(m.diffPolicies(after, before, REGISTRY).capabilities, [{ capabilityId: 'profile_keeper.add_experience', change: 'enabled' }], 'removing it enables again');
  assert.deepEqual(diff.narrowedModuleKeys, ['profile_keeper', 'project_planner']);
  assert.deepEqual(diff.principalKinds, ['company_representative']);
  assert.deepEqual(diff.plans, ['free']);
  const fromDefault = m.diffPolicies(null, before, REGISTRY);
  assert.ok(fromDefault.modules.some((x) => x.moduleKey === 'task_marketplace' && x.change === 'disabled'));
  assert.ok(fromDefault.narrowedModuleKeys.includes('task_marketplace'));
  assert.equal(m.cohortCount(9), null);
  assert.equal(m.cohortCount(10), 10);
  assert.ok(m.samePreview({ ...m.PolicyPreviewSchema.parse(previewOf(diff)), computedAt: '2026-11-01T00:00:00.000Z' }, { ...m.PolicyPreviewSchema.parse(previewOf(diff)), computedAt: '2026-11-02T00:00:00.000Z' }));
  assert.equal(m.PolicyPreviewSchema.safeParse({ ...previewOf(diff), affected: { mandates: 3, jobSubscriptions: null, connections: null, openRuns: null } }).success, false, 'a count below 10 never appears');
});
function previewOf(diff: ReturnType<typeof m.diffPolicies>): m.PolicyPreview {
  return { attributionDigest: 'a'.repeat(64), computedAt: '2026-11-01T00:00:00.000Z', baseVersionId: null, registeredModuleKeys: ['project_planner'], ...diff, affected: { mandates: null, jobSubscriptions: 12, connections: null, openRuns: null } };
}

test('schedule triggers fire in the principal\'s time zone and respect the hub calendar; deadlines, events and goals', () => {
  const cal = { timeZone: 'America/New_York', closedDates: ['2026-11-26'] };
  const daily = { kind: 'schedule' as const, rrule: 'FREQ=DAILY;BYHOUR=9', timeZone: 'America/New_York' };
  // 09:00 New York is 13:00Z before the DST change and 14:00Z after it (2026-11-01).
  assert.equal(m.nextScheduleOccurrence(daily, new Date('2026-10-30T14:00:00Z'), new Date('2026-10-01T00:00:00Z'), cal, 'run')?.toISOString(), '2026-10-31T13:00:00.000Z');
  assert.equal(m.nextScheduleOccurrence(daily, new Date('2026-11-01T12:00:00Z'), new Date('2026-10-01T00:00:00Z'), cal, 'run')?.toISOString(), '2026-11-01T14:00:00.000Z');
  // A closed date (a holiday the hub lists as data) is skipped, moved to the next open day, or run anyway.
  assert.equal(m.nextScheduleOccurrence(daily, new Date('2026-11-25T15:00:00Z'), new Date('2026-10-01T00:00:00Z'), cal, 'skip')?.toISOString(), '2026-11-27T14:00:00.000Z');
  const thursdays = { kind: 'schedule' as const, rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=8;BYMINUTE=30', timeZone: 'America/New_York' };
  assert.equal(m.nextScheduleOccurrence(thursdays, new Date('2026-11-20T00:00:00Z'), new Date('2026-10-01T00:00:00Z'), cal, 'next_open_day')?.toISOString(), '2026-11-27T13:30:00.000Z');
  assert.equal(m.nextScheduleOccurrence(thursdays, new Date('2026-11-20T00:00:00Z'), new Date('2026-10-01T00:00:00Z'), cal, 'run')?.toISOString(), '2026-11-26T13:30:00.000Z');
  // INTERVAL counts from the anchor; another time zone gives another instant for the same wall clock.
  const fortnight = { kind: 'schedule' as const, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', timeZone: 'Asia/Tashkent' };
  const first = m.nextScheduleOccurrence(fortnight, new Date('2026-11-02T00:00:00Z'), new Date('2026-11-02T00:00:00Z'), { timeZone: 'Asia/Tashkent', closedDates: [] }, 'run')!;
  assert.equal(first.toISOString(), '2026-11-02T04:00:00.000Z');
  assert.equal(m.nextScheduleOccurrence(fortnight, first, new Date('2026-11-02T00:00:00Z'), { timeZone: 'Asia/Tashkent', closedDates: [] }, 'run')?.toISOString(), '2026-11-16T04:00:00.000Z');
  const monthly = { kind: 'schedule' as const, rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', timeZone: 'America/Los_Angeles' };
  assert.equal(m.nextScheduleOccurrence(monthly, new Date('2026-11-15T00:00:00Z'), new Date('2026-10-01T00:00:00Z'), cal, 'run')?.toISOString(), '2026-12-01T17:00:00.000Z');
  assert.equal(m.scheduleIntervalMinutes('FREQ=DAILY;BYHOUR=9'), 1440);
  assert.equal(m.scheduleIntervalMinutes('FREQ=DAILY;BYHOUR=9,10'), 60);
  assert.equal(m.scheduleIntervalMinutes('FREQ=WEEKLY;BYDAY=MO,TU'), 1440);
  assert.equal(m.scheduleIntervalMinutes('FREQ=WEEKLY;BYDAY=MO'), 10080);
  assert.throws(() => m.parseRrule('FREQ=HOURLY'));
  assert.throws(() => m.parseRrule('FREQ=DAILY;BYSECOND=5'));
  const deadline = { kind: 'deadline' as const, contextKind: 'rfq' as const, offsetsDays: [1, 7] };
  assert.deepEqual(m.deadlineOccurrences(deadline, new Date('2026-12-15T22:00:00Z'), 'America/New_York').map((d) => d.toISOString()), ['2026-12-08T14:00:00.000Z', '2026-12-14T14:00:00.000Z']);
  assert.equal(m.triggerMatchesEvent({ kind: 'event', eventType: 'rfq.published' }, { type: 'rfq.published' }), true);
  assert.equal(m.triggerMatchesEvent({ kind: 'goal', goalId: 'g1' }, { type: 'agents.goal_progress', goalId: 'g1' }), true);
  assert.equal(m.triggerMatchesEvent({ kind: 'goal', goalId: 'g1' }, { type: 'agents.goal_progress', goalId: 'g2' }), false);
  assert.equal(m.triggerMatchesEvent({ kind: 'request' }, { type: 'rfq.published' }), false);
  const template = usHubPolicy(HUB).jobTemplates[0]!;
  assert.deepEqual(m.jobTriggerViolations(template, { kind: 'event', eventType: 'rfq.published' }, 60), ['trigger_kind_not_offered']);
  assert.deepEqual(m.jobTriggerViolations(template, daily, 60), []);
  assert.deepEqual(m.jobTriggerViolations(template, { ...daily, rrule: 'FREQ=DAILY;BYHOUR=9,12' }, 60), ['interval_below_minimum']);
});

test('the agent_capability kill-switch scope is additive and blocks only its capability', () => {
  assert.ok(KillSwitchScopeSchema.options.some((o) => o.shape.kind.value === 'agent_capability'));
  const s = { id: 'ks1', scope: { kind: 'agent_capability' as const, hubId: 'hub-1', capabilityId: PLANNER_COMMIT }, state: 'engaged' as const, engagedBy: 'p1', engagedAt: '2026-11-01T00:00:00Z', reason: 'Synthetic', releasedBy: null, releasedAt: null, releaseApprovalId: null, incidentNote: null };
  const target = { nodeId: 'n', hubId: 'hub-1', moduleKey: 'project_planner', action: 'publish' as const, personId: 'p', companyRepresentativeOf: null, connectionId: null };
  assert.equal(agentDispatchBlocked({ hub: [s], participant: [] }, { ...target, capabilityId: PLANNER_COMMIT }), 'ks1');
  assert.equal(agentDispatchBlocked({ hub: [s], participant: [] }, { ...target, capabilityId: 'project_planner.revoke_share' }), null);
  assert.equal(agentDispatchBlocked({ hub: [s], participant: [] }, target), null);
});

test('routes: every mutation is idempotent and classified; no staff route names a participant', () => {
  const routes: string[] = [];
  for (const controller of [AdminAgentModulesController, AgentJobsController]) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const idem = Reflect.getMetadata(IDEMPOTENT, handler) as { action: string } | undefined;
      const full = `${base}/${path}`;
      routes.push(full);
      if (method === 1 && !path.endsWith('preview')) assert.ok(idem && IDEMPOTENT_ROUTES[idem.action]?.kind === 'in_transaction', `${full} completes in its transaction`);
    }
  }
  for (const r of routes.filter((x) => x.startsWith('v1/admin'))) assert.doesNotMatch(r, /person|mandate|goal|job|connection|setting|conversation/i, r);
  assert.ok(routes.includes('v1/assistant/jobs'));
});

/** Strips comments so documentation may name countries while code may not branch on them. */
function code(path: string): string {
  const text = readFileSync(path, 'utf8');
  return path.endsWith('.sql') ? text.replace(/--.*$/gm, '') : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)])).filter((p) => /\.(ts|sql)$/.test(p));
}

test('no module code path branches on a country code (lint)', () => {
  const sources = [
    ...files('apps/api/src/modules/agent-modules'), ...files('packages/data/migrations/agent-modules'), 'packages/contracts/src/agent-modules.ts',
    'packages/data/src/repositories/agent-modules.ts', 'packages/data/src/schema/agent-modules.ts',
  ];
  assert.ok(sources.length >= 10);
  for (const path of sources) {
    const body = code(path);
    assert.doesNotMatch(body, /\bcountry|countryCode|country_code|countryPack|jurisdiction/i, `${path} reads a country`);
    // RFC 5545 weekday tokens of the schedule grammar (SU..SA) are not places.
    const literals = [...body.matchAll(/['"]([A-Z]{2}(?:-[A-Z0-9]{1,3})?)['"]/g)].map((x) => x[1]).filter((x) => !['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].includes(x as string));
    assert.deepEqual(literals, [], `${path} names a place code`);
  }
});
