import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, ReqState, type RequestState } from '../../../common/request.js';
import { Query } from '../../../common/zod.js';
import { ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import { EffectiveAccessQuerySchema, StaffDirectoryQuerySchema } from './deps.js';
import { StaffLifecycleService } from './staff-lifecycle.service.js';

/**
 * ADM-004 staff reads (docs/engine/hub-console/console-design.md, section 4.2), like every console read only in an
 * elevated staff session. Nothing here reports what a staff member did.
 */
@Controller('v1/admin/staff')
@Authenticated()
@UseGuards(ElevationGuard)
export class StaffLifecycleController {
  constructor(@Inject(StaffLifecycleService) private readonly staff: StaffLifecycleService) {}

  /** Names of the staff covering the hub; roles and second-factor state with `admin.staff.read`. */
  @Get('directory')
  directory(@Query(StaffDirectoryQuerySchema) q: z.infer<typeof StaffDirectoryQuerySchema>, @ReqState() state: RequestState) {
    return this.staff.directory(state, q.hubId);
  }

  /** What one staff member may do at the hub now, from released definitions and active assignments. */
  @Get('effective-access')
  effectiveAccess(@Query(EffectiveAccessQuerySchema) q: z.infer<typeof EffectiveAccessQuerySchema>, @ReqState() state: RequestState) {
    return this.staff.effectiveAccess(state, q.hubId, q.personId);
  }
}
