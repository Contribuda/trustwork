import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import { ContentStaffController, PublicationsController, PublicContentController } from './content.controller.js';
import { ContentService } from './content.service.js';

export interface ContentModuleOptions {
  /** The hub this API serves; defaults to TRUSTWORK_HUB_ID read per request (a hub configured after start is picked up). */
  hubId?: string | null;
  /** Formats reviewed by hub staff before personal or company publications appear (hub policy, HUB-001); default none. */
  reviewFormats?: readonly string[];
  /** Comments are off by default per hub; default TRUSTWORK_CONTENT_COMMENTS=on read per request (HUB-001 configuration follows). */
  commentsEnabled?: boolean;
}

/** Publications, corrections and curated issues (CNT-001). */
@Module({})
export class ContentModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ContentModuleOptions = {}): DynamicModule {
    const hubId = options.hubId !== undefined ? () => options.hubId ?? null : () => staffHubFromEnv(process.env);
    const service = new ContentService(ctx, identity.principals, identity.secondFactors, {
      hubId, reviewFormats: options.reviewFormats ?? [], commentsEnabled: options.commentsEnabled !== undefined ? () => options.commentsEnabled as boolean : () => process.env.TRUSTWORK_CONTENT_COMMENTS === 'on',
    });
    return {
      module: ContentModule,
      controllers: [PublicationsController, PublicContentController, ContentStaffController],
      providers: [{ provide: ContentService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [ContentService],
    };
  }
}
