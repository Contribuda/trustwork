import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body } from '../../common/zod.js';
import { PrincipalService } from '../identity/principal.service.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { RescreenRequestSchema } from './deps.js';
import { screeningRefusal } from './errors.js';
import { screeningConsoleRuns } from '../../../../../packages/data/src/repositories/screening-console.js';
import { rescreenStaff } from '../../../../../packages/data/src/repositories/rescreen.js';

/** Same bounded operator setting as SANC-005; it is never supplied by a browser. */
export function manualRescreenWindow(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return z.coerce.number().int().min(1).max(168).parse(env.RESCREEN_WINDOW_HOURS?.trim() || 6) * 3600;
}

/** SANC-006 HTTP adapter of SANC-005. RLS and the existing command remain the authority. */
@Controller('v1/admin/screening/rescreen-runs')
@Authenticated()
@UseGuards(ElevationGuard)
export class ScreeningRescreenController {
  private readonly windowSeconds = manualRescreenWindow();
  constructor(@Inject(PrincipalService) private readonly principals: PrincipalService) {}

  @Get()
  list(@ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => ({ items: await screeningConsoleRuns(trx, await rescreenStaff.runs(trx)) }));
  }

  @Post() @HttpCode(200) @Idempotent('screening.rescreen_request')
  async request(@Body(RescreenRequestSchema) body: z.infer<typeof RescreenRequestSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    try {
      return await this.principals.runAs(state, async (trx) => {
        const run = await rescreenStaff.requestRun(trx, {
          elevationId: elevation.id, requestId: state.requestId, reasonCode: 'screening_rescreen_requested', reasonText: body.reason,
        }, { reason: body.reason, windowSeconds: this.windowSeconds });
        return (await screeningConsoleRuns(trx, [run]))[0]!;
      });
    } catch (error) {
      screeningRefusal(error);
    }
  }
}
