import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { NoCommerceMandates, type CommerceMandatePort } from '../procurement/mandates.js';
import { CatalogueController } from './catalogue.controller.js';
import { CatalogueService } from './catalogue.service.js';

export interface CatalogueModuleOptions {
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: CommerceMandatePort;
}

@Module({})
export class CatalogueModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: CatalogueModuleOptions = {}): DynamicModule {
    const service = new CatalogueService(ctx, identity.principals, options.mandates ?? new NoCommerceMandates());
    return { module: CatalogueModule, controllers: [CatalogueController], providers: [{ provide: CatalogueService, useValue: service }], exports: [CatalogueService] };
  }
}
