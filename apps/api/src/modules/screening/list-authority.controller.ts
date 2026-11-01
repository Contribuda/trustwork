import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { sql } from 'kysely';
import { ApiError } from '../../common/errors.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { PrincipalService } from '../identity/principal.service.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { jurisdictionStaff } from '../../../../../packages/data/src/repositories/jurisdiction.js';
import { screeningListsStaff } from '../../../../../packages/data/src/repositories/screening-lists.js';
import { screeningListAuthority, proposeScreeningList, decideScreeningList } from '../../../../../packages/data/src/repositories/screening-list-authority.js';
import { ScreeningListConfigurationSchema, ScreeningListDecisionSchema, ScreeningListStatusCommandSchema, ScreeningListConfirmCommandSchema } from '../../../../../packages/contracts/src/sanctions.js';
import { screeningRefusal } from './errors.js';

const Id = z.strictObject({ id: z.uuid() });
const Hub = z.strictObject({ hubId: z.uuid() });
const ctx = (state: RequestState, elevation: SessionElevationRow, reason: string) => ({ elevationId: elevation.id, requestId: state.requestId, reasonCode: 'screening_list_management', reasonText: reason });

@Controller('v1/admin/screening')
@Authenticated()
@UseGuards(ElevationGuard)
export class ScreeningListAuthorityController {
  constructor(@Inject(PrincipalService) private readonly principals: PrincipalService) {}

  @Get('list-authority')
  read(@Query(Hub) query: z.infer<typeof Hub>, @ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => {
      if (!await jurisdictionStaff.canRead(trx)) throw new ApiError('access.not_found');
      const hub = await trx.selectFrom('hub_profile').select('hub_id').where('hub_id', '=', query.hubId)
        .where('node_id', '=', sql<string>`trustwork.jurisdiction_node()`).executeTakeFirst();
      if (!hub) throw new ApiError('access.not_found');
      return screeningListAuthority(trx, query.hubId);
    });
  }
  @Post('list-proposals') @HttpCode(200) @Idempotent('screening.list_propose')
  async propose(@Body(ScreeningListConfigurationSchema) body: z.infer<typeof ScreeningListConfigurationSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    try { return await this.principals.runAs(state, (trx) => proposeScreeningList(trx, ctx(state,elevation,body.reason),body)); }
    catch (error) { screeningRefusal(error); }
  }
  @Post('list-proposals/:id/decision') @HttpCode(200) @Idempotent('screening.list_decide')
  async decide(@Params(Id) params: z.infer<typeof Id>, @Body(ScreeningListDecisionSchema) body: z.infer<typeof ScreeningListDecisionSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    try { return await this.principals.runAs(state, (trx) => decideScreeningList(trx,ctx(state,elevation,body.reason),params.id,body)); }
    catch (error) { screeningRefusal(error); }
  }
  @Post('lists/:id/status') @HttpCode(200) @Idempotent('screening.list_status')
  async status(@Params(Id) params: z.infer<typeof Id>, @Body(ScreeningListStatusCommandSchema) body: z.infer<typeof ScreeningListStatusCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    try { return await this.principals.runAs(state, async (trx) => {
      await screeningListsStaff.setStatus(trx,ctx(state,elevation,body.reason),{listId:params.id,...body}); return {id:params.id};
    }); } catch (error) { screeningRefusal(error); }
  }
  @Post('list-versions/:id/confirm') @HttpCode(200) @Idempotent('screening.list_confirm')
  async confirm(@Params(Id) params: z.infer<typeof Id>, @Body(ScreeningListConfirmCommandSchema) body: z.infer<typeof ScreeningListConfirmCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    try { return await this.principals.runAs(state, async (trx) => ({ outcome: await screeningListsStaff.confirmVersion(trx,ctx(state,elevation,body.reason),{versionId:params.id,...body}) })); }
    catch (error) { screeningRefusal(error); }
  }
}
