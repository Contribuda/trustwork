import { Module, type DynamicModule } from '@nestjs/common';
import type { IdentityServices } from '../identity/identity.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
@Module({})
export class PaymentsModule {
  static forRoot(identity: IdentityServices): DynamicModule {
    return { module: PaymentsModule, controllers: [PaymentsController], providers: [{ provide: PaymentsService, useValue: new PaymentsService(identity.principals) }] };
  }
}
