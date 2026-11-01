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
import { SourcesModule } from './modules/sources/sources.module.js';
import { SupplierBaseModule } from './modules/supplier-base/supplier-base.module.js';
import { SupportModule } from './modules/support/support.module.js';
import { TransactionsModule } from './modules/transactions/transactions.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { ProvidersModule } from './modules/providers/providers.module.js';
import { TasksModule } from './modules/tasks/tasks.module.js';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module.js';
import { RecordingModerationTargets } from './modules/platform-admin/ports.js';
import { ConsultationsModule } from './modules/consultations/consultations.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { ContentModerationTargets } from './modules/content/moderation.js';
import { ExecutionModule } from './modules/execution/execution.module.js';
import { TrustModule } from './modules/trust/trust.module.js';
import { ReputationModule } from './modules/reputation/reputation.module.js';
import { AssistantModule, assistantMandateStore } from './modules/assistant/assistant.module.js';
import { MODULE_KEYS } from './modules/assistant/mandate-store.js';
import { AgentsModule } from './modules/assistant-goals/agents.module.js';
import { AttestationModule } from './modules/jurisdiction/attestation/attestation.module.js';
import type { ConfiguredGateMode } from './modules/jurisdiction/attestation/attestation.service.js';
import { HubsModule } from './modules/hubs/hubs.module.js';
import { HubsSetupModule } from './modules/hubs/setup/setup.module.js';
import { CommunicationsModule, type CommunicationsModuleOptions } from './modules/communications/communications.module.js';
import { ConnectionsOAuthModule } from './modules/connections/oauth/oauth.module.js';

@Controller()
export class HealthController {
  constructor(@Optional() @Inject(API_CONFIG) private readonly config: ApiConfig | null) {}
  /** Process liveness only; `externalProviders` reports the configured provider mode truthfully (disabled | fake | live). */
  @Get('health') getHealth() { return { ...health, externalProviders: this.config?.providers.mode ?? 'disabled' }; }
}

/**
 * Composition root: health always; identity, projects, directory, plans, catalogue, procurement,
 * sales, supplier base, transactions, profiles, tasks, execution, reputation and platform administration
 * only with a configured database. The same boundary registers support, consultations (CONS-001), content, sources (SRC-001),
 * assistant goals and representation, attestation (SANC-009), hubs (HUB-001), setup (HUB-004),
 * providers (KEYS-001), communications (COMMS-001) and MCP authorization (MCP-002).
 * Files additionally require a blob store. Module agent checks use the one AST-001 mandate store;
 * an explicitly supplied files mandate port still wins in tests.
 */
@Module({})
export class AppModule {
  static forRoot(ctx: AppContext | null, identity: IdentityServices | null, config: ApiConfig, files: FilesModuleOptions = { store: null }, jurisdictionGateMode: ConfiguredGateMode = 'unconfigured',
    communications: { options: CommunicationsModuleOptions; env?: NodeJS.ProcessEnv } = { options: {} }): DynamicModule {
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
        SourcesModule.forRoot(ctx, identity), // SRC-001
        SupplierBaseModule.forRoot(ctx, identity, { mandates: store.port(['procurement']) }), // PRC-003
        SupportModule.forRoot(ctx, identity),
        TransactionsModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.deals) }),
        ProfilesModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.profiles) }),
        // KEYS-001: provider connections, write-only secrets, routes, egress, caps and kill switches (KEK from the createApp environment).
        ProvidersModule.forRoot(ctx, identity, { env: communications.env }),
        TasksModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.tasks) }),
        ExecutionModule.forRoot(ctx, identity, { mandates: store.port(MODULE_KEYS.execution) }), TrustModule.forRoot(ctx, identity), ReputationModule.forRoot(ctx, identity),
        // CNT-001 applies moderation holds to publications and comments; other targets still reach ADM-001's recording fake.
        PlatformAdminModule.forRoot(ctx, identity, { moderationTargets: new ContentModerationTargets(new RecordingModerationTargets()) }),
        // CONS-001: agent checks go to the AST-001 mandate store (module key `consultation`).
        ConsultationsModule.forRoot(ctx, identity, { mandates: store.port(['consultation']) }),
        ContentModule.forRoot(ctx, identity),
        AssistantModule.forRoot(ctx, identity),
        AgentsModule.forRoot(ctx, identity),
        AttestationModule.forRoot(ctx, identity, { gateMode: jurisdictionGateMode }),
        HubsModule.forRoot(ctx, identity),
        // HUB-004: the setup wizard backend (told the gate mode, the blob store for the install check and the environment).
        HubsSetupModule.forRoot(ctx, identity, { gateMode: jurisdictionGateMode, objectStore: files.store, ...(communications.env ? { env: communications.env } : {}) }),
        FilesModule.forRoot(ctx, identity, { ...files, mandates: files.mandates ?? store.port(MODULE_KEYS.files) }),
        // COMMS-001: agent-written messages need a confirmed `communicate` mandate of the person's assistant.
        CommunicationsModule.forRoot(ctx, identity, { ...communications.options, mandates: communications.options.mandates ?? store.port(['correspondence']) }, communications.env),
        // MCP-002: the hub authorization server for the MCP surfaces.
        ConnectionsOAuthModule.forRoot(ctx, identity),
      ],
    };
  }
}
