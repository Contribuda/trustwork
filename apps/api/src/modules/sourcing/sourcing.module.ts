import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { NoDealMandates, type DealMandatePort } from '../sales/mandates.js';
import { ScreenedMandates } from '../screening-gates/mandates.js';
import { sanctionsScreening, type SupplierScreeningPort } from '../supplier-base/screening.js';
import { ConfiguredElectronicRecords, type ElectronicRecordsPolicySource } from '../transactions/electronic-records.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { PROCUREMENT_HUB_DEFAULTS } from './deps.js';
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
  /** Agent check for the COM-002 commands an award executes through; defaults to refusing every agent request. */
  dealMandates?: DealMandatePort;
  /** The hub's electronic-records policy, as for direct acceptance. */
  electronicRecords?: ElectronicRecordsPolicySource;
  /** Hub setting, the engine default until HUBC-011 stores it per hub. The buyer still opts in per event. */
  feedbackBandsAllowed?: boolean;
}

@Module({})
export class SourcingModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: SourcingModuleOptions = {}): DynamicModule {
    // The same COM-002 use cases the agreement routes call, with the same screened mandates and consent policy.
    const transactions = new TransactionsService(ctx, identity.principals, identity.participations, new ScreenedMandates(options.dealMandates ?? new NoDealMandates(), ctx.pool, ctx.clock), options.electronicRecords ?? new ConfiguredElectronicRecords());
    const service = new SourcingService(
      ctx, identity.principals, options.mandates ?? new NoSourcingMandates(), options.screening ?? sanctionsScreening, options.prequalification ?? noPrequalificationEvidence, transactions,
      options.feedbackBandsAllowed ?? PROCUREMENT_HUB_DEFAULTS.feedbackBandsAllowed,
    );
    return { module: SourcingModule, controllers: [SourcingController], providers: [{ provide: SourcingService, useValue: service }], exports: [SourcingService] };
  }
}
