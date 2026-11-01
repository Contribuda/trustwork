import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { ProviderAdapterRegistry } from './adapters.js';
import { ProviderCallGate } from './gate.js';
import { ProvidersController } from './providers.controller.js';
import { ProvidersService } from './providers.service.js';
import { ExternalSecretReader, secretSealerFromEnv, type SecretSealer, type VaultClient } from './secret-store.js';

export interface ProvidersModuleOptions {
  /** The process environment (`TRUSTWORK_KEK`, `TRUSTWORK_KEK_FILE`, `TRUSTWORK_SECRET_DIR`); default `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** A sealer over an external KMS (`kmsSecretSealer`); default the environment's KEK, or none (secret writes refuse). */
  sealer?: SecretSealer | null;
  /** Adapter registry; LLM-001 and other packages register their live adapters on the exported instance. */
  adapters?: ProviderAdapterRegistry;
  /** Vault or KMS reader for credential references stored outside the database (none ships with the engine). */
  vault?: VaultClient | null;
  /** Upper bound of one connection test (default 15 seconds). */
  testTimeoutMs?: number;
}

/**
 * Keys, providers and models (KEYS-001). Exports `ProvidersService`, the `ProviderCallGate` every model or provider call
 * passes, and the `ProviderAdapterRegistry`.
 */
@Module({})
export class ProvidersModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ProvidersModuleOptions = {}): DynamicModule {
    const env = options.env ?? process.env;
    const sealer = options.sealer === undefined ? secretSealerFromEnv(env) : options.sealer;
    const adapters = options.adapters ?? new ProviderAdapterRegistry();
    const external = new ExternalSecretReader(env, options.vault ?? null);
    const service = new ProvidersService(ctx, identity.principals, { sealer, adapters, external, testTimeoutMs: options.testTimeoutMs ?? 15_000 });
    const gate = new ProviderCallGate(ctx.pool, sealer, external);
    return {
      module: ProvidersModule,
      controllers: [ProvidersController],
      providers: [
        { provide: ProvidersService, useValue: service }, { provide: ProviderCallGate, useValue: gate }, { provide: ProviderAdapterRegistry, useValue: adapters },
        { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
      ],
      exports: [ProvidersService, ProviderCallGate, ProviderAdapterRegistry],
    };
  }
}
