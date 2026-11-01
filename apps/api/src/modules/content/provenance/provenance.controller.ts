import { IdSchema } from '../../../../../../packages/contracts/src/common/ids.js';
import { DraftSchema } from '../schemas.js';
import { Controller, Get, Header, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import {
  Authenticated,
  Idempotent,
  ReqState,
  type RequestState,
} from "../../../common/request.js";
import { Body, Params } from "../../../common/zod.js";
import {
  ProvenanceDeclarationSchema,
  ProvenanceReviewSchema,
  ProvenanceConsentSchema,
  ProvenanceRevokeSchema,
} from "../../../../../../packages/contracts/src/provenance.js";
import { ProvenanceService } from "./provenance.service.js";
const Staff = z.strictObject({ reason: z.string().trim().min(1).max(500) });
const Declare = z.strictObject({
  declaration: ProvenanceDeclarationSchema,
  staff: Staff.optional(),
});
const Review = z.strictObject({
  review: ProvenanceReviewSchema,
  staff: Staff.optional(),
});
const Id = z.strictObject({ id: IdSchema });
const Correction = z.strictObject({ expectedRevision: z.int().positive(), draft: DraftSchema, note: z.string().trim().min(1).max(500), staff: Staff.optional() });
@Controller("v1/provenance")
@Authenticated()
export class ProvenanceController {
  constructor(
    @Inject(ProvenanceService) private readonly service: ProvenanceService,
  ) {}
  @Get('publications/:id')
  @Header('Cache-Control', 'private, no-store')
  workspace(@ReqState() s: RequestState, @Params(Id) p: z.infer<typeof Id>) { return this.service.workspace(s,p.id); }
  @Post('publications/:id/correction-draft')
  @HttpCode(200)
  @Idempotent('provenance.prepare_correction', 'id')
  prepareCorrection(@ReqState() s: RequestState, @Params(Id) p: z.infer<typeof Id>, @Body(Correction) b: z.infer<typeof Correction>) {
    return this.service.prepareCorrection(s,p.id,b.expectedRevision,b.draft,b.note,b.staff);
  }
  @Post("declarations")
  @HttpCode(201)
  @Idempotent('provenance.declare')
  declare(
    @ReqState() s: RequestState,
    @Body(Declare) b: z.infer<typeof Declare>,
  ) {
    return this.service.declare(s, b.declaration, b.staff);
  }
  @Post("reviews")
  @HttpCode(201)
  @Idempotent('provenance.review')
  review(@ReqState() s: RequestState, @Body(Review) b: z.infer<typeof Review>) {
    return this.service.review(s, b.review, b.staff);
  }
  @Post("consents")
  @HttpCode(201)
  @Idempotent('provenance.consent')
  consent(
    @ReqState() s: RequestState,
    @Body(ProvenanceConsentSchema) b: z.infer<typeof ProvenanceConsentSchema>,
  ) {
    return this.service.consent(s, b);
  }
  @Post("revocations")
  @HttpCode(200)
  @Idempotent('provenance.revoke')
  revoke(
    @ReqState() s: RequestState,
    @Body(ProvenanceRevokeSchema) b: z.infer<typeof ProvenanceRevokeSchema>,
  ) {
    return this.service.revoke(s, b.consentId, b.reason);
  }
}
