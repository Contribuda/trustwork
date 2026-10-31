import { Module, type DynamicModule } from '@nestjs/common';
import type { DataPool } from '../../deps/data.js';
import { BillingService } from './billing.service.js';

/**
 * Billing services (BILL-001). Registered by the composition root once HTTP and agent surfaces are added; wiring it
 * into `app.module.ts` is a shared one-line registration owned by no package (ADR 012 decision 17).
 */
@Module({})
export class BillingModule {
  static forRoot(pool: DataPool): DynamicModule {
    return { module: BillingModule, providers: [{ provide: BillingService, useValue: new BillingService(pool) }], exports: [BillingService] };
  }
}
