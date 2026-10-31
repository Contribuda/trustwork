// Full-stack smoke (OPS-002): proves the compose stack works on one origin.
//   docker compose -f infra/compose.yaml --profile stack up --build --wait
//   node infra/images/stack-smoke.mjs
// Environment: TRUSTWORK_STACK_ORIGIN (default http://localhost:8080) and TRUSTWORK_STACK_COMPOSE, the compose command
// prefix used to read the API log and run negative checks (default "docker compose -f infra/compose.yaml --profile stack").
// Checks: the proxy routes / to the web app and /v1/* to the API; CSRF rejects cross-site and header-less mutations;
// sign-up, e-mail verification (token from the fake mailbox in the API log), login, /v1/me and logout all work through
// the proxy; every long-running service is healthy and runs as uid 1000; the migrate job refuses a runtime role; the
// API image refuses to boot with NODE_ENV=production and an http origin. Exit 0 when everything passed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const origin = (process.env.TRUSTWORK_STACK_ORIGIN ?? 'http://localhost:8080').replace(/\/$/, '');
const compose = (process.env.TRUSTWORK_STACK_COMPOSE ?? 'docker compose -f infra/compose.yaml --profile stack').split(/\s+/).filter(Boolean);
const [composeBin, ...composeArgs] = compose;
const run = (args, options = {}) => spawnSync(composeBin, [...composeArgs, ...args], { encoding: 'utf8', ...options });
const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok   ${name}`);
}

const mutation = (cookie) => ({ 'content-type': 'application/json', origin, 'x-trustwork-request': '1', ...(cookie ? { cookie } : {}) });
const post = (path, body, headers = mutation()) => fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
const errorCode = async (response) => { try { return (await response.json())?.code ?? null; } catch { return null; } };
const sessionCookie = (response) => {
  const cookies = response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
  return cookies.find((c) => c.startsWith('__Host-sr_session=')) ?? null;
};

async function waitForProxy() {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await get('/proxy/health');
      if (response.ok) return;
    } catch { /* still starting */ }
    if (Date.now() > deadline) throw new Error(`proxy at ${origin} did not answer within 120 s`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

await step('proxy answers on the public origin', waitForProxy);

await step('/ is served by the web app through the proxy', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html[^>]*lang="en"/);
  assert.match(html, /<title>Trustwork<\/title>/);
  assert.equal(response.headers.get('server'), null, 'the proxy strips the Server header');
});

await step('/v1/* is served by the API through the proxy (anonymous /v1/me is 401)', async () => {
  const response = await get('/v1/me');
  assert.equal(response.status, 401);
  assert.equal(await errorCode(response), 'auth.session_invalid');
});

const email = `stack-smoke-${Date.now()}-${randomBytes(3).toString('hex')}@example.invalid`;
const password = `stack smoke ${randomBytes(9).toString('base64url')}`;
const signup = { name: 'Stack Smoke', email, password, acceptedTermsVersion: 'draft-2026-10' };

await step('mutations without the CSRF header or from another origin are rejected', async () => {
  const noHeader = await post('/v1/auth/signup', signup, { 'content-type': 'application/json', origin });
  assert.equal(noHeader.status, 403);
  assert.equal(await errorCode(noHeader), 'auth.csrf_rejected');
  const crossSite = await post('/v1/auth/signup', signup, { ...mutation(), origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal(await errorCode(crossSite), 'auth.csrf_rejected');
});

await step('sign-up through the proxy is accepted without creating a session', async () => {
  const response = await post('/v1/auth/signup', signup);
  assert.equal(response.status, 202);
  assert.equal(sessionCookie(response), null);
  const early = await post('/v1/auth/login', { email, password });
  assert.equal(early.status, 401, 'no login before e-mail verification');
});

let token = null;
await step('the verification token arrives in the fake mailbox (API log)', async () => {
  const deadline = Date.now() + 15_000;
  while (!token) {
    const logs = run(['logs', '--no-color', '--no-log-prefix', 'api']).stdout ?? '';
    const line = logs.split('\n').reverse().find((l) => l.includes('[mail:verify_email]') && l.includes(`to=${email} `));
    if (line) token = JSON.parse(line.slice(line.indexOf('{'))).token;
    else if (Date.now() > deadline) throw new Error('no verification mail for the smoke address in the API log');
    else await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(typeof token === 'string' && token.length > 10);
});

await step('e-mail verification through the proxy', async () => {
  const response = await post('/v1/auth/verify-email', { token });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'verified');
});

let cookie = null;
await step('login through the proxy sets a __Host- session cookie for the same origin', async () => {
  const response = await post('/v1/auth/login', { email, password });
  assert.equal(response.status, 200);
  cookie = sessionCookie(response);
  assert.ok(cookie, 'login returns the session cookie');
  const raw = response.headers.getSetCookie().find((c) => c.startsWith('__Host-sr_session='));
  assert.match(raw, /;\s*Secure/i);
  assert.match(raw, /;\s*HttpOnly/i);
  assert.match(raw, /;\s*Path=\//i);
  assert.doesNotMatch(raw, /Domain=/i, '__Host- cookies carry no Domain');
});

await step('the session works on /v1/me and logout ends it', async () => {
  const me = await get('/v1/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(JSON.stringify(await me.json()).includes(email), true);
  const logout = await post('/v1/auth/logout', {}, mutation(cookie));
  assert.equal(logout.status, 204);
  const after = await get('/v1/me', { cookie });
  assert.equal(after.status, 401);
});

await step('long-running services are healthy, the migrate job exited 0', async () => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const ps = run(['ps', '--all', '--format', 'json']);
    assert.equal(ps.status, 0, ps.stderr);
    const rows = ps.stdout.trim().split('\n').filter(Boolean).flatMap((line) => { const v = JSON.parse(line); return Array.isArray(v) ? v : [v]; });
    const byService = Object.fromEntries(rows.map((row) => [row.Service, row]));
    assert.equal(byService.migrate?.State, 'exited');
    assert.equal(byService.migrate?.ExitCode, 0);
    const pending = ['api', 'worker', 'web', 'proxy'].filter((service) => byService[service]?.State !== 'running' || byService[service]?.Health !== 'healthy');
    if (pending.length === 0) return;
    // A container may still be in its health-check start period; anything else is a failure.
    for (const service of pending) assert.ok(byService[service]?.State === 'running' && byService[service]?.Health === 'starting', `${service}: ${byService[service]?.State}/${byService[service]?.Health}`);
    if (Date.now() > deadline) throw new Error(`not healthy within 90 s: ${pending.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
});

