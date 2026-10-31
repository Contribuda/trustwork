import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({})
export class ProjectsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices): DynamicModule {
    const service = new ProjectsService(ctx, identity.principals, identity.participations);
    return { module: ProjectsModule, controllers: [ProjectsController], providers: [{ provide: ProjectsService, useValue: service }], exports: [ProjectsService] };
  }
}
