import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { createHash } from 'node:crypto';
import { connectionGrants } from '../../../packages/data/src/repositories/connections.js';
import { expectError, SKIP_REASON, startHarness, type Client } from '../../backend/helpers/app.js';
import { login, PASSWORDS, seedPersonas } from '../../backend/helpers/personas.js';
import { elevate, enrol } from '../../backend/second-factor/helpers.js';
import { lockWaiters, until } from '../../backend/idempotency/helpers.js';
import { draft, ok, workerLogin } from '../../assistant/helpers.js';
import { baselineIds } from '../../screening-lists/helpers.js';
import { activateList, CONS_ENTRIES, screen, SDN_ENTRIES } from '../../screening/helpers.js';
import { FakeEgress } from '../../../apps/api/src/modules/connections/oauth/oauth.module.js';
import {
  authorizeCode, authorizeUrl, bearer, call, consent, exchange, form, get, locationOf, MCP, MCP_ADMIN, ORIGIN, pkce, REDIRECT, refresh, registerClient, requestHandle,
  resourceServer, tokensFor, type Raw, type Tokens,
} from './helpers.js';

/**
 * MCP-002 through the API on a real PostgreSQL (Fastify inject): metadata, client registration (dynamic and Client ID
 * Metadata Documents through the egress guard), the authorization endpoint with first-party sign-in, step-up and
 * consent, the token endpoint (PKCE S256, exact resource indicators, audience-bound opaque tokens, rotation with reuse
 * detection, DPoP), revocation, and every negative path the acceptance names. Every person and client is synthetic.
 */
process.env.MCP_ADMIN_ENDPOINT = 'true';
process.env.MCP_REGISTRATIONS_PER_HOUR = '200';
const h = await startHarness('connections_oauth');

