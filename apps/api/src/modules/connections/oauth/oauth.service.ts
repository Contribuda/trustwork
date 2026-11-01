import { z } from 'zod';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import {
  cacheSeconds, ClientDocumentError, documentDigest, isLoopbackRedirect, isMetadataClientId, parseClientMetadataDocument, parseRegistrationRequest, redirectUriMatches,
} from './client-metadata.js';
import { OAUTH_PATHS, protectedResourceMetadataUrl, surfaceOf, type OAuthSettings, type OAuthSurface } from './config.js';
import { CHALLENGE, hashCredential, newCredential, ReplayCache, s256, signRequest, verifyRequest, VERIFIER, type AuthorizationRequest } from './crypto.js';
import {
  ConnectionScopeSchema, connectionGrants, DEFAULT_CONNECTION_SCOPES, DEFAULT_TOOLSETS, MCP_STAFF_SCOPES, MCP_TOOLSETS, McpToolsetSchema, oauthClients, oauthTokens,
  PrivateDataClassSchema, type OAuthClientRecord, type TokenIssue,
} from './deps.js';
import { EgressRefused, type FetchedDocument } from './egress.js';
import { ASSERTION_ALGS, CLIENT_ASSERTION_TYPE, DPOP_ALGS, JoseError, verifyClientAssertion, verifyDpopProof } from './jose.js';

/** Fetches a Client ID Metadata Document through the egress guard (`GuardedFetcher`). */
export interface ClientMetadataFetcher { fetchJson(url: string): Promise<FetchedDocument> }

/** An OAuth protocol answer: a redirect to the client or the consent page, or a JSON body with a status. */
export type OAuthResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'json'; status: number; body: Record<string, unknown>; headers?: Record<string, string> };

class OAuthFailure extends Error {
  constructor(readonly error: string, readonly description: string, readonly status = 400) {
    super(description);
  }
}

const PARTICIPANT_SCOPES = ConnectionScopeSchema.options as readonly string[];
const STAFF_SCOPES = MCP_STAFF_SCOPES as readonly string[];
const DEFAULT_STAFF_SCOPES = ['admin.read'];

/** First-party decision on the consent page (MCP-070 renders the page; this is its contract with the API). */
export const ConsentDecisionSchema = z.strictObject({
  request: z.string().min(10).max(8_000),
  decision: z.enum(['allow', 'deny']),
  scopes: z.array(z.string()).max(10).optional(),
  toolsets: z.array(McpToolsetSchema).max(MCP_TOOLSETS.length).optional(),
  privateDataClasses: z.array(PrivateDataClassSchema).max(10).optional(),
  mandateBindings: z.array(z.strictObject({ mandateId: z.uuid(), revision: z.int().min(1) })).max(50).optional(),
  consentTextVersion: z.int().min(1),
  locale: z.string().min(2).max(35).optional(),
});
export type ConsentDecision = z.infer<typeof ConsentDecisionSchema>;

const single = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null; // repeated parameters arrive as arrays: refused (RFC 6749 section 3.1)
  return value;
};

/** Hints raised by the connections commands, mapped to contract error codes for the first-party endpoints. */
function firstPartyError(error: unknown): never {
  const hint = (error as { hint?: string })?.hint;
  switch (hint) {
    case 'connections.mandate_binding_invalid': throw new ApiError('access.mandate_scope', 'a mandate binding does not name an active mandate of yours', { hint });
    case 'connections.person_blocked': throw new ApiError('access.forbidden', 'this account cannot connect clients now', { hint });
    case 'connections.elevation_required': throw new ApiError('access.forbidden', 'an elevated session is required', { required: 'elevation' });
    case 'connections.step_up_required': throw new ApiError('auth.step_up_required');
    case 'connections.client_invalid': case 'connections.resource_mismatch': throw new ApiError('validation.schema', 'the request no longer matches the client registration', { hint });
    case 'access.not_found': throw new ApiError('access.not_found');
    default: throw error;
  }
}

