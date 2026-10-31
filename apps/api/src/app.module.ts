import { Controller, Get, Inject, Module, Optional, type DynamicModule } from '@nestjs/common';
import { health } from './deps/contracts.js';
import type { ApiConfig } from './config.js';
export const API_CONFIG = Symbol('trustwork.api-config');
import type { AppContext } from './modules/identity/context.js';
import { IdentityModule, type IdentityServices } from './modules/identity/identity.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { DirectoryModule } from './modules/directory/directory.module.js';
import { PlansModule } from './modules/plans/plans.module.js';
import { CatalogueModule } from './modules/catalogue/catalogue.module.js';
import { ProcurementModule } from './modules/procurement/procurement.module.js';
import { ApprovalRoutesModule } from './modules/approval-routes/approval-routes.module.js';
import { FilesModule, type FilesModuleOptions } from './modules/files/files.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { TransactionsModule } from './modules/transactions/transactions.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { TasksModule } from './modules/tasks/tasks.module.js';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module.js';
import { ExecutionModule } from './modules/execution/execution.module.js';
import { TrustModule } from './modules/trust/trust.module.js';
import { ReputationModule } from './modules/reputation/reputation.module.js';
import { AssistantModule, assistantMandateStore } from './modules/assistant/assistant.module.js';
import { MODULE_KEYS } from './modules/assistant/mandate-store.js';
import { AgentsModule } from './modules/assistant-goals/agents.module.js';
import { AttestationModule } from './modules/jurisdiction/attestation/attestation.module.js';
import type { ConfiguredGateMode } from './modules/jurisdiction/attestation/attestation.service.js';
import { HubsModule } from './modules/hubs/hubs.module.js';

@Controller()
export class HealthController {
  constructor(@Optional() @Inject(API_CONFIG) private readonly config: ApiConfig | null) {}
  /** Process liveness only; `externalProviders` reports the configured provider mode truthfully (disabled | fake | live). */
  @Get('health') getHealth() { return { ...health, externalProviders: this.config?.providers.mode ?? 'disabled' }; }
}

/**
 * Composition root: health always; identity, projects, directory, plans, catalogue, procurement, sales, transactions,
 * profiles, tasks, execution and trust, platform administration, the assistant, agent goals and representation (AGT-001), the
 * deployment-location attestation (SANC-009, told the configured jurisdiction gate mode) and hubs (HUB-001) only when a
 * database is configured;
 * profiles, tasks, execution and trust, the reputation builder, platform administration, the assistant and the deployment-location attestation
 * Composition root: health always; identity, projects, directory, plans, catalogue, procurement, approval routes, sales, transactions,
 * profiles, tasks, execution and trust, platform administration, the assistant and the deployment-location attestation
 * (SANC-009, told the configured jurisdiction gate mode) only when a database is configured;
 * files (FILE-001) additionally only with a configured blob store. Every module's agent check goes to the one AST-001
 * mandate store (confirmed mandates); a caller-supplied mandate port in `files` still wins (tests).
 */
@Module({})
export class AppModule {
  static forRoot(ctx: AppContext | null, identity: IdentityServices | null, config: ApiConfig, files: FilesModuleOptions = { store: null }, jurisdictionGateMode: ConfiguredGateMode = 'unconfigured'): DynamicModule {
    if (!ctx || !identity) return { module: AppModule, controllers: [HealthController], providers: [{ provide: API_CONFIG, useValue: config }], imports: [] };
    const store = assistantMandateStore(ctx);
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: API_CONFIG, useValue: config }],
      imports: [
        IdentityModule.forRoot(ctx, identity), ProjectsModule.forRoot(ctx, identity), DirectoryModule.forRoot(ctx, identity),
        PlansModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.plans) }),
        CatalogueModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.commerce) }),
        ProcurementModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.commerce) }),
        ApprovalRoutesModule.forRoot(ctx, identity, { mandates: store.port(['procurement']) }), // PRC-001
        SalesModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.deals) }),
        TransactionsModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.deals) }),
        ProfilesModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.profiles) }),
        TasksModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.tasks) }),
        ExecutionModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.execution) }), TrustModule.forRoot(ctx, identity), ReputationModule.forRoot(ctx, identity),
        PlatformAdminModule.forRoot(ctx, identity),
        AssistantModule.forRoot(ctx, identity),
        AgentsModule.forRoot(ctx, identity),
        AttestationModule.forRoot(ctx, identity, { gateMode: jurisdictionGateMode }),
        HubsModule.forRoot(ctx, identity),
        FilesModule.forRoot(ctx, identity, { ...files, mandates: files.mandates ?? store.port(MODULE_KEYS.files) }),
      ],
    };
  }
}
