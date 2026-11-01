import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ApiError } from '../../common/errors.js';
import { Authenticated, ReqState, type RequestState } from '../../common/request.js';
import { APP_CONTEXT, type AppContext } from '../identity/context.js';
import { PrincipalService } from '../identity/principal.service.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { jurisdictionStaff } from '../../../../../packages/data/src/repositories/jurisdiction.js';
import { ScreeningGeolocationSchema } from '../../../../../packages/contracts/src/sanctions.js';
import { unconfiguredGate, type JurisdictionGate } from './deps.js';

/** Describes the adapter actually installed in the request gate. Historical holds are never current metadata. */
export function geolocationView(gate: JurisdictionGate, now = new Date()) {
  const description = gate.describe();
  const month = description.month;
  const ageMonths = month ? Math.max(0, (now.getUTCFullYear() - Number(month.slice(0, 4))) * 12 + now.getUTCMonth() + 1 - Number(month.slice(5))) : null;
  return ScreeningGeolocationSchema.parse({ checkedAt: now.toISOString(), gate: description, ageMonths,
    // ADR 014 decision 7 and SANC-002's ranges-age watchdog: older than two months warns.
    freshness: ageMonths === null ? 'unknown' : ageMonths > 2 ? 'stale' : 'known' });
}

@Controller('v1/admin/jurisdiction/geolocation')
@Authenticated()
@UseGuards(ElevationGuard)
export class JurisdictionGeolocationController {
  constructor(@Inject(PrincipalService) private readonly principals: PrincipalService, @Inject(APP_CONTEXT) private readonly ctx: AppContext) {}
  @Get()
  read(@ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => {
      if (!await jurisdictionStaff.canRead(trx)) throw new ApiError('access.not_found');
      return geolocationView(this.ctx.jurisdictionGate ?? unconfiguredGate());
    });
  }
}
