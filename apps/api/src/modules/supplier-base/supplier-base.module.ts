import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { SupplierBaseController } from './supplier-base.controller.js';
import { SupplierBaseService } from './supplier-base.service.js';
import { NoSupplierBaseMandates, type SupplierBaseMandatePort } from './mandates.js';
import { sanctionsScreening, type SupplierScreeningPort } from './screening.js';

export interface SupplierBaseModuleOptions {
  /** Agent mandate check; defaults to refusing every agent request. */
  mandates?: SupplierBaseMandatePort;
  /** Counterparty screening; defaults to SANC-003's gate port (tests inject a failing port to prove fail-closed). */
  screening?: SupplierScreeningPort;
}

@Module({})
export class SupplierBaseModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: SupplierBaseModuleOptions = {}): DynamicModule {
    const service = new SupplierBaseService(ctx, identity.principals, options.mandates ?? new NoSupplierBaseMandates(), options.screening ?? sanctionsScreening);
    return { module: SupplierBaseModule, controllers: [SupplierBaseController], providers: [{ provide: SupplierBaseService, useValue: service }], exports: [SupplierBaseService] };
  }
}
