import { randomBytes } from 'node:crypto';
import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import { staffRoleDefinitions, type CommandContext } from '../../packages/data/src/repositories/admin.js';
import type { DraftPipelineVersionInput, PipelineScheduleInput } from '../../packages/data/src/repositories/pipelines.js';
import { actors, buildAdminWorld, type AdminWorld } from '../data/admin/helpers.js';

/**
 * Synthetic world for the PIPE-001 suites, on top of the admin world (founding owner and staff admin, a hub and another
 * hub). Every person and hub is synthetic; the role definition is a test definition over the real console vocabulary.
 *
 * - stewardA, stewardB: `data-steward` at the hub with every pipelines permission (the second person for each other)
 * - otherSteward: the same role at the other hub
 * - viewer: a person without any staff role
 */
export const PIPELINE_PERMISSIONS = ['admin.pipelines.read', 'admin.pipelines.edit', 'admin.pipelines.activate', 'admin.pipelines.run', 'admin.pipelines.pause'] as const;
export type PipelinesKey = 'stewardA' | 'stewardB' | 'otherSteward' | 'viewer';

export interface PipelinesWorld {
  admin: AdminWorld;
  hubId: string;
  otherHubId: string;
  people: Record<PipelinesKey, string>;
  act: ReturnType<typeof actors>;
  cmd<T>(personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T>;
}

export async function buildPipelinesWorld(adminPool: DataPool, runtime: DataPool): Promise<PipelinesWorld> {
  const admin = await buildAdminWorld(adminPool);
  const names: Record<PipelinesKey, string> = { stewardA: 'Synthetic Pipeline Steward A', stewardB: 'Synthetic Pipeline Steward B', otherSteward: 'Synthetic Other Steward', viewer: 'Synthetic Viewer' };
  const people = await withMaintenance(adminPool, async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 1, role: 'data-steward', scopes: ['hub'], permissions: [...PIPELINE_PERMISSIONS], caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
      sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    const out = {} as Record<PipelinesKey, string>;
    for (const key of Object.keys(names) as PipelinesKey[]) {
      out[key] = (await trx.insertInto('person').values({ display_name: names[key] }).returning('id').executeTakeFirstOrThrow()).id;
      const session = await trx.insertInto('session').values({
        person_id: out[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password',
      }).returning('id').executeTakeFirstOrThrow();
      admin.sessions[key] = session.id;
    }
    return out;
  });
  Object.assign(admin.people as Record<string, string>, people);
  const act = actors(adminPool, runtime, admin);
  await act.assign({ personId: people.stewardA, role: 'data-steward', scope: { kind: 'hub', hubId: admin.hubId } });
  await act.assign({ personId: people.stewardB, role: 'data-steward', scope: { kind: 'hub', hubId: admin.hubId } });
  await act.assign({ personId: people.otherSteward, role: 'data-steward', scope: { kind: 'hub', hubId: admin.otherHubId } });
  return {
    admin, hubId: admin.hubId, otherHubId: admin.otherHubId, people, act,
    async cmd<T>(personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T> {
      const ctx = await act.elevate(personId);
      return act.as(personId, (trx) => fn(trx, ctx));
    },
  };
}

/** A source-ingestion version ending in the review queue; `role` binds the summarise step to a team role. */
export function versionInput(over: Partial<DraftPipelineVersionInput> & { role?: string } = {}): DraftPipelineVersionInput {
  const { role, ...rest } = over;
  return {
    name: 'Synthetic trade journal ingestion', sourceIds: ['00000000-0000-4000-8000-0000000000aa'], datasetId: null, automationLevel: 'assisted', budgetId: '00000000-0000-4000-8000-0000000000bb',
    steps: [
      { kind: 'fetch', modelRouteId: null, modelJob: null, settings: {} },
      { kind: 'summarise', modelRouteId: '00000000-0000-4000-8000-0000000000cc', modelJob: 'summarisation', settings: role ? { role } : {} },
      { kind: 'propose_for_review', modelRouteId: null, modelJob: null, settings: {} },
    ],
    ...rest,
  };
}

export function scheduleInput(over: Partial<PipelineScheduleInput> = {}): PipelineScheduleInput {
  return {
    cron: '15 2 * * 1-5', timeZone: 'America/Chicago', windows: [], jitterSeconds: 0,
    quotas: { maxItemsPerRun: 500, maxRunsPerDay: 1, maxCostPerRun: null, maxRequestsPerMinutePerHost: 30 },
    retry: { maxAttempts: 3, backoff: 'exponential', baseSeconds: 60, maxDelaySeconds: 3600, retryOn: ['network', 'timeout'] },
    concurrency: 1, alerts: [{ kind: 'failure_streak', threshold: 2, notify: 'console' }, { kind: 'zero_items_streak', threshold: 2, notify: 'console' }],
    ...over,
  };
}

export const ZERO_COUNTS = { fetched: 0, new: 0, duplicates: 0, skippedByLicence: 0, skippedByRobots: 0, proposed: 0, failed: 0 };
