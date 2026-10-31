import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../../common/errors.js';
import { Authenticated, CsrfExempt, ReqState, type RequestState } from '../../../common/request.js';
import { Body, Params, Query } from '../../../common/zod.js';
import { stateOf } from '../../../common/request.js';
import { ConsentDecisionSchema, OAuthService, type ConsentDecision, type OAuthResult } from './oauth.service.js';

/** Interaction responses of the authorization server can never be framed, cached or leak the URL as a referrer. */
const INTERACTION_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

function send(reply: FastifyReply, result: OAuthResult, extra: Record<string, string> = {}): FastifyReply {
  for (const [k, v] of Object.entries(extra)) reply.header(k, v);
  if (result.kind === 'redirect') return reply.code(302).header('location', result.location).send();
  for (const [k, v] of Object.entries(result.headers ?? {})) reply.header(k, v);
  return reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
}
const formOf = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {});

/**
 * Protocol endpoints of the hub authorization server (MCP-002): RFC 8414 and RFC 9728 metadata at the origin's
 * well-known paths, the authorization endpoint (a browser navigation), and the token, revocation and registration
 * endpoints that clients call without a session (CSRF does not apply: no cookie is read; PKCE, client authentication
 * and single-use codes protect them).
 */
@Controller()
export class OAuthProtocolController {
  constructor(@Inject(OAuthService) private readonly oauth: OAuthService) {}

  @Get('.well-known/oauth-authorization-server')
  serverMetadata(@Res() reply: FastifyReply) {
    return reply.header('cache-control', 'public, max-age=300').header('access-control-allow-origin', '*').type('application/json; charset=utf-8').send(this.oauth.authorizationServerMetadata());
  }

  @Get('.well-known/oauth-protected-resource/mcp')
  participantResource(@Res() reply: FastifyReply) {
    return this.resource(reply, 'participant');
  }

  @Get('.well-known/oauth-protected-resource/mcp/admin')
  adminResource(@Res() reply: FastifyReply) {
    return this.resource(reply, 'admin');
  }

  private resource(reply: FastifyReply, surface: 'participant' | 'admin') {
    const document = this.oauth.protectedResourceMetadata(surface);
    if (!document) return reply.code(404).type('application/json; charset=utf-8').send({ error: 'not_found' });
    return reply.header('cache-control', 'public, max-age=300').header('access-control-allow-origin', '*').type('application/json; charset=utf-8').send(document);
  }

  @Get('v1/oauth/authorize')
  async authorize(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const query = request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {};
    return send(reply, await this.oauth.authorize(query, stateOf(request)), INTERACTION_HEADERS);
  }

  @Post('v1/oauth/token') @CsrfExempt()
  async token(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return send(reply, await this.oauth.token(formOf(request), request.headers['content-type'], request.headers.dpop));
  }

  @Post('v1/oauth/revoke') @CsrfExempt()
  async revoke(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return send(reply, await this.oauth.revoke(formOf(request), request.headers['content-type']));
  }

  @Post('v1/oauth/register') @CsrfExempt()
  async register(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return send(reply, { kind: 'json', status: 400, body: { error: 'invalid_client_metadata', error_description: 'registration takes application/json' } });
    return send(reply, await this.oauth.register(request.body, request.ip));
  }
}

const RequestQuery = z.strictObject({ request: z.string().min(10).max(8_000) });
const IdParams = z.strictObject({ id: z.uuid() });

/**
 * First-party endpoints behind the consent page and Settings -> Connections (screens: MCP-070). The decision needs a
 * fresh step-up (and, for the staff surface, a live elevated session); the global CSRF guard applies to every mutation.
 */
@Controller('v1/oauth')
@Authenticated()
export class OAuthConsentController {
  constructor(@Inject(OAuthService) private readonly oauth: OAuthService) {}

  @Get('requests')
  async view(@Query(RequestQuery) query: z.infer<typeof RequestQuery>, @ReqState() state: RequestState, @Res({ passthrough: true }) reply: FastifyReply) {
    for (const [k, v] of Object.entries(INTERACTION_HEADERS)) reply.header(k, v);
    return this.oauth.consentView(query.request, state);
  }

  @Post('requests/decision') @HttpCode(200) @Authenticated('step_up')
  async decide(@Body(ConsentDecisionSchema) body: ConsentDecision, @ReqState() state: RequestState, @Res({ passthrough: true }) reply: FastifyReply) {
    for (const [k, v] of Object.entries(INTERACTION_HEADERS)) reply.header(k, v);
    return this.oauth.decide(body, state);
  }

  @Get('connections')
  list(@ReqState() state: RequestState) {
    return this.oauth.listConnections(state);
  }

  @Post('connections/revoke-all') @HttpCode(200)
  revokeAll(@ReqState() state: RequestState) {
    return this.oauth.revokeAllConnections(state);
  }

  @Post('connections/:id/revoke') @HttpCode(200)
  async revoke(@Params(IdParams) params: z.infer<typeof IdParams>, @ReqState() state: RequestState) {
    const result = await this.oauth.revokeConnection(params.id, state);
    if (!result) throw new ApiError('access.not_found');
    return result;
  }
}
