import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ApprovalRoutesController } from './approval-routes.controller.js';
import { ApprovalRoutesService } from './approval-routes.service.js';
import { PROCUREMENT_HUB_DEFAULTS } from './deps.js';
import { NoApprovalMandates, type ApprovalMandatePort } from './mandates.js';

export interface ApprovalRoutesModuleOptions {
  /** Agent mandate check for drafting, delegating, withdrawing and revoking; defaults to refusing every agent request. */
  mandates?: ApprovalMandatePort;
  /** Hub procurement setting `routeActivationSecondPerson`; defaults to the engine default (off). */
  routeActivationSecondPerson?: boolean;
}

@Module({})
export class ApprovalRoutesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ApprovalRoutesModuleOptions = {}): DynamicModule {
    const service = new ApprovalRoutesService(ctx, identity.principals, options.mandates ?? new NoApprovalMandates(), {
      routeActivationSecondPerson: options.routeActivationSecondPerson ?? PROCUREMENT_HUB_DEFAULTS.routeActivationSecondPerson,
    });
    return { module: ApprovalRoutesModule, controllers: [ApprovalRoutesController], providers: [{ provide: ApprovalRoutesService, useValue: service }], exports: [ApprovalRoutesService] };
  }
}
