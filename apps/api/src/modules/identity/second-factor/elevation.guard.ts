import { createParamDecorator, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { stateOf } from '../../../common/request.js';
import type { SessionElevationRow } from './deps.js';
import { SecondFactorService } from './second-factor.service.js';

type ElevatedRequest = FastifyRequest & { trustworkElevation?: SessionElevationRow };

/**
 * Staff routes (`@UseGuards(ElevationGuard)`) refuse a session without a live elevation: 401 without a session, 403
 * `access.forbidden` with `details.required = 'staff'` for a person without a staff role and `'elevation'` for a staff
 * session that is not elevated or whose elevation expired, ended or belongs to another session. The guard runs after
 * the global session and CSRF guards; the elevation it found is available to the handler (`@Elevation()`) so audit
 * rows name it.
 */
@Injectable()
export class ElevationGuard implements CanActivate {
  constructor(@Inject(SecondFactorService) private readonly secondFactors: SecondFactorService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ElevatedRequest>();
    request.trustworkElevation = await this.secondFactors.requireElevation(stateOf(request));
    return true;
  }
}

/** Handler parameter: the elevation `ElevationGuard` verified for this request. */
export const Elevation = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionElevationRow => {
  const elevation = ctx.switchToHttp().getRequest<ElevatedRequest>().trustworkElevation;
  if (!elevation) throw new Error('Elevation() used on a route without ElevationGuard');
  return elevation;
});
