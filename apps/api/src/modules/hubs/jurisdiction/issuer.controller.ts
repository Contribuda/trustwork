import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { JurisdictionIssuerProposeSchema, JurisdictionSourceDecisionSchema } from '../../../../../../packages/contracts/src/jurisdiction.js';
import { JurisdictionIssuerService } from './issuer.service.js';
const Id = z.strictObject({ id: z.uuid() });
const Revocation = z.strictObject({ kind: z.enum(['issuer', 'source']), id: z.uuid() });
type Decision = z.infer<typeof JurisdictionSourceDecisionSchema>;

@Controller('v1/admin/jurisdiction-sources')
@Authenticated()
@UseGuards(ElevationGuard)
export class JurisdictionIssuerController {
  constructor(@Inject(JurisdictionIssuerService) private readonly service: JurisdictionIssuerService) {}
  @Post('issuers') @HttpCode(200) @Idempotent('jurisdiction.issuer_propose')
  propose(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Body(JurisdictionIssuerProposeSchema) body: z.infer<typeof JurisdictionIssuerProposeSchema>) {
    return this.service.propose(state, elevation.id, body);
  }
  @Post('issuers/:id/activate') @HttpCode(200) @Idempotent('jurisdiction.issuer_activate')
  activate(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(Id) p: z.infer<typeof Id>, @Body(JurisdictionSourceDecisionSchema) body: Decision) {
    return this.service.activate(state, elevation.id, p.id, body);
  }
  @Post(':kind/:id/revoke') @HttpCode(200) @Idempotent('jurisdiction.source_revoke')
  revoke(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(Revocation) p: z.infer<typeof Revocation>, @Body(JurisdictionSourceDecisionSchema) body: Decision) {
    return this.service.revoke(state, elevation.id, p.kind, p.id, body);
  }
}
