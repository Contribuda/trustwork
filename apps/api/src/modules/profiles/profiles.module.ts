import type { CapabilityAuthority } from '../agent-modules/authority.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { PROFILE_SERVICE_BINDINGS } from '../agent-modules/profile-bindings.js';
import { bindServiceCapabilities } from '../agent-modules/service-bindings.js';
import { NoProfileMandates, type ProfileMandatePort } from './mandates.js';
import { CompanyPeopleController, MyProfileController, PublicProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';

export interface ProfilesModuleOptions {
  /** Shared configured entitlement/extension ports; the serving hub is resolved per invocation. */
  capabilities?: CapabilityAuthority;
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: ProfileMandatePort;
}

@Module({})
export class ProfilesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ProfilesModuleOptions = {}): DynamicModule {
    const service = bindServiceCapabilities(ctx, identity.principals, PROFILE_SERVICE_BINDINGS,
      (principals, publicBoundary) => new ProfilesService(ctx, principals, options.mandates ?? new NoProfileMandates(), publicBoundary), options.capabilities);
    return {
      module: ProfilesModule,
      controllers: [MyProfileController, PublicProfilesController, CompanyPeopleController],
      providers: [{ provide: ProfilesService, useValue: service }],
      exports: [ProfilesService],
    };
  }
}
