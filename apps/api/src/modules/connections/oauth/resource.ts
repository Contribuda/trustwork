import type { FastifyReply, FastifyRequest } from 'fastify';
import { withPrincipal, type DataPool } from '../../../deps/data.js';
import type { Clock, StaffRoleResolver } from '../../identity/ports.js';
import { MCP_ENDPOINT_PATHS } from './deps.js';
import { protectedResourceMetadataUrl, type OAuthSettings, type OAuthSurface } from './config.js';
import { credentialKindOf, hashCredential, ReplayCache } from './crypto.js';
import { oauthTokens, type IntrospectedToken } from './deps.js';
import { DPOP_ALGS, JoseError, verifyDpopProof } from './jose.js';

/**
 * The resource server's token check for the MCP surfaces (MCP-002 provides it; the MCP transport, MCP-003, mounts it).
 *
 * - Only the `Authorization` header counts: `Bearer <token>`, or `DPoP <token>` with a DPoP proof for a key-bound token.
 *   Session cookies never authorize an MCP surface, and a token in the query string is refused.
 * - The token must be a live access token whose audience is exactly this surface's canonical URI; a token for `/mcp`
 *   is refused on `/mcp/admin` and the other way round, and no MCP token is ever accepted by the first-party API
 *   (whose principal comes only from the session cookie).
 * - The grant is read from the live consent on every call; a held or suspended person, a revoked connection, family
 *   or client, or an expired consent ends the token at the next call. Staff tokens additionally need a current staff role.
 * - Failures answer 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728) and never say why.
 */
export interface VerifiedConnection extends IntrospectedToken { audience: string; tokenType: 'Bearer' | 'DPoP' }

export class ResourceChallenge extends Error {
  constructor(readonly status: 400 | 401 | 403, readonly wwwAuthenticate: string, readonly error: string) {
    super(error);
    this.name = 'ResourceChallenge';
  }
}

const quote = (v: string) => `"${v.replace(/["\\]/g, '')}"`;

export class ResourceTokenVerifier {
  readonly replay = new ReplayCache();
  constructor(private readonly pool: DataPool, private readonly settings: OAuthSettings, private readonly staffRoles: StaffRoleResolver, private readonly clock: Clock) {}

  challenge(surface: OAuthSurface, error?: 'invalid_token' | 'invalid_request'): string {
    const parts = [`resource_metadata=${quote(protectedResourceMetadataUrl(this.settings, surface))}`, `scope=${quote(surface === 'admin' ? 'admin.read' : 'read.public read.me')}`];
    if (error) parts.unshift(`error=${quote(error)}`);
    return `Bearer ${parts.join(', ')}, DPoP algs=${quote(DPOP_ALGS.join(' '))}`;
  }

  /** 403 step-up challenge naming every scope an operation needs at once (MCP-003 answers it for calls outside the grant). */
  insufficientScope(surface: OAuthSurface, scopes: readonly string[]): ResourceChallenge {
    return new ResourceChallenge(403, `Bearer error="insufficient_scope", scope=${quote(scopes.join(' '))}, resource_metadata=${quote(protectedResourceMetadataUrl(this.settings, surface))}`, 'insufficient_scope');
  }

  /** Staff roles of the person now, read in their own principal transaction (row-level security shows only their own). */
  private async currentStaffRoles(personId: string): Promise<readonly string[]> {
    const { rows } = await this.pool.query<{ authz_epoch: number }>('SELECT authz_epoch FROM trustwork.auth_person_epoch($1::uuid)', [personId]);
    const epoch = rows[0]?.authz_epoch;
    if (epoch === undefined) return [];
    return withPrincipal(this.pool, { personId, authzEpoch: epoch }, (trx) => this.staffRoles(personId, trx));
  }

  async verify(request: { headers: Record<string, string | string[] | undefined>; method: string; url: string; query?: unknown }, surface: OAuthSurface): Promise<VerifiedConnection> {
    const audience = this.settings.resources[surface];
    if (!this.settings.policy.endpoints[surface]) throw new ResourceChallenge(401, this.challenge(surface), 'unavailable');
    const query = request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {};
    if ('access_token' in query || /[?&]access_token=/.test(request.url)) throw new ResourceChallenge(400, this.challenge(surface, 'invalid_request'), 'token_in_query');
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header) throw new ResourceChallenge(401, this.challenge(surface), 'missing_token');
    const match = /^(Bearer|DPoP) ([A-Za-z0-9_-]{20,80})$/i.exec(header.trim());
    if (!match) throw new ResourceChallenge(401, this.challenge(surface, 'invalid_token'), 'malformed');
    const scheme = match[1]!.toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer';
    const token = match[2]!;
    if (credentialKindOf(token) !== 'access') throw new ResourceChallenge(401, this.challenge(surface, 'invalid_token'), 'not_access_token');
    const found = await oauthTokens.introspect(this.pool, hashCredential(token), audience);
    if (!found || found.surface !== surface) throw new ResourceChallenge(401, this.challenge(surface, 'invalid_token'), 'invalid_token');
    if (found.dpopJkt) {
      const proof = request.headers.dpop;
      if (scheme !== 'DPoP' || typeof proof !== 'string') throw new ResourceChallenge(401, this.challenge(surface, 'invalid_token'), 'dpop_required');
      let jkt: string;
      try {
        jkt = verifyDpopProof(proof, { method: request.method, url: `${this.settings.issuer}${request.url}`, now: this.clock.now(), replay: this.replay, accessToken: token });
      } catch (error) {
        if (error instanceof JoseError) throw new ResourceChallenge(401, this.challenge(surface, 'invalid_token'), 'dpop_invalid');
        throw error;
      }
      if (jkt !== found.dpopJkt) throw new ResourceChallenge(401, this.challenge(surface, 'invalid_token'), 'dpop_key_mismatch');
    } else if (scheme === 'DPoP') {
      throw new ResourceChallenge(401, this.challenge(surface, 'invalid_token'), 'not_dpop_bound');
    }
    if (surface === 'admin' && !(await this.currentStaffRoles(found.personId)).length) throw new ResourceChallenge(401, this.challenge(surface, 'invalid_token'), 'staff_role_ended');
    return { ...found, audience, tokenType: scheme };
  }
}

export type McpRequest = FastifyRequest & { mcpConnection?: VerifiedConnection };

/** Fastify `onRequest`/`preHandler` body for an MCP surface route: attaches `request.mcpConnection` or answers the challenge. */
export function mcpResourceHook(verifier: ResourceTokenVerifier, surface: OAuthSurface) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    try {
      (request as McpRequest).mcpConnection = await verifier.verify({ headers: request.headers, method: request.method, url: request.url, query: request.query }, surface);
    } catch (error) {
      if (!(error instanceof ResourceChallenge)) throw error;
      return reply.code(error.status).header('WWW-Authenticate', error.wwwAuthenticate).header('Cache-Control', 'no-store').type('application/json; charset=utf-8')
        .send({ error: error.status === 400 ? 'invalid_request' : error.status === 403 ? 'insufficient_scope' : 'invalid_token', resource: MCP_ENDPOINT_PATHS[surface] });
    }
  };
}
