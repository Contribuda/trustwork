import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../../common/request.js';
import { Body } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { AttestationService } from './attestation.service.js';
import { AttestDeploymentLocationCommandSchema, type AttestDeploymentLocationCommand } from './deps.js';

/**
 * Deployment-location attestation (SANC-009): the setup wizard's operator step and the console read the status and
 * attest or renew behind an elevated staff session. The database decides who may attest (node or platform staff with
 * an attesting permission at the node), refuses restricted places, serialises concurrent attestations and audits.
 */
@Controller('v1/admin/jurisdiction/attestation')
@Authenticated()
@UseGuards(ElevationGuard)
export class AttestationController {
  constructor(@Inject(AttestationService) private readonly attestations: AttestationService) {}

  /** The current attestation (without the attesting person), its state, problems, renewal date and launch-gate share. */
  @Get()
  status(@ReqState() state: RequestState) {
    return this.attestations.status(state);
  }

  /** The full chain with attesting people, roles and elevations (node staff only; others see an empty list). */
  @Get('history')
  history(@ReqState() state: RequestState) {
    return this.attestations.history(state);
  }

  @Post() @HttpCode(201) @Idempotent('jurisdiction.attestation.attest')
  attest(@Body(AttestDeploymentLocationCommandSchema) body: AttestDeploymentLocationCommand, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return this.attestations.attest(state, elevation.id, body);
  }
}
