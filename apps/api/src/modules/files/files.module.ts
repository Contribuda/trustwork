import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import type { FilesModuleOptions } from './config.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { NoFileMandates } from './mandates.js';

export { filesOptionsFromEnv, type FilesModuleOptions, type FilesEnv } from './config.js';

/** Files (FILE-001). Mounted only with a configured blob store; otherwise `/v1/files/*` does not exist. */
@Module({})
export class FilesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: FilesModuleOptions): DynamicModule {
    if (!options.store) return { module: FilesModule };
    const service = new FilesService(ctx, identity.principals, identity.participations, {
      store: options.store, uploadTtlSeconds: options.uploadTtlSeconds, downloadTtlSeconds: options.downloadTtlSeconds, mandates: options.mandates ?? new NoFileMandates(),
    });
    return { module: FilesModule, controllers: [FilesController], providers: [{ provide: FilesService, useValue: service }], exports: [FilesService] };
  }
}
