import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { sql } from 'kysely';
import { ApiError } from '../../common/errors.js';
import { Authenticated, ReqState, type RequestState } from '../../common/request.js';
import { Params, Query } from '../../common/zod.js';
import { PrincipalService } from '../identity/principal.service.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { jurisdictionStaff } from '../../../../../packages/data/src/repositories/jurisdiction.js';
import { screeningStaff } from './deps.js';
import { screeningListsStaff } from '../../../../../packages/data/src/repositories/screening-lists.js';
import { screeningListsOverview, screeningRunDurations, screeningVersionSummary } from '../../../../../packages/data/src/repositories/screening-console.js';
import { ScreeningMetricsSchema, ScreeningSubjectPanelSchema, ScreeningVersionsSchema } from '../../../../../packages/contracts/src/sanctions.js';
import type { Transaction } from '../../../../../packages/data/src/pool.js';

const Id = z.strictObject({ id: z.uuid() });
const Subject = z.strictObject({ kind: z.enum(['person', 'company']), id: z.uuid() });
const Hub = z.strictObject({ hubId: z.uuid() });

@Controller('v1/admin/screening')
@Authenticated()
@UseGuards(ElevationGuard)
export class ScreeningConsoleController {
  constructor(@Inject(PrincipalService) private readonly principals: PrincipalService) {}
  private read<T>(state: RequestState, fn: (trx: Transaction) => Promise<T>) {
    return this.principals.runAs(state, async (trx) => {
      if (!await jurisdictionStaff.canRead(trx)) throw new ApiError('access.not_found');
      return fn(trx);
    });
  }
  @Get('lists')
  lists(@ReqState() state: RequestState) { return this.read(state, screeningListsOverview); }

  @Get('lists/:id/versions')
  versions(@Params(Id) params: z.infer<typeof Id>, @ReqState() state: RequestState) {
    return this.read(state, async (trx) => {
      if (!(await screeningListsStaff.lists(trx)).some((list) => list.id === params.id)) throw new ApiError('access.not_found');
      return ScreeningVersionsSchema.parse({ items: (await screeningListsStaff.versions(trx, params.id)).map(screeningVersionSummary) });
    });
  }
  @Get('subjects/lookup/:kind/:id')
  subject(@Params(Subject) params: z.infer<typeof Subject>, @ReqState() state: RequestState) {
    return this.read(state, async (trx) => {
      const row = await screeningStaff.subjectStateFor(trx, params);
      if (!row) throw new ApiError('access.not_found');
      return ScreeningSubjectPanelSchema.parse({ subjectStateId: row.id, subject: params, moneyHeld: row.money_held,
        suspended: row.suspended, lastOutcome: row.last_outcome, lastScreenedAt: row.last_screened_at?.toISOString() ?? null,
        matches: await screeningStaff.matchesOf(trx, params) });
    });
  }
  @Get('metrics')
  metrics(@Query(Hub) query: z.infer<typeof Hub>, @ReqState() state: RequestState) {
    return this.read(state, async (trx) => {
      const hub = await trx.selectFrom('hub_profile').select('hub_id').where('hub_id', '=', query.hubId)
        .where('node_id', '=', sql<string>`trustwork.jurisdiction_node()`).executeTakeFirst();
      if (!hub) throw new ApiError('access.not_found');
      // Existing records are node-wide: no hub attribution on holds, matches, decisions or runs.
      // Refusal counters have no principal dimension; gate-refusal counters are not persisted.
      // Do not invent a cohort, divide events by accounts or return suppressed raw rows.
      return ScreeningMetricsSchema.parse({ checkedAt: new Date().toISOString(), hubId: query.hubId, minimumDistinctPrincipals: 10,
        metrics: ['refusals', 'openHolds', 'clearedHolds', 'medianClearSeconds', 'openedMatches', 'decidedMatches', 'lateMatches', 'notSamePersonShare', 'gateRefusals'].map((key) => ({
          key, state: 'unknown', value: null,
          reason: key === 'refusals' ? 'distinct_principals_missing' : key === 'gateRefusals' ? 'gate_counter_missing' : 'hub_attribution_missing',
        })), rescreenScope: 'node', rescreenDurations: await screeningRunDurations(trx) });
    });
  }
}
