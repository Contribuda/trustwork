import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../../common/request.js';
import { Body, Params, Query } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { targetFrom } from '../platform-admin.service.js';
import { ConsoleServicesService } from './console-services.service.js';
import {
  ActiveFlagsQuerySchema, ConsoleSearchQuerySchema, ConsoleTargetQuerySchema, ConsoleViewsQuerySchema, ConsoleWorkQuerySchema, CreateConsoleViewCommandSchema, RemoveConsoleViewCommandSchema,
  SetConsoleNotificationsCommandSchema, SetFlagStageCommandSchema, UpdateConsoleViewCommandSchema,
} from './deps.js';

const IdParams = z.strictObject({ id: z.uuid() });

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest) {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * ADM-005 routes of the console's navigation layer (docs/engine/hub-console/console-design.md, sections 3.4, 3.5 and
 * 6.2), like every console route only in an elevated staff session. Reads take a target (`hubId`, `nodeId`, or neither
 * for the platform) and answer only about exactly that target.
 */
@Controller('v1/admin/console')
@Authenticated()
@UseGuards(ElevationGuard)
export class ConsoleServicesController {
  constructor(@Inject(ConsoleServicesService) private readonly console: ConsoleServicesService) {}

  /** The object with this id, number or flag key, if the reader may read it; the same empty answer otherwise. */
  @Get('search')
  search(@Query(ConsoleSearchQuerySchema) q: z.infer<typeof ConsoleSearchQuerySchema>, @ReqState() state: RequestState) {
    return this.console.search(state, q.ref, targetFrom(q));
  }

  @Get('work')
  work(@Query(ConsoleWorkQuerySchema) q: z.infer<typeof ConsoleWorkQuerySchema>, @ReqState() state: RequestState) {
    return this.console.work(state, q.view, targetFrom(q));
  }

  @Get('work/count')
  workCount(@Query(ConsoleTargetQuerySchema) q: z.infer<typeof ConsoleTargetQuerySchema>, @ReqState() state: RequestState) {
    return this.console.workCount(state, targetFrom(q));
  }

  @Get('views')
  views(@Query(ConsoleViewsQuerySchema) q: z.infer<typeof ConsoleViewsQuerySchema>, @ReqState() state: RequestState) {
    return this.console.views(state, targetFrom(q), q.surface);
  }

  @Post('views') @HttpCode(201) @Idempotent('admin.console.view_create')
  createView(@Body(CreateConsoleViewCommandSchema) body: z.infer<typeof CreateConsoleViewCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.console.createView(elevated(state, e, r), body);
  }

  @Post('views/:id') @HttpCode(200) @Idempotent('admin.console.view_update', 'id')
  updateView(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(UpdateConsoleViewCommandSchema) body: z.infer<typeof UpdateConsoleViewCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.console.updateView(elevated(state, e, r), p.id, body);
  }

  @Post('views/:id/remove') @HttpCode(200) @Idempotent('admin.console.view_remove', 'id')
  removeView(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(RemoveConsoleViewCommandSchema) body: z.infer<typeof RemoveConsoleViewCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.console.removeView(elevated(state, e, r), p.id, body);
  }

  /** The reader's own settings; there is no route to anyone else's. */
  @Get('notifications')
  notifications(@ReqState() state: RequestState) {
    return this.console.notifications(state);
  }

  @Post('notifications') @HttpCode(200) @Idempotent('admin.console.notifications_set')
  setNotifications(@Body(SetConsoleNotificationsCommandSchema) body: z.infer<typeof SetConsoleNotificationsCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.console.setNotifications(elevated(state, e, r), body);
  }

  /** Flags with their stage and expiry at the target, expired ones included. */
  @Get('flags')
  flags(@Query(ConsoleTargetQuerySchema) q: z.infer<typeof ConsoleTargetQuerySchema>, @ReqState() state: RequestState) {
    return this.console.flags(state, targetFrom(q));
  }

  @Post('flags/:id/stage') @HttpCode(200) @Idempotent('admin.console.flag_stage', 'id')
  setFlagStage(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(SetFlagStageCommandSchema) body: z.infer<typeof SetFlagStageCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.console.setFlagStage(elevated(state, e, r), p.id, body);
  }
}

/** What any signed-in person's client uses to decide what to show: the flags in force for them. Not a staff route. */
@Controller('v1/flags')
export class ActiveFlagsController {
  constructor(@Inject(ConsoleServicesService) private readonly console: ConsoleServicesService) {}

  @Get('active') @Authenticated()
  active(@Query(ActiveFlagsQuerySchema) _q: z.infer<typeof ActiveFlagsQuerySchema>, @ReqState() state: RequestState) {
    return this.console.activeFlags(state);
  }
}
