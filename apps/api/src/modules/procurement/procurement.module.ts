import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { NoCommerceMandates, type CommerceMandatePort } from './mandates.js';
import { NeedsController, RfqInvitationsController, RfqsController } from './procurement.controller.js';
import { ProcurementService } from './procurement.service.js';

export interface ProcurementModuleOptions {
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: CommerceMandatePort;
}

@Module({})
export class ProcurementModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ProcurementModuleOptions = {}): DynamicModule {
    const service = new ProcurementService(ctx, identity.principals, identity.participations, options.mandates ?? new NoCommerceMandates());
    return {
      module: ProcurementModule, controllers: [NeedsController, RfqsController, RfqInvitationsController], providers: [{ provide: ProcurementService, useValue: service }], exports: [ProcurementService],
    };
  }
}
