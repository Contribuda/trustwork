import { ENGINE_MANIFESTS } from '../../apps/api/src/modules/agent-modules/ports.js';
import type { AgentPolicyDraft, ModuleRegistry } from '../../packages/contracts/src/agent-modules.js';

/**
 * Synthetic AGT-003 fixtures. The reference hub is the United States demo hub: English, America/New_York business
 * calendar with two federal holidays as data (no code path knows any country), the project planner and the profile keeper
 * enabled. Every document here is synthetic.
 */
export const REGISTRY: ModuleRegistry = { manifests: ENGINE_MANIFESTS, extensions: [] };
const manifest = (key: string) => {
  const m = ENGINE_MANIFESTS.find((x) => x.key === key);
  if (!m) throw new Error(`no manifest ${key}`);
  return m;
};
export const PLANNER = manifest('project_planner');
export const PROFILE = manifest('profile_keeper');
export const PLANNER_COMMIT = 'project_planner.share_item';
export const PLANNER_READ = 'project_planner.get_plan';

export function usHubPolicy(hubId: string, over: Partial<AgentPolicyDraft> = {}): AgentPolicyDraft {
  return {
    schemaVersion: 1,
    policy: {
      hubId,
      enabledModules: [PLANNER, PROFILE].map((m) => ({ moduleKey: m.key, moduleVersion: m.version, freeQuota: m.freeFloor.map((q) => ({ ...q })), settings: { digestTone: 'plain' } })),
      protectionLimits: {
        openIntroductionsPerPerson: 5, newCounterpartiesPerDay: 10, maxNegotiationRounds: 5, consumerMaxRounds: 4, envelopesPerCounterpartyPerDay: 15,
        publicRecordsPerConnectionPerDay: 1000, connectionsPerPerson: 3, connectionIdleExpiryDays: 90,
      },
      forbiddenPreAuthorization: ['release_payment'],
      activeExtensionVersionIds: [],
    },
    modules: [
      {
        moduleKey: PLANNER.key, status: 'active', principalKinds: ['person', 'company_member', 'company_representative'], verifiedCompanyRequired: false,
        actions: [...PLANNER.actions], capabilityIds: PLANNER.capabilities.map((c) => c.id), dataClasses: ['private_projects', 'budgets'],
        limits: { runsPerDay: 50, actionsPerDay: 100, concurrentRuns: 2, outreachPerWeek: null },
      },
      {
        moduleKey: PROFILE.key, status: 'active', principalKinds: ['person', 'company_member', 'company_representative'], verifiedCompanyRequired: false,
        actions: [...PROFILE.actions], capabilityIds: PROFILE.capabilities.map((c) => c.id), dataClasses: [],
        limits: { runsPerDay: 20, actionsPerDay: 40, concurrentRuns: 1, outreachPerWeek: null },
      },
    ],
    capabilities: [],
    participantSettings: {
      approval: { defaultMode: 'ask_each', loosestMode: 'pre_authorized' }, outreachPerWeek: { default: 5, max: 10 }, reportCadence: { default: 'weekly', max: 'daily' },
      scheduleMinIntervalMinutes: 60, channels: { defaults: ['platform'], allowed: ['platform', 'email'] },
    },
    calendar: { timeZone: 'America/New_York', closedDates: ['2026-11-26', '2026-12-25'] },
    jobTemplates: [{
      moduleKey: PLANNER.key, templateKey: 'weekly_plan_review', labelKey: 'agentModules.job.weeklyPlanReview', actions: ['prepare'], triggerKinds: ['schedule', 'request', 'goal'],
      defaultTrigger: { kind: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9', timeZone: 'America/New_York' }, minIntervalMinutes: 1440, onClosedDay: 'next_open_day',
    }],
    ...over,
  };
}

/** The same policy with one capability switched off for the hub, a participant type or a plan. */
export function withSwitch(doc: AgentPolicyDraft, s: AgentPolicyDraft['capabilities'][number]): AgentPolicyDraft {
  return { ...doc, capabilities: [...doc.capabilities.filter((c) => c.capabilityId !== s.capabilityId), s] };
}