test('the MCP authorization server', { skip: h ? false : SKIP_REASON, timeout: 300_000 }, async (t) => {
  if (!h) return;
  const server = await resourceServer(h);
  t.after(async () => {
    await server.close();
    await h.close();
  });
  const seed = await seedPersonas(h);
  const people = seed.people;
  const signedIn = async (key: 'petr' | 'anna' | 'boris' | 'carl' | 'xenia'): Promise<Client> => {
    const client = h.client();
    await login(client, key);
    return client;
  };
  const connectionStatus = async (id: string) => (await h.db.admin.query<{ status: string; status_reason: string | null }>('SELECT status, status_reason FROM trustwork.connection WHERE id = $1', [id])).rows[0];
  const connectionOf = async (personId: string, clientId: string) =>
    (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.connection WHERE person_id = $1 AND client_id = $2 ORDER BY created_at DESC LIMIT 1', [personId, clientId])).rows[0]?.id as string;

  await t.test('metadata: one authorization server, S256 only, iss supported, metadata documents and the none method, per-surface resources', async () => {
    const as = await get(h, '/.well-known/oauth-authorization-server');
    assert.equal(as.status, 200);
    assert.equal(as.body.issuer, ORIGIN);
    assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
    assert.equal(as.body.authorization_response_iss_parameter_supported, true);
    assert.equal(as.body.client_id_metadata_document_supported, true);
    assert.ok((as.body.token_endpoint_auth_methods_supported as string[]).includes('none'));
    assert.equal(as.body.revocation_endpoint, `${ORIGIN}/v1/oauth/revoke`);
    assert.equal(as.body.registration_endpoint, `${ORIGIN}/v1/oauth/register`);
    const prm = await get(h, '/.well-known/oauth-protected-resource/mcp');
    assert.equal(prm.body.resource, MCP);
    assert.deepEqual(prm.body.authorization_servers, [ORIGIN]);
    assert.deepEqual(prm.body.scopes_supported, ['read.public', 'read.me']);
    assert.deepEqual(prm.body.bearer_methods_supported, ['header']);
    assert.equal((await get(h, '/.well-known/oauth-protected-resource/mcp/admin')).body.resource, MCP_ADMIN);
  });

  const clientId = await registerClient(h, [REDIRECT, 'https://chat.example.test/oauth/second']);

  await t.test('authorization request errors: no redirect for an unknown client or redirect URI; iss and state on every other error', async () => {
    const { challenge } = pkce();
    const unknown = await get(h, authorizeUrl({ clientId: 'twdc_doesnotexist0000000000000000000000000000000', challenge }));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, 'invalid_client');
    const foreign = await get(h, authorizeUrl({ clientId, challenge, redirectUri: 'https://attacker.example.test/cb' }));
    assert.equal(foreign.status, 400);
    assert.equal(foreign.headers.location, undefined, 'never redirected to an unregistered URI');
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ resource: `${ORIGIN}/mcp/public` }, 'invalid_target'],
      [{ resource: 'https://other.example.test/mcp' }, 'invalid_target'],
      [{ resource: `${MCP}/` }, 'invalid_target'],
      [{ scope: 'read.me admin.read' }, 'invalid_scope'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ];
    for (const [extra, error] of cases) {
      const url = new URL(authorizeUrl({ clientId, challenge }), ORIGIN);
      for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
      const r = await get(h, `${url.pathname}${url.search}`);
      const location = locationOf(r);
      assert.equal(location.origin + location.pathname, REDIRECT);
      assert.equal(location.searchParams.get('error'), error, JSON.stringify(extra));
      assert.equal(location.searchParams.get('iss'), ORIGIN);
      assert.equal(location.searchParams.get('state'), 'synthetic-state');
    }
    const missing = new URL(authorizeUrl({ clientId, challenge }), ORIGIN);
    missing.searchParams.delete('resource');
    assert.equal(locationOf(await get(h, `${missing.pathname}${missing.search}`)).searchParams.get('error'), 'invalid_target');
    const anonymous = await get(h, authorizeUrl({ clientId, challenge }));
    const toLogin = locationOf(anonymous);
    assert.equal(toLogin.pathname, '/login');
    assert.ok(toLogin.searchParams.get('next')?.startsWith('/oauth/consent?request='));
    assert.equal(anonymous.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(anonymous.headers['x-frame-options'], 'DENY');
  });

  let petrTokens: Tokens;
  await t.test('consent needs a fresh step-up and a same-origin request; the code comes back with state and iss and redeems once', async () => {
    const petr = await signedIn('petr');
    const { verifier, challenge } = pkce();
    const page = locationOf(await petr.get(authorizeUrl({ clientId, challenge })));
    assert.equal(page.pathname, '/oauth/consent');
    const handle = requestHandle(page);
    const view = ok<{ client: { nameSelfAsserted: boolean; name: string }; redirectHost: string; requestedScopes: string[]; consentTextVersion: number }>(await petr.get(`/v1/oauth/requests?request=${encodeURIComponent(handle)}`));
    assert.deepEqual([view.client.nameSelfAsserted, view.client.name, view.redirectHost, view.requestedScopes], [true, 'Synthetic chat client', 'chat.example.test', ['read.public', 'read.me']]);
    expectError(await h.client().get(`/v1/oauth/requests?request=${encodeURIComponent(handle)}`), 401, 'auth.session_invalid');
    expectError(await petr.post('/v1/oauth/requests/decision', { request: handle, decision: 'allow', consentTextVersion: 1 }, { idempotencyKey: null, csrf: 'cross-site' }), 403, 'auth.csrf_rejected');
    expectError(await petr.post('/v1/oauth/requests/decision', { request: `${handle.slice(0, -4)}AAAA`, decision: 'allow', consentTextVersion: 1 }, { idempotencyKey: null }), 404, 'access.not_found');
    expectError(await petr.post('/v1/oauth/requests/decision', { request: handle, decision: 'allow', consentTextVersion: 1, scopes: ['read.me', 'act'] }, { idempotencyKey: null }), 422, 'validation.schema');
    const stale = await signedIn('petr');
    h.clock.advance(11 * 60_000);
    expectError(await stale.post('/v1/oauth/requests/decision', { request: requestHandle(locationOf(await stale.get(authorizeUrl({ clientId, challenge })))), decision: 'allow', consentTextVersion: 1 }, { idempotencyKey: null }), 403, 'auth.step_up_required');
    const fresh = await signedIn('petr');
    const back = await consent(fresh, locationOf(await fresh.get(authorizeUrl({ clientId, challenge }))));
    assert.deepEqual([back.origin + back.pathname, back.searchParams.get('state'), back.searchParams.get('iss')], [REDIRECT, 'synthetic-state', ORIGIN]);
    const code = back.searchParams.get('code') as string;
    const issued = await exchange(h, clientId, code, verifier);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.headers['cache-control'], 'no-store');
    petrTokens = issued.body as unknown as Tokens;
    assert.equal(petrTokens.token_type, 'Bearer');
    assert.ok(petrTokens.expires_in > 0 && petrTokens.expires_in <= 900);
    assert.equal(petrTokens.scope, 'read.public read.me');
    const stored = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.connection_token WHERE token_hash = sha256(convert_to($1, \'UTF8\'))', [petrTokens.access_token]);
    assert.equal(stored.rows[0]?.n, 1, 'only the SHA-256 of the token is stored');
    const codes = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.oauth_authorization_code WHERE code_hash = sha256(convert_to($1, \'UTF8\')) AND consumed_at IS NOT NULL', [code]);
    assert.equal(codes.rows[0]?.n, 1, 'codes are stored as hashes and consumed on redemption');
  });

  await t.test('acceptance: a /mcp token is refused on /mcp/admin and on the first-party API; a session cookie never authorizes /mcp', async () => {
    const okCall = await call(server, '/mcp', bearer(petrTokens.access_token));
    assert.equal(okCall.status, 200);
    assert.equal(okCall.body.personId, people.petr);
    const admin = await call(server, '/mcp/admin', bearer(petrTokens.access_token));
    assert.equal(admin.status, 401);
    assert.match(admin.challenge ?? '', /error="invalid_token"/);
    assert.match(admin.challenge ?? '', /resource_metadata="https:\/\/trustwork\.test\/\.well-known\/oauth-protected-resource\/mcp\/admin"/);
    const firstParty = await h.created.fastify.inject({ method: 'GET', url: '/v1/me', headers: bearer(petrTokens.access_token) });
    assert.equal(firstParty.statusCode, 401, 'MCP tokens never authorize the first-party API');
    const petr = await signedIn('petr');
    const cookie = `${[...petr.jar].map(([k, v]) => `${k}=${v}`).join('; ')}`;
    assert.equal((await petr.get('/v1/me')).status, 200, 'the session itself is valid');
    const withCookie = await call(server, '/mcp', { cookie });
    assert.equal(withCookie.status, 401);
    assert.match(withCookie.challenge ?? '', /^Bearer resource_metadata="https:\/\/trustwork\.test\/\.well-known\/oauth-protected-resource\/mcp", scope="read\.public read\.me"/);
    const query = await server.inject({ method: 'POST', url: `/mcp?access_token=${petrTokens.access_token}`, payload: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(query.statusCode, 400, 'tokens in the query string are refused');
    assert.equal((await call(server, '/mcp', bearer(petrTokens.refresh_token))).status, 401, 'a refresh token is not an access token');
    assert.equal((await call(server, '/mcp', { authorization: `DPoP ${petrTokens.access_token}` })).status, 401, 'a bearer token is not presented as DPoP');
  });

  await t.test('negative grants: replayed code revokes what it issued, code without verifier, wrong verifier, redirect, audience or client', async () => {
    const petr = await signedIn('petr');
    const replay = pkce();
    const code = await authorizeCode(petr, { clientId, challenge: replay.challenge });
    const first = await exchange(h, clientId, code, replay.verifier);
    assert.equal(first.status, 200);
    const second = await exchange(h, clientId, code, replay.verifier);
    assert.deepEqual([second.status, second.body.error], [400, 'invalid_grant']);
    assert.equal((await call(server, '/mcp', bearer(first.body.access_token as string))).status, 401, 'tokens issued from a replayed code stop working');
    assert.equal((await refresh(h, clientId, first.body.refresh_token as string)).body.error, 'invalid_grant');

    const noVerifier = pkce();
    const code2 = await authorizeCode(petr, { clientId, challenge: noVerifier.challenge });
    const without = await form(h, '/v1/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: code2, redirect_uri: REDIRECT, resource: MCP });
    assert.deepEqual([without.status, without.body.error], [400, 'invalid_grant']);
    assert.equal((await exchange(h, clientId, code2, noVerifier.verifier)).body.error, 'invalid_grant', 'a failed redemption consumes the code');

    const wrong = pkce();
    assert.equal((await exchange(h, clientId, await authorizeCode(petr, { clientId, challenge: wrong.challenge }), pkce().verifier)).body.error, 'invalid_grant');
    const p1 = pkce();
    assert.equal((await exchange(h, clientId, await authorizeCode(petr, { clientId, challenge: p1.challenge }), p1.verifier, { redirect_uri: 'https://chat.example.test/oauth/second' })).body.error, 'invalid_grant');
    const p2 = pkce();
    assert.equal((await exchange(h, clientId, await authorizeCode(petr, { clientId, challenge: p2.challenge }), p2.verifier, { resource: MCP_ADMIN })).body.error, 'invalid_grant', 'wrong audience');
    const p3 = pkce();
    const otherClient = await registerClient(h);
    const stolen = await authorizeCode(petr, { clientId, challenge: p3.challenge });
    assert.equal((await exchange(h, otherClient, stolen, p3.verifier)).body.error, 'invalid_grant', 'a code redeems only for its client');
    const p4 = pkce();
    const json = await h.created.fastify.inject({ method: 'POST', url: '/v1/oauth/token', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ grant_type: 'authorization_code', client_id: clientId, code: await authorizeCode(petr, { clientId, challenge: p4.challenge }), code_verifier: p4.verifier, redirect_uri: REDIRECT, resource: MCP }) });
    assert.equal(JSON.parse(json.body).error, 'invalid_request', 'the token endpoint is form-urlencoded only');
    assert.equal((await form(h, '/v1/oauth/token', { grant_type: 'password', client_id: clientId })).body.error, 'unsupported_grant_type');
    assert.equal((await form(h, '/v1/oauth/token', { grant_type: 'authorization_code', client_id: clientId, client_secret: 'x', code: 'twac_x' })).status, 401);
  });

  await t.test('acceptance: reusing a rotated refresh token revokes the family and suspends the connection; consent on the site reactivates it', async () => {
    const xenia = await signedIn('xenia');
    const tokens = await tokensFor(h, xenia, clientId);
    const rotated = await refresh(h, clientId, tokens.refresh_token);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    const next = rotated.body as unknown as Tokens;
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.equal((await call(server, '/mcp', bearer(tokens.access_token))).status, 401, 'the previous access token ends with the rotation');
    assert.equal((await call(server, '/mcp', bearer(next.access_token))).status, 200);
    assert.equal((await refresh(h, clientId, tokens.refresh_token)).body.error, 'invalid_grant', 'reuse is refused');
    assert.equal((await call(server, '/mcp', bearer(next.access_token))).status, 401, 'the whole family is revoked');
    assert.equal((await refresh(h, clientId, next.refresh_token)).body.error, 'invalid_grant');
    const id = await connectionOf(people.xenia, clientId);
    assert.deepEqual(await connectionStatus(id), { status: 'suspended', status_reason: 'refresh_reuse' });
    const listed = ok<{ connections: { id: string; status: string }[] }>(await xenia.get('/v1/oauth/connections'));
    assert.equal(listed.connections.find((c) => c.id === id)?.status, 'suspended');
    const { challenge, verifier } = pkce();
    const page = locationOf(await xenia.get(authorizeUrl({ clientId, challenge })));
    assert.equal(page.pathname, '/oauth/consent', 'a suspended connection needs the person again');
    const back = await consent(xenia, page);
    assert.equal((await exchange(h, clientId, back.searchParams.get('code') as string, verifier)).status, 200);
    assert.deepEqual(await connectionStatus(id), { status: 'active', status_reason: null });
  });

  await t.test('acceptance: a changed redirect URI, wider scopes or prompt=consent require new consent; the same request does not', async () => {
    const carl = await signedIn('carl');
    await tokensFor(h, carl, clientId);
    const same = locationOf(await carl.get(authorizeUrl({ clientId, challenge: pkce().challenge })));
    assert.ok(same.searchParams.get('code'), 'the consent in force covers the same client, redirect URI and scopes');
    assert.equal(same.searchParams.get('iss'), ORIGIN);
    const changed = locationOf(await carl.get(authorizeUrl({ clientId, challenge: pkce().challenge, redirectUri: 'https://chat.example.test/oauth/second' })));
    assert.equal(changed.pathname, '/oauth/consent', 'another redirect URI of the same client needs its own consent');
    const wider = locationOf(await carl.get(authorizeUrl({ clientId, challenge: pkce().challenge, scope: 'read.public read.me read.contexts' })));
    assert.equal(wider.pathname, '/oauth/consent', 'progressive scopes are asked');
    assert.equal(locationOf(await carl.get(authorizeUrl({ clientId, challenge: pkce().challenge, prompt: 'consent' }))).pathname, '/oauth/consent');
    const none = locationOf(await carl.get(authorizeUrl({ clientId, challenge: pkce().challenge, redirectUri: 'https://chat.example.test/oauth/second', prompt: 'none' })));
    assert.equal(none.searchParams.get('error'), 'consent_required');
    const second = await tokensFor(h, carl, clientId, { redirectUri: 'https://chat.example.test/oauth/second', scope: 'read.public read.me read.contexts' }, { scopes: ['read.public', 'read.me'] });
    assert.equal(second.scope, 'read.public read.me', 'the person may grant fewer scopes than requested');
    const consents = await h.db.admin.query<{ redirect_uri: string }>('SELECT redirect_uri FROM trustwork.connection_consent WHERE person_id = $1 AND withdrawn_at IS NULL ORDER BY redirect_uri', [people.carl]);
    assert.deepEqual(consents.rows.map((r) => r.redirect_uri), ['https://chat.example.test/oauth/callback', 'https://chat.example.test/oauth/second']);
  });

  await t.test('mandate bindings: act only with a confirmed mandate of the person, never someone else\'s', async () => {
    const petr = await signedIn('petr');
    const project = ok<{ id: string }>(await petr.post('/v1/projects', { owner: { kind: 'person', id: people.petr }, name: 'Synthetic porch', summary: null, leaderPersonId: null }), 201);
    const mandate = ok<{ id: string }>(await petr.post('/v1/assistant/mandates', { draft: draft({ moduleKeys: ['project_planner'], actions: ['prepare'], contexts: [{ kind: 'project', id: project.id }] }) }), 201);
    const anna = await signedIn('anna');
    const request = (c: Client) => c.get(authorizeUrl({ clientId, challenge: pkce().challenge, scope: 'read.public read.me propose act' }));
    const annaHandle = requestHandle(locationOf(await request(anna)));
    expectError(await anna.post('/v1/oauth/requests/decision', { request: annaHandle, decision: 'allow', consentTextVersion: 1 }, { idempotencyKey: null }), 422, 'validation.schema');
    expectError(await anna.post('/v1/oauth/requests/decision', { request: annaHandle, decision: 'allow', consentTextVersion: 1, mandateBindings: [{ mandateId: mandate.id, revision: 1 }] }, { idempotencyKey: null }), 403, 'access.mandate_scope');
    const petrHandle = requestHandle(locationOf(await request(petr)));
    expectError(await petr.post('/v1/oauth/requests/decision', { request: petrHandle, decision: 'allow', consentTextVersion: 1, mandateBindings: [{ mandateId: mandate.id, revision: 2 }] }, { idempotencyKey: null }), 403, 'access.mandate_scope');
    const decided = ok<{ redirectTo: string }>(await petr.post('/v1/oauth/requests/decision', { request: petrHandle, decision: 'allow', consentTextVersion: 1, mandateBindings: [{ mandateId: mandate.id, revision: 1 }] }, { idempotencyKey: null }));
    assert.ok(new URL(decided.redirectTo).searchParams.get('code'));
    const denied = ok<{ redirectTo: string }>(await anna.post('/v1/oauth/requests/decision', { request: annaHandle, decision: 'deny', consentTextVersion: 1 }, { idempotencyKey: null }));
    assert.deepEqual([new URL(denied.redirectTo).searchParams.get('error'), new URL(denied.redirectTo).searchParams.get('iss')], ['access_denied', ORIGIN]);
  });

  await t.test("another person's token or connection: no read, no revoke, no effect", async () => {
    const boris = await signedIn('boris');
    const borisTokens = await tokensFor(h, boris, clientId);
    const borisConnection = await connectionOf(people.boris, clientId);
    const anna = await signedIn('anna');
    expectError(await anna.post(`/v1/oauth/connections/${borisConnection}/revoke`, undefined, { idempotencyKey: null }), 404, 'access.not_found');
    const annaList = ok<{ connections: { id: string }[] }>(await anna.get('/v1/oauth/connections'));
    assert.ok(!annaList.connections.some((c) => c.id === borisConnection));
    const otherClient = await registerClient(h);
    assert.equal((await form(h, '/v1/oauth/revoke', { client_id: otherClient, token: borisTokens.refresh_token })).status, 200, 'revocation answers 200 whatever happened');
    assert.equal((await call(server, '/mcp', bearer(borisTokens.access_token))).status, 200, "another client cannot revoke the person's tokens");
    await assert.rejects(h.db.app.query('SELECT * FROM trustwork.connection_token'), /permission denied/);
    await assert.rejects(h.db.app.query('SELECT * FROM trustwork.oauth_authorization_code'), /permission denied/);
    await assert.rejects(h.db.app.query('SELECT * FROM trustwork.connection_token_family'), /permission denied/);
    assert.equal((await h.db.app.query('SELECT * FROM trustwork.connection')).rowCount, 0, 'without a principal no connection is visible');
    await assert.rejects(h.db.app.query("SELECT trustwork.connection_revoke_all()"), /verified identity/);
  });

  await t.test('RFC 7009 revocation by the client, and revocation by the person, stop the connection before the next call', async () => {
    const boris = await signedIn('boris');
    const tokens = await tokensFor(h, boris, clientId, { prompt: 'consent' });
    assert.equal((await form(h, '/v1/oauth/revoke', { client_id: clientId, token: tokens.refresh_token, token_type_hint: 'refresh_token' })).status, 200);
    assert.equal((await call(server, '/mcp', bearer(tokens.access_token))).status, 401, 'revoking the refresh token ends its family');
    assert.equal((await form(h, '/v1/oauth/revoke', { client_id: clientId, token: 'twat_unknownunknownunknownunknownunknownunknown00' })).status, 200);
    const missing = await form(h, '/v1/oauth/revoke', { client_id: clientId });
    assert.deepEqual([missing.status, missing.body.error], [400, 'invalid_request']);
    const again = await tokensFor(h, boris, clientId);
    const id = await connectionOf(people.boris, clientId);
    assert.deepEqual(ok(await boris.post(`/v1/oauth/connections/${id}/revoke`, undefined, { idempotencyKey: null })), { revoked: true });
    assert.equal((await call(server, '/mcp', bearer(again.access_token))).status, 401);
    assert.equal((await refresh(h, clientId, again.refresh_token)).body.error, 'invalid_grant');
    assert.deepEqual(await connectionStatus(id), { status: 'revoked', status_reason: 'person_revocation' });
    assert.equal(locationOf(await boris.get(authorizeUrl({ clientId, challenge: pkce().challenge }))).pathname, '/oauth/consent', 'a revoked consent is asked again');
    const all = await tokensFor(h, boris, clientId);
    assert.deepEqual(ok(await boris.post('/v1/oauth/connections/revoke-all', undefined, { idempotencyKey: null })), { revoked: 1 });
    assert.equal((await call(server, '/mcp', bearer(all.access_token))).status, 401);
  });

  await t.test('a disabled client gets nothing and its tokens stop', async () => {
    const victim = await registerClient(h);
    const carl = await signedIn('carl');
    const tokens = await tokensFor(h, carl, victim);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('oauth_client').set({ disabled_at: new Date(), disabled_reason: 'Synthetic: abuse report' }).where('client_id', '=', victim).execute());
    assert.equal((await call(server, '/mcp', bearer(tokens.access_token))).status, 401);
    assert.deepEqual([(await refresh(h, victim, tokens.refresh_token)).status], [401]);
    assert.equal((await get(h, authorizeUrl({ clientId: victim, challenge: pkce().challenge }))).body.error, 'invalid_client');
  });

  await t.test('password change revokes every token of the person; the connection stays for a new sign-in', async () => {
    const carl = await signedIn('carl');
    const tokens = await tokensFor(h, carl, clientId, { prompt: 'consent' });
    assert.equal((await call(server, '/mcp', bearer(tokens.access_token))).status, 200);
    assert.equal((await carl.post('/v1/me/password', { currentPassword: PASSWORDS.carl, newPassword: 'synthetic-new-password-carl-2' }, { idempotencyKey: null })).status, 204);
    assert.equal((await call(server, '/mcp', bearer(tokens.access_token))).status, 401);
    assert.equal((await refresh(h, clientId, tokens.refresh_token)).body.error, 'invalid_grant');
    const families = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.connection_token_family f JOIN trustwork.connection c ON c.id = f.connection_id WHERE c.person_id = $1 AND f.revoked_reason = 'credential_change'", [people.carl]);
    assert.ok((families.rows[0]?.n ?? 0) >= 1);
  });

  await t.test('a jurisdiction-held person gets no tokens and existing tokens stop working', async () => {
    const anna = await signedIn('anna');
    const tokens = await tokensFor(h, anna, clientId, { prompt: 'consent' });
    const { challenge, verifier } = pkce();
    const pendingCode = await authorizeCode(anna, { clientId, challenge });
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('jurisdiction_hold').values({ person_id: people.anna, place: 'CU', source: 'staff_report', dataset: 'synthetic' }).execute());
    assert.equal((await call(server, '/mcp', bearer(tokens.access_token))).status, 401);
    assert.equal((await refresh(h, clientId, tokens.refresh_token)).body.error, 'invalid_grant');
    assert.equal((await exchange(h, clientId, pendingCode, verifier)).body.error, 'invalid_grant', 'a code issued before the hold redeems nothing');
    expectError(await anna.get(authorizeUrl({ clientId, challenge: pkce().challenge })), 403, 'auth.jurisdiction_hold');
  });

  await t.test('a person suspended by a confirmed screening match gets no tokens and existing tokens stop working', async () => {
    const xenia = await signedIn('xenia');
    const tokens = await tokensFor(h, xenia, clientId, { prompt: 'consent' });
    const page = locationOf(await xenia.get(authorizeUrl({ clientId, challenge: pkce().challenge, prompt: 'consent' })));
    // A real possible match from the SANC-003 matcher (synthetic list entry and name), then the confirmation's effect on
    // the records (the staff decision flow itself is covered by tests/screening).
    const workers = await workerLogin(h);
    try {
      const worker = workers.pool(2);
      await withMaintenance(h.db.admin, (trx) => trx.updateTable('screening_list').set({ min_entries: 1, max_drop_share: '0.99' }).where('baseline', '=', true).execute());
      const lists = await baselineIds(h.db.admin);
      await activateList(worker, lists.sdn, SDN_ENTRIES);
      await activateList(worker, lists.cons, CONS_ENTRIES);
      await withMaintenance(h.db.admin, (trx) => trx.updateTable('person').set({ display_name: 'Milo Fictivsky' }).where('id', '=', people.xenia).execute());
      assert.equal((await screen(worker, { kind: 'person', id: people.xenia }, undefined, 'name_change')).outcome, 'possible_match');
    } finally {
      await workers.close();
    }
    await withMaintenance(h.db.admin, async (trx) => {
      await trx.updateTable('screening_match').set({ state: 'confirmed', decided_at: new Date() }).where('subject_person_id', '=', people.xenia).execute();
      await trx.updateTable('screening_subject_state').set({ suspended: true, money_held: true }).where('subject_person_id', '=', people.xenia).execute();
    });
    assert.equal((await call(server, '/mcp', bearer(tokens.access_token))).status, 401);
    assert.equal((await refresh(h, clientId, tokens.refresh_token)).body.error, 'invalid_grant');
    expectError(await xenia.post('/v1/oauth/requests/decision', { request: requestHandle(page), decision: 'allow', consentTextVersion: 1 }, { idempotencyKey: null }), 403, 'auth.compliance_suspended');
    // Defence in depth: the database refuses the consent even if a front forgot the suspension check.
    const epoch = (await h.db.admin.query<{ authz_epoch: number }>('SELECT authz_epoch FROM trustwork.person WHERE id = $1', [people.xenia])).rows[0]?.authz_epoch as number;
    await assert.rejects(withPrincipal(h.pool, { personId: people.xenia, authzEpoch: epoch }, (trx) => connectionGrants.grant(trx, {
      clientId, redirectUri: REDIRECT, surface: 'participant', resource: MCP, scopes: ['read.me'], privateDataClasses: [], toolsets: ['account'], mandateBindings: [],
      consentTextVersion: 1, stepUp: true, elevationId: null, locale: 'en', expiresAt: new Date(Date.now() + 86_400_000), hubId: null,
    })), (e: unknown) => (e as { hint?: string }).hint === 'connections.person_blocked');
  });

  await t.test('Client ID Metadata Documents through the egress guard; a URL resolving to a private address is never fetched', async () => {
    const egress = h.created.app.get(FakeEgress);
    const cimd = 'https://chat.example.test/oauth/client.json';
    egress.dns.set('chat.example.test', '93.184.216.34');
    egress.transport.serve(cimd, { client_id: cimd, client_name: 'Synthetic metadata client', redirect_uris: [REDIRECT] }, { 'cache-control': 'max-age=600' });
    const petr = await signedIn('petr');
    const tokens = await tokensFor(h, petr, cimd);
    assert.equal((await call(server, '/mcp', bearer(tokens.access_token))).status, 200);
    const fetchedOnce = egress.transport.requests.filter((r) => r.url.toString() === cimd).length;
    await tokensFor(h, petr, cimd);
    assert.equal(egress.transport.requests.filter((r) => r.url.toString() === cimd).length, fetchedOnce, 'cached by Cache-Control');
    const evil = 'https://intranet.example.test/oauth/client.json';
    egress.dns.set('intranet.example.test', '10.0.0.7');
    egress.transport.serve(evil, { client_id: evil, client_name: 'Intranet', redirect_uris: [REDIRECT] });
    const refused = await petr.get(authorizeUrl({ clientId: evil, challenge: pkce().challenge }));
    assert.deepEqual([refused.status, (refused.body as { error: string }).error], [400, 'invalid_client']);
    const literal = 'https://169.254.169.254/latest/meta-data';
    assert.equal((await petr.get(authorizeUrl({ clientId: literal, challenge: pkce().challenge }))).status, 400);
    assert.ok(!egress.transport.requests.some((r) => r.url.host === 'intranet.example.test' || r.url.host === '169.254.169.254'), 'never fetched');
    const liar = 'https://chat.example.test/oauth/liar.json';
    egress.transport.serve(liar, { client_id: cimd, redirect_uris: [REDIRECT] });
    assert.equal(((await petr.get(authorizeUrl({ clientId: liar, challenge: pkce().challenge }))).body as { error: string }).error, 'invalid_client');
  });

  await t.test('DPoP when presented: the family is bound to the key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const proof = (method: string, url: string, ath?: string) => {
      const input = `${Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk })).toString('base64url')}.${Buffer.from(JSON.stringify({ htm: method, htu: url, iat: Math.floor(h.clock.now().getTime() / 1000), jti: randomUUID(), ...(ath ? { ath } : {}) })).toString('base64url')}`;
      return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    };
    const boris = await signedIn('boris');
    const { challenge, verifier } = pkce();
    const code2 = await authorizeCode(boris, { clientId, challenge, prompt: 'consent' });
    const bound = await form(h, '/v1/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: code2, code_verifier: verifier, redirect_uri: REDIRECT, resource: MCP }, { dpop: proof('POST', `${ORIGIN}/v1/oauth/token`) });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.equal(bound.body.token_type, 'DPoP');
    const token = bound.body.access_token as string;
    const ath = createHash('sha256').update(token).digest('base64url');
    assert.equal((await call(server, '/mcp', bearer(token))).status, 401, 'a bound token is not a bearer token');
    assert.equal((await call(server, '/mcp', { authorization: `DPoP ${token}`, dpop: proof('POST', `${ORIGIN}/mcp`, ath) })).status, 200);
    assert.equal((await call(server, '/mcp', { authorization: `DPoP ${token}`, dpop: proof('POST', `${ORIGIN}/mcp/admin`, ath) })).status, 401, 'htu must match');
    assert.equal((await refresh(h, clientId, bound.body.refresh_token as string)).body.error, 'invalid_dpop_proof', 'refresh needs a proof with the same key');
    const bad = await form(h, '/v1/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: bound.body.refresh_token as string }, { dpop: 'not.a.proof' });
    assert.equal(bad.body.error, 'invalid_dpop_proof');
  });

  await t.test('concurrency: two redemptions of one code, exactly one issues; two refreshes of one token, exactly one rotates', async () => {
    const boris = await signedIn('boris');
    for (let round = 0; round < 3; round++) {
      const { challenge, verifier } = pkce();
      const code = await authorizeCode(boris, { clientId, challenge });
      const results: Raw[] = await Promise.all([exchange(h, clientId, code, verifier), exchange(h, clientId, code, verifier)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 400], `round ${round}`);
      const families: { rows: { n: number }[] } = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.connection_token_family f JOIN trustwork.oauth_authorization_code c ON c.id = f.code_id WHERE c.code_hash = sha256(convert_to($1, \'UTF8\'))', [code]);
      assert.equal(families.rows[0]?.n, 1, 'one family per code');
    }
    // Forced contention: the code row is locked by another transaction until both redemptions wait on it.
    const gated = pkce();
    const gatedCode = await authorizeCode(boris, { clientId, challenge: gated.challenge });
    const holder = await h.db.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      await holder.query('SET LOCAL ROLE trustwork_owner');
      const locked = await holder.query("SELECT id FROM trustwork.oauth_authorization_code WHERE code_hash = sha256(convert_to($1, 'UTF8')) FOR UPDATE", [gatedCode]);
      assert.equal(locked.rowCount, 1);
      const before = await lockWaiters(h.db.admin);
      const pending = Promise.all([exchange(h, clientId, gatedCode, gated.verifier), exchange(h, clientId, gatedCode, gated.verifier)]);
      await until(async () => (await lockWaiters(h.db.admin)) >= before + 2, 'both redemptions waiting on the code row');
      await holder.query('COMMIT');
      const outcome: Raw[] = await pending;
      assert.deepEqual(outcome.map((r) => r.status).sort(), [200, 400], 'exactly one waiting redemption issues tokens');
    } finally {
      holder.release();
    }
    const tokens = await tokensFor(h, boris, clientId);
    const raced = await Promise.all([refresh(h, clientId, tokens.refresh_token), refresh(h, clientId, tokens.refresh_token)]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 400]);
    const winner = raced.find((r) => r.status === 200)?.body as unknown as Tokens;
    assert.equal((await call(server, '/mcp', bearer(winner.access_token))).status, 401, 'the losing presentation is reuse: the family ends');
  });

  await t.test('the staff surface: staff role and an elevated session to consent; staff tokens only on /mcp/admin', async () => {
    const plain = await signedIn('boris');
    const adminRequest = (c: Client) => c.get(authorizeUrl({ clientId, challenge: pkce().challenge, resource: MCP_ADMIN, scope: 'admin.read' }));
    const borisHandle = requestHandle(locationOf(await adminRequest(plain)));
    expectError(await plain.post('/v1/oauth/requests/decision', { request: borisHandle, decision: 'allow', consentTextVersion: 1 }, { idempotencyKey: null }), 403, 'access.forbidden');
    assert.equal(locationOf(await plain.get(authorizeUrl({ clientId, challenge: pkce().challenge, resource: MCP_ADMIN, scope: 'act' }))).searchParams.get('error'), 'invalid_scope');
    h.staff.set(people.petr, ['support-agent']);
    const petr = await signedIn('petr');
    const handle = requestHandle(locationOf(await adminRequest(petr)));
    const refused = await petr.post('/v1/oauth/requests/decision', { request: handle, decision: 'allow', consentTextVersion: 1 }, { idempotencyKey: null });
    assert.equal((refused.body as { details?: { required?: string } }).details?.required, 'elevation');
    const factor = await enrol(h, petr);
    await elevate(h, petr, factor.secret);
    await petr.post('/v1/auth/step-up', { password: PASSWORDS.petr }, { idempotencyKey: null });
    const { challenge, verifier } = pkce();
    const page = locationOf(await petr.get(authorizeUrl({ clientId, challenge, resource: MCP_ADMIN, scope: 'admin.read' })));
    assert.equal(page.pathname, '/oauth/consent', 'staff consent is always asked');
    const back = await consent(petr, page);
    const issued = await exchange(h, clientId, back.searchParams.get('code') as string, verifier, { resource: MCP_ADMIN });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const staffToken = issued.body.access_token as string;
    assert.equal((await call(server, '/mcp/admin', bearer(staffToken))).status, 200);
    assert.equal((await call(server, '/mcp', bearer(staffToken))).status, 401, 'a staff token is refused on the participant surface');
    h.staff.set(people.petr, []);
    assert.equal((await call(server, '/mcp/admin', bearer(staffToken))).status, 401, 'an ended staff role ends the staff token');
  });
});
