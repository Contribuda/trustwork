import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { addressAllowed, EgressRefused, FakeDns, FakeTransport, GuardedFetcher } from '../../../apps/api/src/modules/connections/oauth/egress.js';
import {
  cacheSeconds, isMetadataClientId, parseClientMetadataDocument, parseRegistrationRequest, redirectUriMatches,
} from '../../../apps/api/src/modules/connections/oauth/client-metadata.js';
import { credentialKindOf, hashCredential, newCredential, ReplayCache, s256, signRequest, verifyRequest, type AuthorizationRequest } from '../../../apps/api/src/modules/connections/oauth/crypto.js';
import { jwkThumbprint, verifyClientAssertion, verifyDpopProof } from '../../../apps/api/src/modules/connections/oauth/jose.js';
import { oauthSettingsFromEnv, OAuthConfigError, surfaceOf } from '../../../apps/api/src/modules/connections/oauth/config.js';
import { apiConfigFromEnv } from '../../../apps/api/src/config.js';

/** MCP-002 pure parts: the egress guard (SSRF), client documents, credentials, signed requests, DPoP and assertions, settings. */

test('the egress guard refuses every private, loopback, link-local and reserved address form', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.10', '198.51.100.7', '203.0.113.9',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:0a00:0001::1', '2001:0:4136:e378::1', 'fe80::1%en0', '::127.0.0.1', 'not-an-address',
  ]) assert.equal(addressAllowed(address), false, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:93.184.216.34', '64:ff9b::808:808']) assert.equal(addressAllowed(address), true, address);
});

test('a metadata document URL resolving to a private address is never fetched', async () => {
  const dns = new FakeDns();
  const transport = new FakeTransport();
  const fetcher = new GuardedFetcher(dns, transport);
  dns.set('private.example.test', '10.0.0.7');
  dns.set('mixed.example.test', '93.184.216.34', '192.168.0.2');
  dns.set('metadata.example.test', '169.254.169.254');
  dns.set('mapped.example.test', '::ffff:127.0.0.1');
  for (const url of ['https://private.example.test/client.json', 'https://mixed.example.test/client.json', 'https://metadata.example.test/latest', 'https://mapped.example.test/c']) {
    transport.serve(url, { client_id: url, redirect_uris: ['https://x.example.test/cb'] });
    await assert.rejects(fetcher.fetchJson(url), (e: unknown) => e instanceof EgressRefused && e.reason === 'private_address', url);
  }
  for (const [url, reason] of [
    ['https://127.0.0.1/c.json', 'private_address'], ['https://[::1]/c.json', 'private_address'], ['https://169.254.169.254/c', 'private_address'], ['https://localhost/c.json', 'private_address'],
    ['https://printer.local/c.json', 'private_address'], ['http://public.example.test/c.json', 'not_https'], ['https://user:pw@public.example.test/c.json', 'credentials_in_url'],
    ['https://public.example.test:8443/c.json', 'port_not_allowed'], ['https://unknown.example.test/c.json', 'unresolvable'], ['not a url', 'invalid_url'],
  ] as const) await assert.rejects(fetcher.fetchJson(url), (e: unknown) => e instanceof EgressRefused && e.reason === reason, url);
  assert.equal(transport.requests.length, 0, 'the transport was never called for a refused URL');

  dns.set('public.example.test', '93.184.216.34');
  transport.serve('https://public.example.test/c.json', { client_id: 'https://public.example.test/c.json', redirect_uris: ['https://x.example.test/cb'] }, { 'cache-control': 'max-age=600' });
  const fetched = await fetcher.fetchJson('https://public.example.test/c.json');
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.address.address, '93.184.216.34', 'the request is pinned to the checked address');
  assert.equal((fetched.document as { client_id: string }).client_id, 'https://public.example.test/c.json');
  transport.serve('https://public.example.test/redirect', '', { location: 'https://10.0.0.1/' }, 302);
  await assert.rejects(fetcher.fetchJson('https://public.example.test/redirect'), (e: unknown) => e instanceof EgressRefused && e.reason === 'redirect');
  transport.serve('https://public.example.test/big', 'x'.repeat(20_000));
  await assert.rejects(fetcher.fetchJson('https://public.example.test/big'), (e: unknown) => e instanceof EgressRefused && e.reason === 'too_large');
  transport.serve('https://public.example.test/html', '<html>', { 'content-type': 'text/html' });
  await assert.rejects(fetcher.fetchJson('https://public.example.test/html'), (e: unknown) => e instanceof EgressRefused && e.reason === 'not_json');
});

