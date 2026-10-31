import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { oauthSettingsFromEnv, type OAuthSettings } from './config.js';
import { FakeDns, FakeTransport, GuardedFetcher, pinnedHttpsTransport, systemResolver } from './egress.js';
import { OAuthConsentController, OAuthProtocolController } from './oauth.controller.js';
import { OAuthService, type ClientMetadataFetcher } from './oauth.service.js';
import { ResourceTokenVerifier } from './resource.js';

export interface OAuthModuleOptions {
  settings?: OAuthSettings;
  /** Overrides the metadata fetcher chosen by `settings.metadataFetch` (tests). */
  fetcher?: ClientMetadataFetcher | null;
  env?: NodeJS.ProcessEnv;
}

/** The scriptable egress pair used in `fake` mode; tests reach it through `app.get(FakeEgress)`. */
export class FakeEgress {
  readonly dns = new FakeDns();
  readonly transport = new FakeTransport();
}

/**
 * The hub authorization server for the MCP surfaces (MCP-002). Exports `OAuthService` and `ResourceTokenVerifier`
 * (the MCP transport, MCP-003, mounts `mcpResourceHook` with it on `/mcp` and `/mcp/admin`).
 */
@Module({})
export class ConnectionsOAuthModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: OAuthModuleOptions = {}): DynamicModule {
    const settings = options.settings ?? oauthSettingsFromEnv(ctx.config, options.env);
    const fake = new FakeEgress();
    const fetcher = options.fetcher !== undefined ? options.fetcher
      : settings.metadataFetch === 'live' ? new GuardedFetcher(systemResolver, pinnedHttpsTransport)
        : settings.metadataFetch === 'fake' ? new GuardedFetcher(fake.dns, fake.transport) : null;
    const service = new OAuthService(ctx, identity, settings, fetcher);
    const verifier = new ResourceTokenVerifier(ctx.pool, settings, ctx.staffRoles, ctx.clock);
    return {
      module: ConnectionsOAuthModule,
      controllers: [OAuthProtocolController, OAuthConsentController],
      providers: [{ provide: OAuthService, useValue: service }, { provide: ResourceTokenVerifier, useValue: verifier }, { provide: FakeEgress, useValue: fake }],
      exports: [OAuthService, ResourceTokenVerifier],
    };
  }
}
