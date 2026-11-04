import { Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Authenticated, CsrfExempt, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../../common/request.js';
import { ApiError } from '../../../common/errors.js';
import { Body, Params, Query } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { NodeHostSchema } from './deps.js';
import { FederationNodeService, type Elevated } from './federation-node.service.js';
import {
  AcceptPeeringCommandSchema, InitializeNodeCommandSchema, LowerPeeringCommandSchema, RecordCommandSchema, RefreshPeerCommandSchema, RequestPeeringCommandSchema, RotateKeyCommandSchema, UpdateNodeCommandSchema,
} from './schemas.js';

const Uuid = z.uuid();
const RecordParams = z.strictObject({ recordId: Uuid });
const RecordsQuery = z.strictObject({ hubId: Uuid.optional(), peerNode: NodeHostSchema.optional() });
type P<S extends z.ZodType> = z.infer<S>;
type RawBodyRequest = TrustworkRequest & { trustworkRawBody?: Buffer };

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}
const headerOf = (request: TrustworkRequest) => (name: string): string | null => {
  const value = request.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? null) : null;
};

/**
 * The mesh endpoints of FED-001 (protocol sections 3, 4 and 7): the public signed manifest and the handshake. Neither
 * uses a session or a cookie, so the CSRF defence does not apply; the handshake is authenticated by its RFC 9421
 * signature against the initiator's manifest, and every answer is signed with the node key. The jurisdiction gate
 * (SANC-001) still refuses restricted places at the door before these routes run.
 */
@Controller()
export class FederationMeshController {
  constructor(@Inject(FederationNodeService) private readonly node: FederationNodeService) {}

  @Get('.well-known/trustwork/manifest.json')
  async manifest(@Res({ passthrough: true }) reply: FastifyReply) {
    const current = await this.node.manifest();
    reply.header('Cache-Control', 'public, max-age=300');
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return current.document;
  }

  @Post('federation/v1/handshake') @CsrfExempt()
  async handshake(@Req() request: RawBodyRequest, @Res() reply: FastifyReply) {
    const result = await this.node.receiveHandshake({
      method: request.method, url: request.url, header: headerOf(request), body: request.body, rawBody: request.trustworkRawBody ?? null,
      address: request.ip ?? null, requestId: request.trustwork.requestId,
    });
    reply.code(result.status).header('Cache-Control', 'no-store');
    if (result.fields) for (const [name, value] of Object.entries(result.fields)) reply.header(name, value);
    else reply.header('Content-Type', 'application/json');
    // The signed bytes are the JCS form; send exactly what the Content-Digest covers.
    return reply.send(Buffer.from(JSON.stringify(sortKeys(result.body))));
  }
}
/** Key-sorted JSON (RFC 8785 for the documents this endpoint sends: plain objects, strings, integers and booleans). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  return value;
}

/**
 * Hub console routes of the federation node (FED-001). Every route needs a signed-in session, a staff role and a live
 * elevation (BE-004 `ElevationGuard`); every mutation carries the CSRF header, an `Idempotency-Key` restated in the
 * command body and a staff reason, and is authorized again by the database at the node or the hub.
 */
@Controller('v1/admin/federation')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminFederationController {
  constructor(@Inject(FederationNodeService) private readonly node: FederationNodeService) {}

  @Get('node')
  node_(@ReqState() state: RequestState) {
    return this.node.node(state);
  }
  @Post('node') @HttpCode(201) @Idempotent('federation.node_initialize')
  initialize(@Body(InitializeNodeCommandSchema) body: P<typeof InitializeNodeCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.initialize(elevated(state, e, r), body);
  }
  @Post('node/update') @HttpCode(200) @Idempotent('federation.node_update')
  update(@Body(UpdateNodeCommandSchema) body: P<typeof UpdateNodeCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.update(elevated(state, e, r), body);
  }
  @Post('node/keys/rotate') @HttpCode(200) @Idempotent('federation.key_rotate')
  rotate(@Body(RotateKeyCommandSchema) body: P<typeof RotateKeyCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.rotateKey(elevated(state, e, r), body);
  }

  @Get('peers')
  peers(@ReqState() state: RequestState) {
    return this.node.peers(state);
  }
  @Post('peers/refresh') @HttpCode(200) @Idempotent('federation.peer_refresh')
  refresh(@Body(RefreshPeerCommandSchema) body: P<typeof RefreshPeerCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.refreshPeerCommand(elevated(state, e, r), body);
  }
  @Get('refusals')
  refusals(@ReqState() state: RequestState) {
    return this.node.refusals(state);
  }

  @Get('peerings')
  records(@Query(RecordsQuery) q: P<typeof RecordsQuery>, @ReqState() state: RequestState) {
    return this.node.records(state, { ...(q.hubId ? { hubId: q.hubId } : {}), ...(q.peerNode ? { peerNode: q.peerNode } : {}) });
  }
  @Post('peerings') @HttpCode(201) @Idempotent('federation.peering_request')
  request(@Body(RequestPeeringCommandSchema) body: P<typeof RequestPeeringCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.requestPeering(elevated(state, e, r), body);
  }
  @Get('peerings/:recordId')
  record(@Params(RecordParams) p: P<typeof RecordParams>, @ReqState() state: RequestState) {
    return this.node.record(state, p.recordId);
  }
  @Post('peerings/:recordId/accept') @HttpCode(200) @Idempotent('federation.peering_accept')
  accept(@Params(RecordParams) p: P<typeof RecordParams>, @Body(AcceptPeeringCommandSchema) body: P<typeof AcceptPeeringCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.acceptPeering(elevated(state, e, r), p.recordId, body);
  }
  @Post('peerings/:recordId/decline') @HttpCode(200) @Idempotent('federation.peering_decline')
  decline(@Params(RecordParams) p: P<typeof RecordParams>, @Body(RecordCommandSchema) body: P<typeof RecordCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.declinePeering(elevated(state, e, r), p.recordId, body);
  }
  @Post('peerings/:recordId/lower') @HttpCode(200) @Idempotent('federation.peering_lower')
  lower(@Params(RecordParams) p: P<typeof RecordParams>, @Body(LowerPeeringCommandSchema) body: P<typeof LowerPeeringCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.lowerPeering(elevated(state, e, r), p.recordId, body);
  }
  @Post('peerings/:recordId/suspend') @HttpCode(200) @Idempotent('federation.peering_suspend')
  suspend(@Params(RecordParams) p: P<typeof RecordParams>, @Body(RecordCommandSchema) body: P<typeof RecordCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.suspendPeering(elevated(state, e, r), p.recordId, body);
  }
  @Post('peerings/:recordId/lift') @HttpCode(200) @Idempotent('federation.peering_lift')
  lift(@Params(RecordParams) p: P<typeof RecordParams>, @Body(RecordCommandSchema) body: P<typeof RecordCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.liftSuspension(elevated(state, e, r), p.recordId, body);
  }
  @Post('peerings/:recordId/end') @HttpCode(200) @Idempotent('federation.defederate')
  end(@Params(RecordParams) p: P<typeof RecordParams>, @Body(RecordCommandSchema) body: P<typeof RecordCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.node.endPeering(elevated(state, e, r), p.recordId, body);
  }
}
export { ApiError };
