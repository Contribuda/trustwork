import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import { JurisdictionConsentCommandSchema } from '../../../../../../packages/contracts/src/jurisdiction.js';
import { JurisdictionConsentService } from './consent.service.js';

const Quote = z.strictObject({ quoteId: z.uuid() });
const Receipt = z.strictObject({ receiptId: z.uuid() });

@Controller('v1/jurisdiction-consents')
@Authenticated()
export class JurisdictionConsentController {
  constructor(@Inject(JurisdictionConsentService) private readonly consent: JurisdictionConsentService) {}

  @Get('quotes/:quoteId')
  preview(@ReqState() state: RequestState, @Params(Quote) p: z.infer<typeof Quote>) {
    return this.consent.preview(state, p.quoteId);
  }

  @Post('quotes/:quoteId') @HttpCode(200) @Idempotent('jurisdiction.consent_grant')
  grant(@ReqState() state: RequestState, @Params(Quote) p: z.infer<typeof Quote>, @Body(JurisdictionConsentCommandSchema) body: z.infer<typeof JurisdictionConsentCommandSchema>) {
    return this.consent.grant(state, p.quoteId, body);
  }

  @Post(':receiptId/revoke') @HttpCode(200) @Idempotent('jurisdiction.consent_revoke')
  revoke(@ReqState() state: RequestState, @Params(Receipt) p: z.infer<typeof Receipt>, @Body(z.strictObject({})) _body: Record<string, never>) {
    void _body;
    return this.consent.revoke(state, p.receiptId);
  }
}
