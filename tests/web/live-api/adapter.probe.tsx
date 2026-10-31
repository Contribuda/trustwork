/**
 * WEB-004 probe of the live API adapter, run by adapter.test.ts with this directory's tsconfig (the web app's `@/`
 * paths) under `node --test`. The transport talks to a fake fetch; no network is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpDataPort } from '@/app/_lib/data/http';
import { ApiFailure, createTransport, type FetchLike } from '@/app/_lib/data/http/transport';
import { apiOrigin, ApiConfigurationError } from '@/app/_lib/data/http/config';
import { companyStatus, toWorkspaceProject } from '@/app/_lib/data/http/map';
import { LIVE_CONTEXT, defaultPersona, demoModeEnabled, resolveDemoContext, withDemo } from '@/app/_lib/persona';
import type { AuthenticatedPrincipal, Principal } from '@/app/_lib/data';

type Call = { url: string; headers: Record<string, string> };
type Reply = { status: number; body: unknown };

const PERSON = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-10-31T09:00:00.000Z';
const SESSION = { name: '__Host-sr_session', value: 'session-token-value' };

function fakeFetch(routes: Record<string, Reply>, calls: Call[]): FetchLike {
  return async (input, init) => {
    calls.push({ url: input, headers: init.headers });
    const path = input.replace('http://api.test', '');
    const reply = routes[path] ?? { status: 404, body: { code: 'access.not_found', message: 'not found', requestId: 'req-1' } };
    return { status: reply.status, json: async () => (typeof reply.body === 'string' ? JSON.parse(reply.body) : reply.body) };
  };
}

function port(routes: Record<string, Reply>, cookies = [SESSION, { name: 'trustwork.locale', value: 'ru' }, { name: 'other', value: 'x' }]) {
  const calls: Call[] = [];
  const transport = createTransport({ origin: () => 'http://api.test', fetch: fakeFetch(routes, calls), cookies: async () => cookies });
  return { data: createHttpDataPort(transport), transport, calls };
}

const person = {
  id: PERSON, displayName: 'Dana Builder', profileVisibility: 'private', publicProfile: { headline: null, expertise: [] },
  emailBindings: [{ email: 'dana@example.invalid', isPrimary: true, verifiedAt: NOW }], providerIdentities: [],
  preferences: { buying: true, selling: false, industryParticipation: true }, revision: 1, createdAt: NOW,
};
const principal = { personId: PERSON, emailVerified: true, authenticatedAt: NOW, authzEpoch: 1, membership: { companyId: COMPANY, membershipId: '44444444-4444-4444-8444-444444444444', role: 'administrator', permissions: ['company.members.manage', 'company.deals.manage', 'company.publish'], companyAuthzEpoch: 0 }, staff: [], delegation: null };
const company = { id: COMPANY, name: 'Acme Build', status: 'sourced', legalIdentifiers: [], publicDescription: 'We build' };

test('demo mode is off unless TRUSTWORK_DEMO_MODE says so', () => {
  assert.equal(demoModeEnabled({}), false);
  assert.equal(demoModeEnabled({ TRUSTWORK_DEMO_MODE: '' }), false);
  assert.equal(demoModeEnabled({ TRUSTWORK_DEMO_MODE: '0' }), false);
  assert.equal(demoModeEnabled({ TRUSTWORK_DEMO_MODE: '1' }), true);
  assert.equal(demoModeEnabled({ TRUSTWORK_DEMO_MODE: 'true' }), true);
});

test('with demo mode off, ?persona= and ?scenario= are refused and links never carry them', () => {
  const ctx = resolveDemoContext({ persona: 'owner', scenario: 'error' }, 'mixed', false);
  assert.deepEqual(ctx, LIVE_CONTEXT);
  assert.equal(resolveDemoContext(new URLSearchParams('persona=mixed')).persona, 'anonymous', 'the server default reads the environment (demo off here)');
  assert.equal(defaultPersona(false), 'anonymous', 'TRUSTWORK_DEMO_PERSONA is ignored in live mode');
  assert.equal(withDemo('/app/projects', LIVE_CONTEXT), '/app/projects');
  // The demo still works when enabled.
  assert.equal(resolveDemoContext({ persona: 'owner' }, 'anonymous', true).persona, 'owner');
});

test('the API origin is required in production and must be a bare http(s) origin', () => {
  assert.equal(apiOrigin({}), 'http://127.0.0.1:3001');
  assert.equal(apiOrigin({ TRUSTWORK_API_ORIGIN: 'https://api.example.invalid/' }), 'https://api.example.invalid');
  assert.throws(() => apiOrigin({ NODE_ENV: 'production' }), ApiConfigurationError);
  for (const bad of ['ftp://x.invalid', 'https://x.invalid/v1', 'https://user:pw@x.invalid', 'not a url']) assert.throws(() => apiOrigin({ TRUSTWORK_API_ORIGIN: bad }), ApiConfigurationError, bad);
});

test('the transport forwards only the session cookie, sends none on anonymous reads, and maps failures', async () => {
  const { transport, calls } = port({
    '/v1/me': { status: 200, body: { ok: true } },
    '/v1/companies': { status: 200, body: { items: [] } },
    '/v1/broken': { status: 502, body: '"<html>"' },
    '/v1/private': { status: 401, body: { code: 'auth.session_invalid', message: 'x', requestId: 'req-9' } },
  });
  await transport.get('/v1/me');
  assert.equal(calls[0]!.headers.cookie, '__Host-sr_session=session-token-value', 'locale and other cookies stay in the browser');
  await transport.get('/v1/companies', { anonymous: true });
  assert.equal(calls[1]!.headers.cookie, undefined);
  assert.equal(await transport.get('/v1/unknown'), null, '404 access.not_found is null');
  await assert.rejects(transport.get('/v1/private'), (e: unknown) => e instanceof ApiFailure && e.status === 401 && e.code === 'auth.session_invalid' && e.requestId === 'req-9');
  await assert.rejects(transport.get('/v1/broken'), (e: unknown) => e instanceof ApiFailure && e.code === 'internal.error');
});

test('without a session cookie there is no principal and no request; an invalid session is anonymous', async () => {
  const anonymous = port({}, [{ name: 'trustwork.locale', value: 'ru' }]);
  assert.equal(await anonymous.data.principalFor(LIVE_CONTEXT), null);
  assert.equal(anonymous.calls.length, 0);
  const expired = port({ '/v1/me': { status: 401, body: { code: 'auth.session_invalid', message: 'x', requestId: 'r' } } });
  assert.equal(await expired.data.principalFor(LIVE_CONTEXT), null);
});

test('the session principal comes from /v1/me and the employer, never from the demo persona', async () => {
  const { data } = port({
    '/v1/me': { status: 200, body: { person, principal } },
    [`/v1/companies/${COMPANY}`]: { status: 200, body: { company, privateView: { internalNotes: 'SECRET', billingAccountId: null, verifiedDomains: [] }, membership: null } },
  });
  const p = (await data.principalFor({ persona: 'owner', scenario: 'error', fromQuery: true, defaultPersona: 'owner' }))!;
  assert.equal(p.persona, 'session');
  assert.deepEqual(p.demo, LIVE_CONTEXT);
  assert.equal(p.displayName, 'Dana Builder');
  assert.equal(p.company?.name, 'Acme Build');
  assert.equal(p.company?.role, 'administrator');
  assert.ok(!JSON.stringify(p).includes('SECRET'), 'company private view never reaches the principal');
});

test('public reads are anonymous even for a signed-in visitor, and use handles or ids', async () => {
  const { data, calls } = port({
    '/v1/companies/by-handle/acme-build': { status: 200, body: { item: { id: COMPANY, handle: 'acme-build', name: 'Acme Build', origin: 'registered', claimStatus: 'unclaimed', legalIdentifiers: [], publicDescription: null }, redirect: false } },
    [`/v1/projects/${PROJECT}`]: { status: 200, body: { projection: 'owner_private', project: { id: PROJECT } } },
  });
  const detail = (await data.getCompany('acme-build'))!;
  assert.equal(detail.status, 'registered', 'a registered company is neither sourced nor claimed');
  assert.equal(detail.href, '/companies/acme-build');
  assert.equal(calls.at(-1)!.headers.cookie, undefined);
  assert.equal(await data.getPublicProject(PROJECT), null, 'anything but the public projection is refused on a public page');
  assert.equal(await data.getCompany('missing-handle'), null);
});

test('company status keeps sourced, registered, claimed and verified apart', () => {
  assert.equal(companyStatus('sourced', 'unclaimed'), 'sourced');
  assert.equal(companyStatus('registered', 'unclaimed'), 'registered');
  assert.equal(companyStatus('registered', 'claimed'), 'claimed');
  assert.equal(companyStatus('sourced', 'verified'), 'verified');
});

test('modules the API does not serve yet answer empty results instead of fixtures', async () => {
  const { data } = port({ '/v1/people?limit=100': { status: 200, body: { items: [], nextCursor: null } }, '/v1/projects?limit=100': { status: 200, body: { items: [], nextCursor: null } } });
  assert.deepEqual(await data.listEvents(), []);
  assert.deepEqual(await data.listNews(), []);
  assert.deepEqual(await data.getMagazine(), { current: null, archive: [] });
  assert.equal(await data.getEvent('any'), null);
  const home = await data.getHome();
  assert.deepEqual(home.featured, []);
  assert.deepEqual(home.peopleAndProjects, { people: [], projects: [] });
  assert.equal(data.source, 'api');
});

test('the home page survives an unreachable API; other pages surface the failure', async () => {
  const calls: Call[] = [];
  const down: FetchLike = async (input, init) => {
    calls.push({ url: input, headers: init.headers });
    throw new TypeError('fetch failed');
  };
  const data = createHttpDataPort(createTransport({ origin: () => 'http://api.test', fetch: down, cookies: async () => [] }));
  assert.deepEqual((await data.getHome()).peopleAndProjects, { people: [], projects: [] });
  await assert.rejects(data.listCompanies());
});

test('workspace reads reject an anonymous principal', async () => {
  const { data } = port({});
  const anonymous: Principal = { kind: 'anonymous', persona: 'anonymous', demo: LIVE_CONTEXT };
  await assert.rejects(data.listWorkspaceProjects(anonymous));
  await assert.rejects(data.getCompanyWorkspace(anonymous));
  await assert.rejects(data.getSettings(anonymous));
});

test('the workspace project view carries no owner-private field and refuses the public projection', () => {
  const me = { kind: 'person', persona: 'session', personId: PERSON, displayName: 'Dana', company: null } as unknown as AuthenticatedPrincipal;
  const project = {
    id: PROJECT, owner: { kind: 'person', id: PERSON }, creatorPersonId: PERSON, leaderPersonId: null, name: 'House', summary: null, status: 'planned',
    publicity: { enabled: false, publishedStory: null, openNeedIds: [], publicParticipantIds: [] }, milestones: [], sharedFiles: [], baselinePlanId: null,
    budgets: [{ budgetId: 'b-1', limit: { minorUnits: '99999', currency: 'USD' } }], participantIds: [], privateFiles: [], privateNotes: 'SECRET-NOTE', revision: 3, createdAt: NOW,
  };
  const view = toWorkspaceProject({ projection: 'owner_private', project: project as never }, null, me)!;
  assert.equal(view.live?.revision, 3);
  assert.equal(view.live?.canPublish, true);
  assert.equal(view.budget, null);
  const json = JSON.stringify(view);
  for (const secret of ['SECRET-NOTE', '99999', 'budgetId']) assert.ok(!json.includes(secret), secret);
  assert.equal(toWorkspaceProject({ projection: 'public', project: { id: PROJECT, name: 'House', summary: null, status: 'planned', publishedStory: null, openNeedIds: [], publicParticipantIds: [] } }, null, me), null);
});