test('client documents: id equality, public clients only, redirect rules, loopback port matching, cache lifetime', () => {
  const id = 'https://chat.example.test/oauth/client.json';
  assert.equal(isMetadataClientId(id), true);
  for (const bad of ['http://chat.example.test/c', 'https://chat.example.test', 'https://chat.example.test/', 'https://chat.example.test/c#x', 'https://chat.example.test/a/../c']) assert.equal(isMetadataClientId(bad), false, bad);
  const doc = parseClientMetadataDocument(id, { client_id: id, client_name: 'Synthetic chat', redirect_uris: ['https://chat.example.test/cb'] });
  assert.deepEqual([doc.clientName, doc.applicationType], ['Synthetic chat', 'web']);
  assert.throws(() => parseClientMetadataDocument(id, { client_id: 'https://other.example.test/c', redirect_uris: ['https://chat.example.test/cb'] }), /differs/);
  assert.throws(() => parseClientMetadataDocument(id, { client_id: id, client_secret: 's', redirect_uris: ['https://chat.example.test/cb'] }), /secret/);
  assert.throws(() => parseClientMetadataDocument(id, { client_id: id, redirect_uris: ['http://chat.example.test/cb'] }), /redirect/);
  assert.throws(() => parseClientMetadataDocument(id, { client_id: id, redirect_uris: ['https://chat.example.test/cb'], token_endpoint_auth_method: 'client_secret_basic' }));
  assert.throws(() => parseRegistrationRequest({ redirect_uris: ['https://a.example.test/cb'] }), /application_type/);
  assert.equal(parseRegistrationRequest({ application_type: 'native', redirect_uris: ['http://127.0.0.1/callback'] }).applicationType, 'native');
  assert.throws(() => parseRegistrationRequest({ application_type: 'web', redirect_uris: ['http://127.0.0.1/callback'] }), /redirect/);
  assert.equal(redirectUriMatches('http://127.0.0.1/callback', 'http://127.0.0.1:53682/callback'), true);
  assert.equal(redirectUriMatches('http://localhost:3000/callback', 'http://localhost:4000/callback'), true);
  assert.equal(redirectUriMatches('http://127.0.0.1/callback', 'http://127.0.0.1:53682/other'), false);
  assert.equal(redirectUriMatches('https://a.example.test/cb', 'https://a.example.test/cb?x=1'), false);
  assert.equal(redirectUriMatches('https://a.example.test:443/cb', 'https://a.example.test:444/cb'), false);
  assert.deepEqual([cacheSeconds(undefined), cacheSeconds('max-age=5'), cacheSeconds('public, max-age=600'), cacheSeconds('max-age=999999'), cacheSeconds('no-store')], [3600, 60, 600, 86400, 60]);
});