/**
 * The hub authorization server (MCP-002): RFC 8414 and RFC 9728 metadata, client resolution (metadata documents through
 * the egress guard, pre-registration, deprecated dynamic registration behind the hub switch), the authorization
 * endpoint with first-party sign-in, step-up and consent, the token endpoint (PKCE S256, exact resource indicators,
 * 15-minute opaque audience-bound access tokens, rotating refresh tokens with reuse detection, DPoP when presented),
 * RFC 7009 revocation and the person's connection list and revocation.
 */
export class OAuthService {
  readonly replay = new ReplayCache();
  private readonly registrations = new Map<string, number[]>();

  constructor(private readonly ctx: AppContext, private readonly identity: IdentityServices, readonly settings: OAuthSettings, readonly fetcher: ClientMetadataFetcher | null) {}

  private get now(): Date {
    return this.ctx.clock.now();
  }
  private url(path: string): string {
    return `${this.settings.issuer}${path}`;
  }

  /* ---------- Metadata ---------- */

  authorizationServerMetadata(): Record<string, unknown> {
    const s = this.settings;
    return {
      issuer: s.issuer,
      authorization_endpoint: this.url(OAUTH_PATHS.authorize),
      token_endpoint: this.url(OAUTH_PATHS.token),
      revocation_endpoint: this.url(OAUTH_PATHS.revoke),
      ...(s.policy.dynamicRegistration ? { registration_endpoint: this.url(OAUTH_PATHS.register) } : {}),
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: [...ASSERTION_ALGS],
      revocation_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      scopes_supported: [...PARTICIPANT_SCOPES, ...(s.policy.endpoints.admin ? STAFF_SCOPES : [])],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: s.metadataFetch !== 'disabled',
      dpop_signing_alg_values_supported: [...DPOP_ALGS],
      ui_locales_supported: ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn'],
    };
  }

  protectedResourceMetadata(surface: OAuthSurface): Record<string, unknown> | null {
    const s = this.settings;
    if (!s.policy.endpoints[surface]) return null;
    return {
      resource: s.resources[surface],
      authorization_servers: [s.issuer],
      scopes_supported: surface === 'admin' ? DEFAULT_STAFF_SCOPES : [...DEFAULT_CONNECTION_SCOPES],
      bearer_methods_supported: ['header'],
      dpop_signing_alg_values_supported: [...DPOP_ALGS],
      resource_documentation: `${s.issuer}/guides/connect-your-ai-chat`,
    };
  }

  /* ---------- Clients ---------- */

  listedName(clientId: string): string | null {
    return this.settings.policy.listedClients.find((c) => c.clientId === clientId)?.displayName ?? null;
  }

  /** Resolves a client id: a cached or freshly fetched metadata document, or a stored registration. */
  async resolveClient(clientId: string, allowFetch = true): Promise<OAuthClientRecord> {
    if (clientId.length > 500) throw new OAuthFailure('invalid_client', 'unknown client', 401);
    if (this.settings.policy.clientTrust === 'listed_clients_only' && !this.listedName(clientId)) throw new OAuthFailure('invalid_client', 'this hub accepts listed clients only', 401);
    const stored = await oauthClients.get(this.ctx.pool, clientId);
    if (stored?.disabled) throw new OAuthFailure('invalid_client', 'the client is disabled on this hub', 401);
    if (clientId.startsWith('https://')) {
      if (!isMetadataClientId(clientId) || this.settings.metadataFetch === 'disabled' || !this.fetcher) throw new OAuthFailure('invalid_client', 'client metadata documents are not accepted', 401);
      if (stored && stored.metadataExpiresAt && stored.metadataExpiresAt.getTime() > Date.now()) return stored; // cache by wall time, like the database
      if (!allowFetch) {
        if (stored) return stored;
        throw new OAuthFailure('invalid_client', 'unknown client', 401);
      }
      let fetched: FetchedDocument;
      try {
        fetched = await this.fetcher.fetchJson(clientId);
      } catch (error) {
        if (error instanceof EgressRefused) {
          this.ctx.log(`oauth.client_metadata_refused reason=${error.reason}`);
          throw new OAuthFailure('invalid_client', 'the client metadata document could not be retrieved', 401);
        }
        throw error;
      }
      let description;
      try {
        description = parseClientMetadataDocument(clientId, fetched.document);
      } catch (error) {
        if (error instanceof ClientDocumentError) throw new OAuthFailure('invalid_client', error.description, 401);
        throw error;
      }
      const expiresAt = new Date(Date.now() + cacheSeconds(fetched.headers['cache-control']) * 1000);
      await oauthClients.storeMetadata(this.ctx.pool, { clientId, ...description, digest: documentDigest(fetched.body), expiresAt });
      const fresh = await oauthClients.get(this.ctx.pool, clientId);
      if (!fresh) throw new OAuthFailure('invalid_client', 'unknown client', 401);
      return fresh;
    }
    if (!stored) throw new OAuthFailure('invalid_client', 'unknown client', 401);
    return stored;
  }