await step('every application container runs as uid 1000, not root', async () => {
  for (const service of ['api', 'worker', 'web', 'proxy']) {
    const id = run(['exec', '-T', service, 'id', '-u']);
    assert.equal(id.status, 0, id.stderr);
    assert.equal(id.stdout.trim(), '1000', `${service} uid`);
  }
});

await step('the migrate job refuses the API runtime role (exit 3)', async () => {
  const apiUrl = execFileSync(composeBin, [...composeArgs, 'exec', '-T', 'api', 'printenv', 'API_DATABASE_URL'], { encoding: 'utf8' }).trim();
  const refused = run(['run', '--rm', '--no-deps', '-e', `DATABASE_URL=${apiUrl}`, 'migrate']);
  assert.equal(refused.status, 3, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.stderr, /refused: the database login is a member of trustwork_app/);
});

await step('the API image refuses NODE_ENV=production with an http origin and no flow secret (exit 78)', async () => {
  const refused = run(['run', '--rm', '--no-deps', '-e', 'NODE_ENV=production', '-e', 'AUTH_PROVIDER_MODE=disabled', 'api']);
  assert.equal(refused.status, 78, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.stdout, /config\.invalid/);
  assert.match(refused.stdout, /AUTH_FLOW_SECRET/);
  assert.doesNotMatch(refused.stdout, /local_only_stack/, 'configuration errors never print values');
});

console.log(`stack smoke passed: ${results.length} checks on ${origin}`);
