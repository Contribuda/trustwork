import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { AcceptMembershipCommandSchema, ChangeMembershipCommandSchema, EndMembershipCommandSchema, IdSchema, InviteMemberCommandSchema } from '../../../deps/contracts.js';
import { auth } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import { APP_CONTEXT, type AppContext } from '../context.js';
import { MembershipService } from '../membership.service.js';
import { publicPersonFromRow } from '../serializers.js';

const IdParams = z.strictObject({ id: IdSchema });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1')
export class CompaniesController {
  constructor(@Inject(MembershipService) private readonly membershipsService: MembershipService, @Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Public person projection; private profiles and unknown ids are not found. */
  @Get('people/:id')
  async person(@Params(IdParams) params: z.infer<typeof IdParams>) {
    if (!UUID.test(params.id)) throw new ApiError('access.not_found');
    const row = await auth.publicPersonRead(this.ctx.pool, params.id);
    if (!row) throw new ApiError('access.not_found');
    return publicPersonFromRow(row);
  }

  @Get('companies/:id')
  company(@Params(IdParams) params: z.infer<typeof IdParams>, @ReqState() state: RequestState) {
    if (!UUID.test(params.id)) throw new ApiError('access.not_found');
    return this.membershipsService.company(params.id, state);
  }

  @Get('companies/:id/memberships') @Authenticated()
  list(@Params(IdParams) params: z.infer<typeof IdParams>, @ReqState() state: RequestState) {
    return this.membershipsService.list(params.id, state);
  }

  @Post('companies/:id/memberships') @HttpCode(202) @Authenticated('step_up') @Idempotent('membership.invite', 'id')
  invite(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(InviteMemberCommandSchema) body: z.infer<typeof InviteMemberCommandSchema>, @ReqState() state: RequestState) {
    return this.membershipsService.invite(params.id, body, state);
  }

  @Post('companies/:id/memberships/accept') @HttpCode(200) @Authenticated() @Idempotent('membership.accept', 'id')
  accept(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(AcceptMembershipCommandSchema) body: z.infer<typeof AcceptMembershipCommandSchema>, @ReqState() state: RequestState) {
    return this.membershipsService.accept(params.id, body, state);
  }

  @Post('companies/:id/memberships/change') @HttpCode(200) @Authenticated('step_up') @Idempotent('membership.change', 'id')
  change(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(ChangeMembershipCommandSchema) body: z.infer<typeof ChangeMembershipCommandSchema>, @ReqState() state: RequestState) {
    return this.membershipsService.change(params.id, body, state);
  }

  @Post('companies/:id/memberships/end') @HttpCode(200) @Authenticated('step_up') @Idempotent('membership.end', 'id')
  end(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(EndMembershipCommandSchema) body: z.infer<typeof EndMembershipCommandSchema>, @ReqState() state: RequestState) {
    return this.membershipsService.end(params.id, body, state);
  }
}
