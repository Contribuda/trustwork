import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { PrincipalService } from '../identity/principal.service.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { ClearJurisdictionHoldCommandSchema, jurisdictionHolds, JurisdictionHoldSchema, type JurisdictionHold, type JurisdictionHoldRow } from './deps.js';

const UuidParams = z.strictObject({ id: z.uuid() });
const ListQuery = z.strictObject({ open: z.enum(['true', 'false']).optional(), personId: z.uuid().optional() });

/**
 * The web proxy's relay (SANC-001): a page request from a restricted place that carries a session is refused by the
 * proxy, which then calls this route with the visitor's cookie so the API's gate (which runs before any route) can hold
 * the person. When the gate lets a request through, there is nothing to do.
 */
@Controller('v1/jurisdiction')
export class JurisdictionRelayController {
  @Get('sighting') @HttpCode(204)
  sighting(): void {
    return undefined;
  }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
export function holdView(row: JurisdictionHoldRow): JurisdictionHold {
  return JurisdictionHoldSchema.parse({
    id: row.id, personId: row.person_id, place: row.place, source: row.source, dataset: row.dataset, placedAt: iso(row.placed_at),
    clearedAt: iso(row.cleared_at), clearedBy: row.cleared_by, clearReason: row.clear_reason, clearEvidence: row.clear_evidence,
  });
}

interface PgError { code?: string; hint?: string }
/** Database refusals of the clear command, as contract codes; existence never leaks to someone who may not read holds. */
function clearRefusal(error: unknown): never {
  const hint = (error as PgError)?.hint;
  if (hint === 'jurisdiction.hold_not_found') throw new ApiError('access.not_found');
  if (hint === 'jurisdiction.hold_cleared') throw new ApiError('validation.revision_conflict', 'the hold is already cleared');
  if (hint === 'jurisdiction.self_clear' || hint === 'admin.forbidden' || hint === 'admin.conflict_of_interest' || hint === 'admin.elevation_required') throw new ApiError('access.forbidden', 'only a compliance officer of this node who is not the subject clears a hold', { reason: hint });
  if (hint === 'jurisdiction.reason_required') throw new ApiError('validation.schema', 'a reason is required');
  throw error;
}

/**
 * Compliance staff (ADR 014 decision 8): list holds and clear one with a reason and an evidence category. Behind an
 * elevated session; the database checks the compliance-officer role at the node, refuses the subject and declared
 * conflicts, serialises concurrent reviewers and writes the audit row in the same transaction.
 */
@Controller('v1/admin/jurisdiction/holds')
@Authenticated()
@UseGuards(ElevationGuard)
export class JurisdictionHoldsController {
  constructor(@Inject(PrincipalService) private readonly principals: PrincipalService) {}

  @Get()
  list(@Query(ListQuery) query: z.infer<typeof ListQuery>, @ReqState() state: RequestState) {
    return this.principals.runAs(state, async (trx) => {
      const rows = await jurisdictionHolds.list(trx, { ...(query.open ? { open: query.open === 'true' } : {}), ...(query.personId ? { personId: query.personId } : {}) });
      return { items: rows.map(holdView) };
    });
  }

  @Post(':id/clear') @HttpCode(200) @Idempotent('jurisdiction.hold.clear', 'id')
  async clear(@Params(UuidParams) params: z.infer<typeof UuidParams>, @Body(ClearJurisdictionHoldCommandSchema) body: z.infer<typeof ClearJurisdictionHoldCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    try {
      return await this.principals.runAs(state, async (trx) => {
        const row = await jurisdictionHolds.clear(trx, { elevationId: elevation.id, requestId: state.requestId, reasonCode: 'jurisdiction_hold_cleared', reasonText: body.reason }, { holdId: params.id, reason: body.reason, evidence: body.evidence });
        return holdView(row);
      });
    } catch (error) {
      clearRefusal(error);
    }
  }
}
