import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { NoProfileMandates, type ProfileMandatePort } from './mandates.js';
import { CompanyPeopleController, MyProfileController, PublicProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';

export interface ProfilesModuleOptions {
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: ProfileMandatePort;
}

@Module({})
export class ProfilesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ProfilesModuleOptions = {}): DynamicModule {
    const service = new ProfilesService(ctx, identity.principals, options.mandates ?? new NoProfileMandates());
    return {
      module: ProfilesModule,
      controllers: [MyProfileController, PublicProfilesController, CompanyPeopleController],
      providers: [{ provide: ProfilesService, useValue: service }],
      exports: [ProfilesService],
    };
  }
}
