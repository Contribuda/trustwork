import type { CapabilityAuthority } from '../agent-modules/authority.js';
import { bindServiceCapabilities } from '../agent-modules/service-bindings.js';
import { CONSULTATION_SERVICE_BINDINGS } from '../agent-modules/consultation-bindings.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import { ConfiguredElectronicRecords, type ElectronicRecordsPolicySource } from '../transactions/electronic-records.js';
import {
  ConsultationAgreementsController, ConsultationAvailabilityController, ConsultationBookingsController, ConsultationDeliverablesController, ConsultationOfferingsController,
  ConsultationRequestsController, MentoringController,
} from './consultations.controller.js';
import { ConsultationsService } from './consultations.service.js';
import { NoConsultationMandates, type ConsultationMandatePort } from './mandates.js';
import { VersionedConsultationFees } from '../billing/fees/consultation-adapter.js';
import { ScreeningCommitmentGate, type ConsultationCommissionPort, type ConsultationScreeningGate } from './ports.js';

export interface ConsultationsModuleOptions {
  capabilities?: CapabilityAuthority;
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: ConsultationMandatePort;
  /** The hub's electronic-records policy; defaults to consent required with the engine's generic disclosure. */
  electronicRecords?: ElectronicRecordsPolicySource;
  /** The hub commission (BILL-003); defaults to the fail-closed BILL-003 adapter. */
  commission?: ConsultationCommissionPort;
  /** The screening gate (SANC-004); defaults to SANC-004's transactional commitment gate, failing closed. */
  screening?: ConsultationScreeningGate;
}

@Module({})
export class ConsultationsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ConsultationsModuleOptions = {}, env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const service = bindServiceCapabilities(ctx, identity.principals, CONSULTATION_SERVICE_BINDINGS, (principals, publicBoundary) => new ConsultationsService(
      ctx, principals, options.mandates ?? new NoConsultationMandates(), options.electronicRecords ?? new ConfiguredElectronicRecords(),
      options.commission ?? new VersionedConsultationFees(staffHubFromEnv(env)), options.screening ?? new ScreeningCommitmentGate(), staffHubFromEnv(env), publicBoundary,
    ), options.capabilities);
    return {
      module: ConsultationsModule,
      controllers: [
        ConsultationOfferingsController, ConsultationAvailabilityController, ConsultationRequestsController, ConsultationAgreementsController, ConsultationBookingsController,
        ConsultationDeliverablesController, MentoringController,
      ],
      providers: [{ provide: ConsultationsService, useValue: service }],
      exports: [ConsultationsService],
    };
  }
}
