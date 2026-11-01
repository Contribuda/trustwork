import { sql } from 'kysely';
import type { DraftInput } from '../../../../../../packages/data/src/repositories/content.js';
import type { PrincipalService } from "../../identity/principal.service.js";
import type { SecondFactorService } from "../../identity/second-factor/second-factor.service.js";
import type { RequestState } from "../../../common/request.js";
import { ApiError } from "../../../common/errors.js";
import { mapContentError } from "../content.service.js";
import {
  provenance,
  type ProvenanceContext,
} from "../../../../../../packages/data/src/repositories/provenance.js";
import type {
  ProvenanceDeclaration,
  ProvenanceReview,
  ProvenanceConsent,
} from "../../../../../../packages/contracts/src/provenance.js";
import type { Transaction } from "../../../../../../packages/data/src/pool.js";
export class ProvenanceService {
  constructor(
    private readonly principals: PrincipalService,
    private readonly secondFactors: SecondFactorService,
  ) {}
  private async run<T>(
    state: RequestState,
    staff: { reason: string } | undefined,
    fn: (trx: Transaction, ctx: ProvenanceContext) => Promise<T>,
  ): Promise<T> {
    if (!state.session || state.principal?.delegation)
      throw new ApiError(
        "access.mandate_scope",
        "provenance is a first-party human decision",
      );
    const elevation = staff
      ? await this.secondFactors.requireElevation(state)
      : null;
    const ctx: ProvenanceContext = {
      sessionId: state.session.id,
      requestId: state.requestId,
      ...(elevation
        ? {
            elevationId: elevation.id,
            reasonCode: "provenance",
            reasonText: staff!.reason,
          }
        : {}),
    };
    return this.principals
      .runAs(state, async (trx, p) => {
        if (p.delegation)
          throw new ApiError(
            "access.mandate_scope",
            "provenance is a first-party human decision",
          );
        return fn(trx, ctx);
      }, { refreshStale: false })
      .catch((error: unknown) => {
        const pg = error as { hint?: string };
        if (pg.hint?.startsWith("provenance."))
          throw new ApiError(
            pg.hint === "provenance.first_party_required" || pg.hint === "provenance.authority_changed"
              ? "access.forbidden"
              : "validation.schema",
            "provenance command refused",
            { reason: pg.hint.slice(11) },
          );
        return mapContentError(error);
      });
  }
  workspace(state: RequestState, id: string) {
    return this.run(state, undefined, async (trx, ctx) => {
      const result = await sql<{ value: unknown }>`SELECT trustwork.provenance_workspace(${JSON.stringify(ctx)}::jsonb,${id}::uuid) AS value`.execute(trx);
      return result.rows[0]!.value;
    });
  }
  prepareCorrection(state: RequestState, id: string, expectedRevision: number, draft: DraftInput, note: string, staff?: { reason: string }) {
    return this.run(state, staff, async (trx, ctx) => {
      const result = await sql<{ id: string; revision: number }>`SELECT id,revision FROM trustwork.provenance_prepare_correction(${JSON.stringify(ctx)}::jsonb,${id}::uuid,${expectedRevision},${JSON.stringify(draft)}::jsonb,${note})`.execute(trx);
      return result.rows[0]!;
    });
  }
  declare(
    state: RequestState,
    input: ProvenanceDeclaration,
    staff?: { reason: string },
  ) {
    return this.run(state, staff, async (trx, c) => {
      const r = await provenance.declare(trx, c, input);
      return { id: r.id, revision: r.revision };
    });
  }
  review(
    state: RequestState,
    input: ProvenanceReview,
    staff?: { reason: string },
  ) {
    return this.run(state, staff, async (trx, c) => {
      const r = await provenance.review(trx, c, input);
      return { id: r.id, provenanceId: r.provenance_id };
    });
  }
  consent(state: RequestState, input: ProvenanceConsent) {
    return this.run(state, undefined, async (trx, c) => {
      const r = await provenance.consent(trx, c, input);
      return { consentId: r.id };
    });
  }
  revoke(state: RequestState, id: string, reason: string) {
    return this.run(state, undefined, (trx, c) =>
      provenance.revoke(trx, c, id, reason),
    );
  }
}