  /* ---------- Authorization endpoint ---------- */

  private clientRedirect(redirectUri: string, params: Record<string, string | null>): string {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
    url.searchParams.set('iss', this.settings.issuer);
    return url.toString();
  }

  async authorize(query: Record<string, unknown>, state: RequestState): Promise<OAuthResult> {
    const clientId = single(query.client_id);
    const redirectUri = single(query.redirect_uri);
    if (!clientId || !redirectUri) return { kind: 'json', status: 400, body: { error: 'invalid_request', error_description: 'client_id and redirect_uri are required exactly once' } };
    let client: OAuthClientRecord;
    try {
      client = await this.resolveClient(clientId);
    } catch (error) {
      if (error instanceof OAuthFailure) return { kind: 'json', status: 400, body: { error: error.error, error_description: error.description } };
      throw error;
    }
    const registered = client.redirectUris.find((r) => redirectUriMatches(r, redirectUri));
    if (!registered) return { kind: 'json', status: 400, body: { error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' } };
    const st = single(query.state);
    const fail = (error: string, description: string): OAuthResult => ({
      kind: 'redirect', location: this.clientRedirect(redirectUri, { error, error_description: description, state: typeof st === 'string' ? st : null }),
    });
    if (st === null || (st !== undefined && st.length > 1000)) return fail('invalid_request', 'state must appear once and be at most 1000 characters');
    if (single(query.response_type) !== 'code') return fail('unsupported_response_type', 'only the code response type is supported');
    const challenge = single(query.code_challenge);
    if (single(query.code_challenge_method) !== 'S256' || !challenge || !CHALLENGE.test(challenge)) return fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
    const resource = single(query.resource);
    if (!resource) return fail('invalid_target', 'exactly one resource indicator is required');
    const surface = surfaceOf(this.settings, resource);
    if (!surface || !this.settings.policy.endpoints[surface]) return fail('invalid_target', 'the resource is not a protected resource of this hub');
    const scopeRaw = single(query.scope);
    if (scopeRaw === null) return fail('invalid_scope', 'scope must appear once');
    const scopes = scopeRaw ? [...new Set(scopeRaw.split(' ').filter(Boolean))] : surface === 'admin' ? DEFAULT_STAFF_SCOPES : [...DEFAULT_CONNECTION_SCOPES];
    const vocabulary = surface === 'admin' ? STAFF_SCOPES : PARTICIPANT_SCOPES;
    if (!scopes.length || scopes.some((s) => !vocabulary.includes(s))) return fail('invalid_scope', 'a requested scope does not exist on this resource');
    const dpopJkt = single(query.dpop_jkt);
    if (dpopJkt === null || (dpopJkt !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(dpopJkt))) return fail('invalid_request', 'dpop_jkt is malformed');
    const prompt = single(query.prompt);
    if (prompt === null || (prompt !== undefined && !['none', 'consent', 'login'].includes(prompt))) return fail('invalid_request', 'unsupported prompt value');
    const request: AuthorizationRequest = {
      v: 1, clientId, redirectUri, registeredRedirectUri: registered, state: st ?? null, codeChallenge: challenge, resource, surface, scopes, dpopJkt: dpopJkt ?? null,
      exp: Math.floor(this.now.getTime() / 1000) + this.settings.requestTtlSeconds,
    };
    // A consent still in force for exactly this client, redirect URI and scopes needs no new consent (participants only;
    // staff consent always needs a live elevation). `prompt=consent` and `prompt=login` always show the page.
    if (state.principal && state.session && surface === 'participant' && prompt !== 'consent' && prompt !== 'login') {
      const location = await this.identity.principals.runAs(state, async (trx) => {
        const current = await connectionGrants.current(trx, { clientId, redirectUri: registered, surface });
        if (!current || current.connection.status !== 'active' || current.connection.resource !== resource) return null;
        const k = current.consent;
        if (k.withdrawn_at || k.expires_at.getTime() <= this.now.getTime() || k.consent_text_version !== this.settings.consentTextVersion) return null;
        if (!scopes.every((s) => k.scopes.includes(s))) return null;
        const code = newCredential('code');
        await connectionGrants.issueCode(trx, {
          connectionId: current.connection.id, codeHash: hashCredential(code), redirectUri, codeChallenge: challenge, resource, scopes: k.scopes, dpopJkt: request.dpopJkt,
          ttlSeconds: this.settings.codeTtlSeconds,
        });
        return this.clientRedirect(redirectUri, { code, state: request.state });
      });
      if (location) return { kind: 'redirect', location };
    }
    if (prompt === 'none') return fail(state.principal ? 'consent_required' : 'login_required', 'interaction with the person is required');
    const consentPath = `${OAUTH_PATHS.consentPage}?request=${encodeURIComponent(signRequest(this.ctx.config.flowSecret, request))}`;
    const location = state.principal && prompt !== 'login' ? this.url(consentPath) : this.url(`${OAUTH_PATHS.login}?next=${encodeURIComponent(consentPath)}`);
    return { kind: 'redirect', location };
  }

  private request(handle: string): AuthorizationRequest {
    const request = verifyRequest(this.ctx.config.flowSecret, handle, this.now);
    if (!request) throw new ApiError('access.not_found', 'the authorization request is invalid or expired');
    return request;
  }

  /** What the consent page shows: the client (self-asserted unless listed), the redirect host, scopes, toolsets, data classes and expiry. */
  async consentView(handle: string, state: RequestState): Promise<Record<string, unknown>> {
    const request = this.request(handle);
    let client: OAuthClientRecord;
    try {
      client = await this.resolveClient(request.clientId, false);
    } catch {
      throw new ApiError('access.not_found', 'the client is no longer available');
    }
    const listed = this.listedName(client.clientId);
    const existing = await this.identity.principals.runAs(state, (trx) => connectionGrants.current(trx, { clientId: request.clientId, redirectUri: request.registeredRedirectUri, surface: request.surface }));
    const consentExpiresAt = new Date(this.now.getTime() + this.settings.consentLifetimeDays * 86_400_000);
    return {
      client: {
        clientId: client.clientId, name: listed ?? client.clientName, listedByHub: listed !== null, nameSelfAsserted: listed === null, registration: client.registration,
        clientIdHost: client.clientId.startsWith('https://') ? new URL(client.clientId).host : null, clientUri: client.clientUri,
      },
      redirectUri: request.redirectUri,
      redirectHost: new URL(request.redirectUri).host,
      loopbackRedirectOnly: client.redirectUris.every(isLoopbackRedirect),
      surface: request.surface,
      resource: request.resource,
      requestedScopes: request.scopes,
      defaultScopes: request.scopes.filter((s) => (DEFAULT_CONNECTION_SCOPES as readonly string[]).includes(s) || s === 'admin.read'),
      toolsets: request.surface === 'participant' ? { available: [...MCP_TOOLSETS], preselected: [...DEFAULT_TOOLSETS] } : null,
      privateDataClasses: request.surface === 'participant' && request.scopes.includes('read.private') ? PrivateDataClassSchema.options : [],
      mandateBindingsRequired: request.scopes.includes('act'),
      requiresElevation: request.surface === 'admin',
      consentTextVersion: this.settings.consentTextVersion,
      consentExpiresAt: consentExpiresAt.toISOString(),
      rateLimits: { readPerMinute: this.settings.policy.ratePerMinute.read, draftPerMinute: this.settings.policy.ratePerMinute.draft, commitsPerHour: this.settings.policy.commitsPerHour },
      existing: existing && existing.connection.status !== 'revoked' ? {
        connectionId: existing.connection.id, status: existing.connection.status, scopes: existing.consent.scopes, toolsets: existing.consent.toolsets,
        privateDataClasses: existing.consent.private_data_classes, expiresAt: existing.consent.expires_at.toISOString(),
      } : null,
      requestExpiresAt: new Date(request.exp * 1000).toISOString(),
    };
  }

  /** The person's decision (session with fresh step-up; staff also an elevated session). Returns where the browser goes next. */
  async decide(body: ConsentDecision, state: RequestState): Promise<{ redirectTo: string }> {
    const request = this.request(body.request);
    if (body.decision === 'deny') return { redirectTo: this.clientRedirect(request.redirectUri, { error: 'access_denied', error_description: 'the person declined', state: request.state }) };
    if (body.consentTextVersion !== this.settings.consentTextVersion) throw new ApiError('validation.revision_conflict', 'the consent text changed; reload the page');
    let elevationId: string | null = null;
    if (request.surface === 'admin') elevationId = (await this.identity.secondFactors.requireElevation(state)).id;
    const scopes = body.scopes ? [...new Set(body.scopes)] : request.scopes;
    // Progressive consent: the person may grant fewer scopes than requested, never more.
    if (!scopes.length || scopes.some((s) => !request.scopes.includes(s))) throw new ApiError('validation.schema', 'scopes must be a non-empty subset of the requested scopes');
    const participant = request.surface === 'participant';
    const toolsets = participant ? [...new Set(body.toolsets ?? DEFAULT_TOOLSETS)] : [];
    const classes = participant ? [...new Set(body.privateDataClasses ?? [])] : [];
    const bindings = participant ? body.mandateBindings ?? [] : [];
    if (participant && !toolsets.length) throw new ApiError('validation.schema', 'tick at least one toolset');
    if (!participant && (body.toolsets?.length || body.privateDataClasses?.length || body.mandateBindings?.length)) throw new ApiError('validation.schema', 'staff connections have no toolsets, data classes or mandates');
    if (scopes.includes('read.private') !== classes.length > 0) throw new ApiError('validation.schema', 'read.private is opted in per data class');
    if (scopes.includes('act') !== bindings.length > 0) throw new ApiError('validation.schema', 'act needs at least one mandate binding, and bindings need act');
    if (new Set(bindings.map((b) => b.mandateId)).size !== bindings.length) throw new ApiError('validation.schema', 'one binding per mandate');
    const code = newCredential('code');
    try {
      await this.identity.principals.runAs(state, async (trx) => {
        const granted = await connectionGrants.grant(trx, {
          clientId: request.clientId, redirectUri: request.registeredRedirectUri, surface: request.surface, resource: request.resource, scopes, privateDataClasses: classes, toolsets,
          mandateBindings: bindings, consentTextVersion: body.consentTextVersion, stepUp: true, elevationId, locale: body.locale ?? 'en',
          expiresAt: new Date(this.now.getTime() + this.settings.consentLifetimeDays * 86_400_000), hubId: this.settings.hubId,
        });
        await connectionGrants.issueCode(trx, {
          connectionId: granted.connectionId, codeHash: hashCredential(code), redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, resource: request.resource,
          scopes, dpopJkt: request.dpopJkt, ttlSeconds: this.settings.codeTtlSeconds,
        });
      });
    } catch (error) {
      firstPartyError(error);
    }
    return { redirectTo: this.clientRedirect(request.redirectUri, { code, state: request.state }) };
  }

  /* ---------- Token endpoint ---------- */

  private async authenticateClient(form: Record<string, unknown>, endpoint: string): Promise<OAuthClientRecord> {
    const clientId = single(form.client_id);
    if (!clientId) throw new OAuthFailure('invalid_client', 'client_id is required', 401);
    if (form.client_secret !== undefined) throw new OAuthFailure('invalid_client', 'client secrets are not accepted', 401);
    const client = await this.resolveClient(clientId, false);
    const assertionType = single(form.client_assertion_type);
    const assertion = single(form.client_assertion);
    if (client.tokenEndpointAuthMethod === 'private_key_jwt') {
      if (assertionType !== CLIENT_ASSERTION_TYPE || !assertion || !client.jwks) throw new OAuthFailure('invalid_client', 'private_key_jwt client authentication is required', 401);
      try {
        verifyClientAssertion(assertion, { clientId, audiences: [this.settings.issuer, this.url(endpoint)], jwks: client.jwks, now: this.now, replay: this.replay });
      } catch (error) {
        if (error instanceof JoseError) throw new OAuthFailure('invalid_client', 'client authentication failed', 401);
        throw error;
      }
    } else if (assertionType !== undefined || assertion !== undefined) {
      throw new OAuthFailure('invalid_client', 'this client is a public client', 401);
    }
    return client;
  }

  private dpop(header: string | string[] | undefined, endpoint: string): string | null {
    if (header === undefined) return null;
    if (typeof header !== 'string') throw new OAuthFailure('invalid_dpop_proof', 'exactly one DPoP proof');
    try {
      return verifyDpopProof(header, { method: 'POST', url: this.url(endpoint), now: this.now, replay: this.replay });
    } catch (error) {
      if (error instanceof JoseError) throw new OAuthFailure('invalid_dpop_proof', error.message);
      throw error;
    }
  }

  private tokenResponse(issue: TokenIssue, access: string, refresh: string): OAuthResult {
    if (issue.outcome === 'invalid_dpop') throw new OAuthFailure('invalid_dpop_proof', 'the proof key does not match the grant');
    if (issue.outcome !== 'issued' || !issue.accessExpiresAt) {
      if (issue.outcome === 'reuse_detected') this.ctx.log('oauth.refresh_reuse_detected: family revoked, connection suspended');
      if (issue.outcome === 'code_replay') this.ctx.log('oauth.code_replay: tokens issued from the code revoked');
      throw new OAuthFailure('invalid_grant', 'the grant is invalid, expired, revoked or was already used');
    }
    return {
      kind: 'json', status: 200, headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
      body: {
        access_token: access, token_type: issue.dpopJkt ? 'DPoP' : 'Bearer', expires_in: Math.max(1, Math.round((issue.accessExpiresAt.getTime() - Date.now()) / 1000)),
        refresh_token: refresh, scope: (issue.scopes ?? []).join(' '),
      },
    };
  }

  async token(form: Record<string, unknown>, contentType: string | undefined, dpopHeader: string | string[] | undefined): Promise<OAuthResult> {
    return this.protocol(async () => {
      if (!/^application\/x-www-form-urlencoded\b/i.test(contentType ?? '')) throw new OAuthFailure('invalid_request', 'the token endpoint takes application/x-www-form-urlencoded');
      const client = await this.authenticateClient(form, OAUTH_PATHS.token);
      const jkt = this.dpop(dpopHeader, OAUTH_PATHS.token);
      const grant = single(form.grant_type);
      const access = newCredential('access');
      const refresh = newCredential('refresh');
      const lifetimes = { accessTtlSeconds: this.settings.policy.accessTokenTtlSeconds, refreshIdleSeconds: this.settings.refreshIdleSeconds };
      if (grant === 'authorization_code') {
        const code = single(form.code);
        const redirectUri = single(form.redirect_uri);
        const resource = single(form.resource);
        const verifier = single(form.code_verifier);
        if (!code || !redirectUri) throw new OAuthFailure('invalid_request', 'code and redirect_uri are required exactly once');
        if (!resource) throw new OAuthFailure('invalid_target', 'exactly one resource indicator is required');
        if (verifier === null) throw new OAuthFailure('invalid_request', 'code_verifier must appear once');
        const issue = await oauthTokens.redeemCode(this.ctx.pool, {
          codeHash: hashCredential(code), clientId: client.clientId, redirectUri, resource, challenge: verifier && VERIFIER.test(verifier) ? s256(verifier) : null, dpopJkt: jkt,
          accessHash: hashCredential(access), refreshHash: hashCredential(refresh), ...lifetimes, refreshAbsoluteSeconds: this.settings.policy.refreshAbsoluteDays * 86_400,
        });
        return this.tokenResponse(issue, access, refresh);
      }
      if (grant === 'refresh_token') {
        const presented = single(form.refresh_token);
        const resource = single(form.resource);
        if (!presented) throw new OAuthFailure('invalid_request', 'refresh_token is required exactly once');
        if (resource === null) throw new OAuthFailure('invalid_target', 'at most one resource indicator');
        const issue = await oauthTokens.rotateRefresh(this.ctx.pool, {
          refreshHash: hashCredential(presented), clientId: client.clientId, resource: resource ?? null, dpopJkt: jkt, accessHash: hashCredential(access), newRefreshHash: hashCredential(refresh), ...lifetimes,
        });
        return this.tokenResponse(issue, access, refresh);
      }
      throw new OAuthFailure('unsupported_grant_type', 'authorization_code and refresh_token only');
    });
  }

  /** RFC 7009: answers 200 whether or not the token existed, once the client is authenticated. */
  async revoke(form: Record<string, unknown>, contentType: string | undefined): Promise<OAuthResult> {
    return this.protocol(async () => {
      if (!/^application\/x-www-form-urlencoded\b/i.test(contentType ?? '')) throw new OAuthFailure('invalid_request', 'the revocation endpoint takes application/x-www-form-urlencoded');
      const client = await this.authenticateClient(form, OAUTH_PATHS.revoke);
      const token = single(form.token);
      if (!token) throw new OAuthFailure('invalid_request', 'token is required exactly once');
      await oauthTokens.revoke(this.ctx.pool, hashCredential(token), client.clientId);
      return { kind: 'json', status: 200, body: {}, headers: { 'cache-control': 'no-store' } };
    });
  }

  /** Deprecated RFC 7591 dynamic registration behind the hub switch; rate-limited per client address. */
  async register(body: unknown, address: string): Promise<OAuthResult> {
    if (!this.settings.policy.dynamicRegistration) return { kind: 'json', status: 404, body: { error: 'not_found', error_description: 'dynamic registration is off on this hub' } };
    const nowMs = Date.now();
    const recent = (this.registrations.get(address) ?? []).filter((t) => t > nowMs - 3_600_000);
    if (recent.length >= this.settings.registrationsPerHour) return { kind: 'json', status: 429, body: { error: 'too_many_requests', error_description: 'registration limit reached; try later' } };
    let description;
    try {
      description = parseRegistrationRequest(body);
    } catch (error) {
      if (error instanceof ClientDocumentError) return { kind: 'json', status: 400, body: { error: error.description.includes('redirect') ? 'invalid_redirect_uri' : 'invalid_client_metadata', error_description: error.description } };
      throw error;
    }
    recent.push(nowMs);
    this.registrations.set(address, recent);
    if (this.registrations.size > 10_000) for (const [k, v] of this.registrations) if (!v.some((t) => t > nowMs - 3_600_000)) this.registrations.delete(k);
    const clientId = newCredential('client');
    await oauthClients.registerDynamic(this.ctx.pool, { clientId, ...description });
    return {
      kind: 'json', status: 201, headers: { 'cache-control': 'no-store' },
      body: {
        client_id: clientId, client_id_issued_at: Math.floor(nowMs / 1000), client_name: description.clientName, ...(description.clientUri ? { client_uri: description.clientUri } : {}),
        redirect_uris: description.redirectUris, application_type: description.applicationType, token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      },
    };
  }

  private async protocol(fn: () => Promise<OAuthResult>): Promise<OAuthResult> {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof OAuthFailure)) throw error;
      const headers: Record<string, string> = { 'cache-control': 'no-store', pragma: 'no-cache' };
      if (error.status === 401) headers['www-authenticate'] = 'Basic realm="trustwork"';
      return { kind: 'json', status: error.status, body: { error: error.error, error_description: error.description }, headers };
    }
  }

  /* ---------- The person's connections ---------- */

  /** Own consent history only; tokens, client credentials, elevations and internal call records stay outside this port. */
  async privacyExport(state: RequestState) {
    const current = await this.listConnections(state);
    const consents = await this.identity.principals.runAs(state, async (trx, p) => {
      const rows = await trx.selectFrom('connection_consent').selectAll().where('person_id', '=', p.personId).orderBy('granted_at').orderBy('id').execute();
      return rows.map((k) => ({ id: k.id, clientId: k.client_id, surface: k.surface, redirectHost: new URL(k.redirect_uri).host,
        scopes: k.scopes, toolsets: k.toolsets, privateDataClasses: k.private_data_classes, consentTextVersion: k.consent_text_version,
        grantedAt: k.granted_at.toISOString(), expiresAt: k.expires_at.toISOString(), withdrawnAt: k.withdrawn_at?.toISOString() ?? null,
        withdrawnReason: k.withdrawn_reason, locale: k.locale }));
    });
    return { ...current, consents };
  }

  async listConnections(state: RequestState): Promise<{ connections: Record<string, unknown>[] }> {
    const rows = await this.identity.principals.runAs(state, (trx) => connectionGrants.list(trx));
    return {
      connections: rows.map(({ connection: c, consent: k, client }) => {
        const listed = this.listedName(c.client_id);
        return {
          id: c.id, surface: c.surface, status: c.status, statusReason: c.status_reason, clientName: listed ?? client.clientName, listedByHub: listed !== null,
          registration: client.registration, redirectHost: new URL(c.redirect_uri).host, resource: c.resource, scopes: k.scopes, toolsets: k.toolsets,
          privateDataClasses: k.private_data_classes, mandateBindings: k.mandate_bindings, consentExpiresAt: k.expires_at.toISOString(),
          createdAt: c.created_at.toISOString(), lastUsedAt: c.last_used_at?.toISOString() ?? null, revokedAt: c.revoked_at?.toISOString() ?? null,
        };
      }),
    };
  }

  async revokeConnection(id: string, state: RequestState): Promise<{ revoked: boolean }> {
    try {
      return { revoked: await this.identity.principals.runAs(state, (trx) => connectionGrants.revoke(trx, id)) };
    } catch (error) {
      firstPartyError(error);
    }
  }

  async revokeAllConnections(state: RequestState): Promise<{ revoked: number }> {
    return { revoked: await this.identity.principals.runAs(state, (trx) => connectionGrants.revokeAll(trx)) };
  }

  metadataUrl(surface: OAuthSurface): string {
    return protectedResourceMetadataUrl(this.settings, surface);
  }
}
