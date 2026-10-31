import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { NoDealMandates, type DealMandatePort } from './mandates.js';
import { QuotesController, RfqComparisonController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { SellerStatedTax, type TaxDeterminationPort } from './tax.js';

export interface SalesModuleOptions {
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: DealMandatePort;
  /** How line taxes are determined; defaults to the seller's stated tax term (labelled `seller_stated`). */
  tax?: TaxDeterminationPort;
}

@Module({})
export class SalesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: SalesModuleOptions = {}): DynamicModule {
    const service = new SalesService(ctx, identity.principals, identity.participations, options.mandates ?? new NoDealMandates(), options.tax ?? new SellerStatedTax());
    return { module: SalesModule, controllers: [QuotesController, RfqComparisonController], providers: [{ provide: SalesService, useValue: service }], exports: [SalesService] };
  }
}
