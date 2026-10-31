import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Client, Harness, Response } from '../../backend/helpers/app.js';
import { mcpResourceHook, ResourceTokenVerifier, type McpRequest } from '../../../apps/api/src/modules/connections/oauth/resource.js';

export const ORIGIN = 'https://trustwork.test';
export const MCP = `${ORIGIN}/mcp`;
export const MCP_ADMIN = `${ORIGIN}/mcp/admin`;
export const REDIRECT = 'https://chat.example.test/oauth/callback';

export interface Raw { status: number; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }
async function raw(h: Harness, method: 'GET' | 'POST', url: string, payload?: string, headers: Record<string, string> = {}): Promise<Raw> {
  const response = await h.created.fastify.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
  let body: Record<string, unknown> = {};
  try {
    body = response.body ? JSON.parse(response.body) as Record<string, unknown> : {};
  } catch {
    body = { raw: response.body };
  }
  return { status: response.statusCode, body, headers: response.headers as Raw['headers'] };
}

export const get = (h: Harness, url: string) => raw(h, 'GET', url);
/** A form POST from an OAuth client: no cookie, no CSRF header (the token endpoint never reads a session). */
export const form = (h: Harness, url: string, values: Record<string, string>, headers: Record<string, string> = {}) =>
  raw(h, 'POST', url, new URLSearchParams(values).toString(), { 'content-type': 'application/x-www-form-urlencoded', ...headers });

export async function registerClient(h: Harness, redirectUris: string[] = [REDIRECT], applicationType: 'web' | 'native' = 'web'): Promise<string> {
  const response = await raw(h, 'POST', '/v1/oauth/register', JSON.stringify({ client_name: 'Synthetic chat client', redirect_uris: redirectUris, application_type: applicationType }), { 'content-type': 'application/json' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.client_id as string;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface AuthorizeParams { clientId: string; redirectUri?: string; challenge: string; resource?: string; scope?: string; state?: string; prompt?: string; extra?: Record<string, string> }
export function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri ?? REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', resource: p.resource ?? MCP,
    state: p.state ?? 'synthetic-state', ...(p.scope ? { scope: p.scope } : {}), ...(p.prompt ? { prompt: p.prompt } : {}), ...(p.extra ?? {}),
  });
  return `/v1/oauth/authorize?${q.toString()}`;
}

export const locationOf = (r: Response | Raw): URL => {
  assert.equal(r.status, 302, `expected a redirect, got ${r.status} ${JSON.stringify(r.body)}`);
  return new URL(r.headers.location as string, ORIGIN);
};
export function requestHandle(location: URL): string {
  const direct = location.searchParams.get('request');
  if (direct) return direct;
  const next = location.searchParams.get('next');
  assert.ok(next, `no consent request in ${location}`);
  return new URL(next, ORIGIN).searchParams.get('request') as string;
}

export interface Allow { scopes?: string[]; toolsets?: string[]; privateDataClasses?: string[]; mandateBindings?: { mandateId: string; revision: number }[] }
/** The signed-in person consents on the first-party page; returns the redirect back to the client. */
export async function consent(client: Client, location: URL, allow: Allow = {}): Promise<URL> {
  const handle = requestHandle(location);
  const view = await client.get(`/v1/oauth/requests?request=${encodeURIComponent(handle)}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const decided = await client.post('/v1/oauth/requests/decision', { request: handle, decision: 'allow', consentTextVersion: 1, ...allow }, { idempotencyKey: null });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  return new URL((decided.body as { redirectTo: string }).redirectTo);
}

/** Full authorization for a signed-in client: authorize, consent if asked, and return the code. */
export async function authorizeCode(client: Client, p: AuthorizeParams, allow: Allow = {}): Promise<string> {
  const first = locationOf(await client.get(authorizeUrl(p)));
  const back = first.searchParams.has('code') || first.searchParams.has('error') ? first : await consent(client, first, allow);
  assert.equal(back.searchParams.get('iss'), ORIGIN, 'iss on every authorization response');
  const code = back.searchParams.get('code');
  assert.ok(code, `no code: ${back}`);
  return code;
}

export interface Tokens { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string }
export async function exchange(h: Harness, clientId: string, code: string, verifier: string, extra: Record<string, string> = {}): Promise<Raw> {
  return form(h, '/v1/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: MCP, ...extra });
}
export async function tokensFor(h: Harness, client: Client, clientId: string, p: Partial<AuthorizeParams> = {}, allow: Allow = {}): Promise<Tokens> {
  const { verifier, challenge } = pkce();
  const code = await authorizeCode(client, { clientId, challenge, ...p }, allow);
  const response = await exchange(h, clientId, code, verifier, { ...(p.redirectUri ? { redirect_uri: p.redirectUri } : {}), ...(p.resource ? { resource: p.resource } : {}) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as unknown as Tokens;
}
export const refresh = (h: Harness, clientId: string, refreshToken: string, extra: Record<string, string> = {}) =>
  form(h, '/v1/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, ...extra });

/** A stand-in MCP transport (MCP-003 owns the real one) that mounts the resource hook on both surfaces. */
export async function resourceServer(h: Harness): Promise<FastifyInstance> {
  const verifier = h.created.app.get(ResourceTokenVerifier);
  const server = Fastify();
  const handler = async (request: McpRequest) => ({ personId: request.mcpConnection?.personId, scopes: request.mcpConnection?.scopes, surface: request.mcpConnection?.surface });
  server.post('/mcp', { onRequest: mcpResourceHook(verifier, 'participant') }, handler);
  server.post('/mcp/admin', { onRequest: mcpResourceHook(verifier, 'admin') }, handler);
  await server.ready();
  return server;
}
export async function call(server: FastifyInstance, path: '/mcp' | '/mcp/admin', headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; challenge: string | undefined }> {
  const response = await server.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', ...headers }, payload: '{}' });
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') as Record<string, unknown>, challenge: response.headers['www-authenticate'] as string | undefined };
}
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
