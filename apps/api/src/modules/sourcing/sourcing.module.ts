import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { sanctionsScreening, type SupplierScreeningPort } from '../supplier-base/screening.js';
import { noPrequalificationEvidence, type PrequalificationEvidencePort } from './eligibility.js';
import { NoSourcingMandates, type SourcingMandatePort } from './mandates.js';
import { SourcingController } from './sourcing.controller.js';
import { SourcingService } from './sourcing.service.js';

export interface SourcingModuleOptions {
  /** Agent mandate check; defaults to refusing every agent request. */
  mandates?: SourcingMandatePort;
  /** Counterparty screening; defaults to SANC-003's gate port. */
  screening?: SupplierScreeningPort;
  /** Passport sections shared by consent; defaults to answering nothing until PREQ-001 exists, so those rules stay `unknown`. */
  prequalification?: PrequalificationEvidencePort;
}

@Module({})
export class SourcingModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: SourcingModuleOptions = {}): DynamicModule {
    const service = new SourcingService(ctx, identity.principals, options.mandates ?? new NoSourcingMandates(), options.screening ?? sanctionsScreening, options.prequalification ?? noPrequalificationEvidence);
    return { module: SourcingModule, controllers: [SourcingController], providers: [{ provide: SourcingService, useValue: service }], exports: [SourcingService] };
  }
}
