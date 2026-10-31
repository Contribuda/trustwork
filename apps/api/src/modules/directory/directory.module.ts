import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { DirectoryController } from './directory.controller.js';
import { DirectoryService } from './directory.service.js';

@Module({})
export class DirectoryModule {
  static forRoot(ctx: AppContext, identity: IdentityServices): DynamicModule {
    const service = new DirectoryService(ctx, identity.principals, identity.participations);
    return { module: DirectoryModule, controllers: [DirectoryController], providers: [{ provide: DirectoryService, useValue: service }], exports: [DirectoryService] };
  }
}
