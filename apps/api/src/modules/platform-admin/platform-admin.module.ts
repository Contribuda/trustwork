import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { ActiveFlagsController, ConsoleServicesController } from './console-services/console-services.controller.js';
import { ConsoleServicesService } from './console-services/console-services.service.js';
import { AdminStaffController, ModerationParticipantController } from './platform-admin.controller.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { MyStaffInvitationsController, StaffLifecycleController } from './staff-lifecycle/staff-lifecycle.controller.js';
import { StaffLifecycleService } from './staff-lifecycle/staff-lifecycle.service.js';
import {
  MODERATION_TARGETS, RecordingModerationTargets, RecordingSanctionEnforcement, SANCTION_ENFORCEMENT, type ModerationTargetPort, type SanctionEnforcementPort,
} from './ports.js';

export interface PlatformAdminModuleOptions {
  /** Content owners applying moderation holds, removals and restorations; defaults to the recording fake until CNT-001. */
  moderationTargets?: ModerationTargetPort;
  /** Modules enforcing sanctions; defaults to the recording fake until the enforcing modules land. */
  sanctions?: SanctionEnforcementPort;
  /** The createApp environment, for the hub this API serves (`TRUSTWORK_HUB_ID`). */
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Platform administration (ADM-001). Other modules never import this one (tested); it reaches them only through the
 * ports in `ports.ts`, wired here by the composition root.
 */
@Module({})
export class PlatformAdminModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: PlatformAdminModuleOptions = {}): DynamicModule {
    const moderationTargets = options.moderationTargets ?? new RecordingModerationTargets();
    const sanctions = options.sanctions ?? new RecordingSanctionEnforcement();
    const service = new PlatformAdminService(ctx, identity.principals, moderationTargets, sanctions);
    return {
      module: PlatformAdminModule,
      controllers: [AdminStaffController, ModerationParticipantController, StaffLifecycleController, MyStaffInvitationsController, ConsoleServicesController, ActiveFlagsController],
      providers: [
        { provide: PlatformAdminService, useValue: service },
        // ADM-004 staff reads (staff-lifecycle/).
        { provide: StaffLifecycleService, useValue: new StaffLifecycleService(ctx, identity.principals, service) },
        // ADM-005 console navigation (console-services/).
        { provide: ConsoleServicesService, useValue: new ConsoleServicesService(ctx, identity.principals, service, staffHubFromEnv(options.env ?? process.env)) },
        { provide: SecondFactorService, useValue: identity.secondFactors },
        { provide: MODERATION_TARGETS, useValue: moderationTargets },
        { provide: SANCTION_ENFORCEMENT, useValue: sanctions },
        ElevationGuard,
      ],
    };
  }
}
