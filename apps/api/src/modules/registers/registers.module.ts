import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { AdminRegistersController, CompanyRegistersController } from './registers.controller.js';
import { RegistersService } from './registers.service.js';

/** Public-register and licence-board facts: console routes, the public projection and company reminders (REG-001). */
@Module({})
export class RegistersModule {
  static forRoot(ctx: AppContext, identity: IdentityServices): DynamicModule {
    const service = new RegistersService(ctx, identity.principals);
    return {
      module: RegistersModule,
      controllers: [AdminRegistersController, CompanyRegistersController],
      providers: [{ provide: RegistersService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [RegistersService],
    };
  }
}
