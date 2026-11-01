import { Module, type DynamicModule } from '@nestjs/common';
import { ScreenedMandates } from '../screening-gates/mandates.js';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { NoDealMandates, type DealMandatePort } from '../sales/mandates.js';
import { ConfiguredElectronicRecords, type ElectronicRecordsPolicySource } from './electronic-records.js';
import { AgreementsController, OrdersController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';

export interface TransactionsModuleOptions {
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: DealMandatePort;
  /** The hub's electronic-records policy; defaults to consent required with the engine's generic disclosure. */
  electronicRecords?: ElectronicRecordsPolicySource;
}

@Module({})
export class TransactionsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: TransactionsModuleOptions = {}): DynamicModule {
    const service = new TransactionsService(ctx, identity.principals, identity.participations, new ScreenedMandates(options.mandates ?? new NoDealMandates(), ctx.pool, ctx.clock), options.electronicRecords ?? new ConfiguredElectronicRecords());
    return { module: TransactionsModule, controllers: [AgreementsController, OrdersController], providers: [{ provide: TransactionsService, useValue: service }], exports: [TransactionsService] };
  }
}
