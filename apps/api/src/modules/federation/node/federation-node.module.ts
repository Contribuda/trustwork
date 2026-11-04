import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Inject, Injectable, Module, type DynamicModule, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import { loadRestrictedPlaces } from '../../jurisdiction/gate.js';
import { nodeKeySealerFromEnv, type NodeKeySealer } from './crypto.js';
import { AdminFederationController, FederationMeshController } from './federation-node.controller.js';
import { FederationNodeService, type ReverificationPort } from './federation-node.service.js';
import { HttpsPeerTransport, OfflinePeerTransport, type PeerTransport } from './transport.js';

export interface FederationRefreshOptions {
  /** Default: on exactly when the node reaches peers (the HTTPS transport: production or `TRUSTWORK_FEDERATION_TRANSPORT=https`); tests with a fake transport opt in. */
  enabled?: boolean;
  /** Default every 6 hours; peers are due daily, so a missed tick still refreshes within the day. */
  intervalMs?: number;
}
export interface FederationNodeModuleOptions {
  refresh?: FederationRefreshOptions;
  /** The process environment (`TRUSTWORK_KEK`, `TRUSTWORK_KEK_FILE`); default `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Seals node seeds; default the key-encryption key of the given environment, else of the process environment, else null (key generation refuses). */
  sealer?: NodeKeySealer | null;
  /** How peers are reached; default HTTPS to `https://<DNS name>` in production or with `TRUSTWORK_FEDERATION_TRANSPORT=https`, else offline; tests pass a local fake. */
  transport?: PeerTransport;
  /** Engine version and public source for the manifest when the operator does not state them. */
  engine?: { version: string; source: string };
  reverification?: ReverificationPort;
}

export const ENGINE_SOURCE = 'https://github.com/Contribuda/trustwork';
const RAW_BODY_PREFIX = '/federation/v1/';

/**
 * Captures the exact body bytes of mesh requests before Fastify parses them, so the RFC 9530 content digest and the
 * RFC 9421 signature are checked over what was sent, not over a re-serialization. Only `/federation/v1/*` is touched.
 */
@Injectable()
export class RawBodyCapture implements OnModuleInit {
  constructor(@Inject(HttpAdapterHost) private readonly host: HttpAdapterHost) {}
  onModuleInit(): void {
    const fastify = this.host.httpAdapter?.getInstance?.() as FastifyInstance | undefined;
    if (!fastify || typeof fastify.addHook !== 'function') return;
    fastify.addHook('preParsing', async (request: FastifyRequest, _reply: FastifyReply, payload: Readable) => {
      if (!request.url.startsWith(RAW_BODY_PREFIX)) return payload;
      const chunks: Buffer[] = [];
      for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      const raw = Buffer.concat(chunks);
      (request as FastifyRequest & { trustworkRawBody?: Buffer }).trustworkRawBody = raw;
      const stream = Readable.from([raw]) as Readable & { receivedEncodedLength?: number };
      stream.receivedEncodedLength = raw.length;
      return stream;
    });
  }
}

export const REFRESH_INTERVAL_MS = 6 * 3_600_000;
/**
 * The daily refresh of peers' manifests and admissions, run from the API process every 6 hours while the node can reach
 * peers (the proper home is the worker; see the module README). The service holds a PostgreSQL advisory lock for the run,
 * so several API instances never refresh the same peer at once; the timer is cleared on shutdown. Until the worker move,
 * a peer past its refresh by more than a day counts as not admitted at every point of use (`federation_peer_current`),
 * so a timer that never fired fails closed.
 */
@Injectable()
export class FederationRefreshTimer implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly service: FederationNodeService, private readonly options: { enabled: boolean; intervalMs: number; log: (message: string, error?: unknown) => void }) {}
  get active(): boolean {
    return this.timer !== null;
  }
  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }
  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** One tick (also callable by tests); ticks never overlap within an instance. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.service.refreshDueLocked().then(
      (result) => { if ('refreshed' in result && result.refreshed.length) this.options.log('federation.refresh_tick', { refreshed: result.refreshed }); },
      (error: unknown) => this.options.log('federation.refresh_tick_failed', error),
    ).finally(() => { this.running = null; });
    return this.running;
  }
}

/** Node identity, keys, the signed manifest, handshakes and peering records (FED-001). `FederationNodeService` is exported for later federation packages. */
@Module({})
export class FederationNodeModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: FederationNodeModuleOptions = {}): DynamicModule {
    const env = options.env ?? process.env;
    const read = (path: string) => readFileSync(path, 'utf8');
    // Resolved when a key is generated, so a KEK mounted after start (or set for a test process) is seen without a restart.
    const sealer = options.sealer === undefined ? () => nodeKeySealerFromEnv(env, read) ?? (env === process.env ? null : nodeKeySealerFromEnv(process.env, read)) : () => options.sealer as NodeKeySealer | null;
    const reachesPeers = ctx.config.production || env.TRUSTWORK_FEDERATION_TRANSPORT === 'https';
    const transport = options.transport ?? (reachesPeers ? new HttpsPeerTransport() : new OfflinePeerTransport());
    const service = new FederationNodeService(ctx, identity.principals, {
      sealer, transport, restricted: () => loadRestrictedPlaces(ctx.pool),
      engine: options.engine ?? { version: '0.1.0', source: ENGINE_SOURCE }, ...(options.reverification ? { reverification: options.reverification } : {}),
    });
    const timer = new FederationRefreshTimer(service, { enabled: options.refresh?.enabled ?? (options.transport === undefined && reachesPeers), intervalMs: options.refresh?.intervalMs ?? REFRESH_INTERVAL_MS, log: ctx.log });
    return {
      module: FederationNodeModule,
      controllers: [FederationMeshController, AdminFederationController],
      providers: [{ provide: FederationNodeService, useValue: service }, { provide: FederationRefreshTimer, useValue: timer }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard, RawBodyCapture],
      exports: [FederationNodeService, FederationRefreshTimer],
    };
  }
}