test('credentials are prefixed 256-bit values compared by hash; PKCE is S256', () => {
  const access = newCredential('access');
  assert.equal(credentialKindOf(access), 'access');
  assert.equal(credentialKindOf(newCredential('refresh')), 'refresh');
  assert.equal(credentialKindOf('twat_short'), null);
  assert.notEqual(newCredential('code'), newCredential('code'));
  assert.equal(hashCredential(access).length, 32);
  // RFC 7636 appendix B.
  assert.equal(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('the signed authorization request cannot be altered or used after it expires', () => {
  const secret = Buffer.alloc(32, 7);
  const now = new Date('2026-11-02T22:00:00Z');
  const request: AuthorizationRequest = {
    v: 1, clientId: 'twdc_x', redirectUri: 'https://a.example.test/cb', registeredRedirectUri: 'https://a.example.test/cb', state: 's', codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    resource: 'https://trustwork.test/mcp', surface: 'participant', scopes: ['read.public', 'read.me'], dpopJkt: null, exp: Math.floor(now.getTime() / 1000) + 600,
  };
  const handle = signRequest(secret, request);
  assert.deepEqual(verifyRequest(secret, handle, now), request);
  const [payload, mac] = handle.split('.') as [string, string];
  const widened = Buffer.from(JSON.stringify({ ...request, scopes: ['read.public', 'read.me', 'act'] })).toString('base64url');
  assert.equal(verifyRequest(secret, `${widened}.${mac}`, now), null, 'scopes cannot be widened');
  assert.equal(verifyRequest(Buffer.alloc(32, 8), handle, now), null, 'another key');
  assert.equal(verifyRequest(secret, `${payload}.`, now), null);
  assert.equal(verifyRequest(secret, handle, new Date(now.getTime() + 601_000)), null, 'expired');
});

function jws(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject, alg: 'ES256' | 'EdDSA' | 'RS256'): string {
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = alg === 'ES256' ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : alg === 'EdDSA' ? sign(null, Buffer.from(input), key) : sign('sha256', Buffer.from(input), key);
  return `${input}.${signature.toString('base64url')}`;
}

test('DPoP proofs: signature, method, URL, freshness, access token hash and replay', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const now = new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const replay = new ReplayCache();
  const proof = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) =>
    jws({ typ: 'dpop+jwt', alg: 'ES256', jwk, ...header }, { htm: 'POST', htu: 'https://trustwork.test/v1/oauth/token', iat, jti: randomUUID(), ...claims }, privateKey, 'ES256');
  const check = { method: 'POST', url: 'https://trustwork.test/v1/oauth/token', now, replay };
  assert.equal(verifyDpopProof(proof(), check), jwkThumbprint(jwk));
  const once = proof();
  verifyDpopProof(once, check);
  assert.throws(() => verifyDpopProof(once, check), /replayed/);
  assert.throws(() => verifyDpopProof(proof({ htm: 'GET' }), check), /htm/);
  assert.throws(() => verifyDpopProof(proof({ htu: 'https://evil.example.test/v1/oauth/token' }), check), /htu/);
  assert.throws(() => verifyDpopProof(proof({ iat: iat - 3600 }), check), /iat/);
  assert.throws(() => verifyDpopProof(proof({}, { typ: 'JWT' }), check), /typ/);
  assert.throws(() => verifyDpopProof(proof({}, { jwk: { ...jwk, d: 'secret' } }), check), /public/);
  const token = newCredential('access');
  assert.throws(() => verifyDpopProof(proof({ ath: 'wrong' }), { ...check, accessToken: token }), /ath/);
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const forged = jws({ typ: 'dpop+jwt', alg: 'ES256', jwk }, { htm: 'POST', htu: check.url, iat, jti: randomUUID() }, other.privateKey, 'ES256');
  assert.throws(() => verifyDpopProof(forged, check), /signature/);
});

test('private_key_jwt client assertions: key, issuer, audience, lifetime and single use', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1' };
  const now = new Date();
  const replay = new ReplayCache();
  const nowS = Math.floor(now.getTime() / 1000);
  const assertion = (claims: Record<string, unknown> = {}) =>
    jws({ alg: 'EdDSA', kid: 'k1' }, { iss: 'twpr_company_erp_1', sub: 'twpr_company_erp_1', aud: 'https://trustwork.test', exp: nowS + 120, jti: randomUUID(), ...claims }, privateKey, 'EdDSA');
  const check = { clientId: 'twpr_company_erp_1', audiences: ['https://trustwork.test', 'https://trustwork.test/v1/oauth/token'], jwks: { keys: [jwk] }, now, replay };
  verifyClientAssertion(assertion(), check);
  const once = assertion();
  verifyClientAssertion(once, check);
  assert.throws(() => verifyClientAssertion(once, check), /replayed/);
  assert.throws(() => verifyClientAssertion(assertion({ sub: 'someone' }), check), /iss and sub/);
  assert.throws(() => verifyClientAssertion(assertion({ aud: 'https://other.example.test' }), check), /aud/);
  assert.throws(() => verifyClientAssertion(assertion({ exp: nowS + 3600 }), check), /exp/);
  assert.throws(() => verifyClientAssertion(assertion({ exp: nowS - 1 }), check), /exp/);
});

test('settings: engine bounds, the admin surface off by default, exact resource indicators', () => {
  const config = apiConfigFromEnv({ PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_PROVIDER_MODE: 'fake' });
  const settings = oauthSettingsFromEnv(config, {});
  assert.equal(settings.policy.endpoints.admin, false);
  assert.equal(settings.policy.accessTokenTtlSeconds, 900);
  assert.equal(settings.metadataFetch, 'fake');
  assert.equal(surfaceOf(settings, 'https://trustwork.test/mcp'), 'participant');
  assert.equal(surfaceOf(settings, 'https://trustwork.test/mcp/admin'), 'admin');
  for (const r of ['https://trustwork.test/mcp/', 'https://trustwork.test/mcp/public', 'https://evil.test/mcp', 'https://trustwork.test/MCP']) assert.equal(surfaceOf(settings, r), null, r);
  assert.throws(() => oauthSettingsFromEnv(config, { MCP_ACCESS_TOKEN_TTL_SECONDS: '3600' }), OAuthConfigError);
  assert.throws(() => oauthSettingsFromEnv(config, { MCP_CLIENT_TRUST: 'listed_clients_only' }), OAuthConfigError, 'listed-only trust needs a listed client');
  assert.throws(() => oauthSettingsFromEnv(config, { MCP_CLIENT_METADATA_FETCH: 'sometimes' }), OAuthConfigError);
  assert.equal(oauthSettingsFromEnv(config, { MCP_ADMIN_ENDPOINT: 'true' }).policy.endpoints.admin, true);
});
