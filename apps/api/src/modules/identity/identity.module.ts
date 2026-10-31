import { Module, type DynamicModule } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { APP_CONTEXT, type AppContext } from './context.js';
import { AuthController } from './controllers/auth.controller.js';
import { CompaniesController } from './controllers/companies.controller.js';
import { MeController } from './controllers/me.controller.js';
import { MembershipService } from './membership.service.js';
import { PasswordService } from './password.service.js';
import { ParticipationService } from './policy/participation.service.js';
import { PrincipalService } from './principal.service.js';
import { ProviderService } from './providers/provider.service.js';
import { ElevationGuard } from './second-factor/elevation.guard.js';
import { AdminSessionController, MeSecondFactorController, SecondFactorLoginController, SupportSecondFactorController } from './second-factor/second-factor.controllers.js';
import { SecondFactorService } from './second-factor/second-factor.service.js';

/** Service graph built once from the application context so the Fastify hook and Nest share the same instances. */
export interface IdentityServices {
  passwords: PasswordService;
  principals: PrincipalService;
  auth: AuthService;
  providers: ProviderService;
  memberships: MembershipService;
  participations: ParticipationService;
  secondFactors: SecondFactorService;
}
export function buildIdentityServices(ctx: AppContext): IdentityServices {
  const passwords = new PasswordService(ctx.config.password);
  const principals = new PrincipalService(ctx);
  const secondFactors = new SecondFactorService(ctx, principals);
  return {
    passwords,
    principals,
    auth: new AuthService(ctx, passwords, principals, secondFactors),
    providers: new ProviderService(ctx, principals, secondFactors),
    memberships: new MembershipService(ctx, principals),
    participations: new ParticipationService(ctx),
    secondFactors,
  };
}

@Module({})
export class IdentityModule {
  static forRoot(ctx: AppContext, services: IdentityServices): DynamicModule {
    return {
      module: IdentityModule,
      controllers: [AuthController, MeController, CompaniesController, MeSecondFactorController, SecondFactorLoginController, AdminSessionController, SupportSecondFactorController],
      providers: [
        { provide: APP_CONTEXT, useValue: ctx },
        { provide: AuthService, useValue: services.auth },
        { provide: ProviderService, useValue: services.providers },
        { provide: MembershipService, useValue: services.memberships },
        { provide: PrincipalService, useValue: services.principals },
        { provide: ParticipationService, useValue: services.participations },
        { provide: SecondFactorService, useValue: services.secondFactors },
        ElevationGuard,
      ],
      exports: [APP_CONTEXT, PrincipalService, ParticipationService, SecondFactorService, ElevationGuard],
    };
  }
}
