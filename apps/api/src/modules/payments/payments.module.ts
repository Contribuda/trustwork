import { Module, type DynamicModule } from '@nestjs/common';
import type { IdentityServices } from '../identity/identity.module.js';
import { PaymentSourcesController, PaymentSourceReviewsController } from './payment-sources.controller.js';
import { PaymentSourcesService } from './payment-sources.service.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
@Module({})
export class PaymentsModule {
  static forRoot(identity: IdentityServices): DynamicModule {
    return { module: PaymentsModule, controllers: [PaymentsController, PaymentSourcesController, PaymentSourceReviewsController], providers: [ElevationGuard, { provide: SecondFactorService, useValue: identity.secondFactors }, { provide: PaymentSourcesService, useValue: new PaymentSourcesService(identity.principals) }, { provide: PaymentsService, useValue: new PaymentsService(identity.principals) }] };
  }
}
