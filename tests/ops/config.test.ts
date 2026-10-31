import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { apiConfigFromEnv, ConfigError, trustProxySetting } from '../../apps/api/src/config.js';

/** OPS-001: the API refuses to boot in production without a flow secret, an https origin or with insecure cookies. */
const SECRET = 'a1'.repeat(32);
const PRODUCTION = { NODE_ENV: 'production', AUTH_FLOW_SECRET: SECRET, PUBLIC_ORIGIN: 'https://hub.example.test' };

function refusal(env: NodeJS.ProcessEnv): string[] {
  try {
    apiConfigFromEnv(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.issues;
  }
  assert.fail('configuration was accepted');
}

test('a complete production configuration is accepted and keeps the provided flow secret', () => {
  const config = apiConfigFromEnv(PRODUCTION);
  assert.equal(config.production, true);
  assert.equal(config.flowSecret.toString('hex'), SECRET);
  assert.equal(config.publicOrigin, 'https://hub.example.test');
  assert.deepEqual(config.cookies, { secure: true, hostPrefix: true });
});

test('production refuses a missing flow secret, an http origin, a missing origin, insecure cookies and fake providers', () => {
  assert.match(refusal({ ...PRODUCTION, AUTH_FLOW_SECRET: '' }).join('\n'), /AUTH_FLOW_SECRET is required/);
  assert.match(refusal({ ...PRODUCTION, PUBLIC_ORIGIN: 'http://hub.example.test' }).join('\n'), /PUBLIC_ORIGIN must use https/);
  assert.match(refusal({ ...PRODUCTION, PUBLIC_ORIGIN: undefined }).join('\n'), /PUBLIC_ORIGIN is required/);
  assert.match(refusal({ ...PRODUCTION, API_INSECURE_COOKIES: '1' }).join('\n'), /API_INSECURE_COOKIES is not allowed/);
  assert.match(refusal({ ...PRODUCTION, AUTH_PROVIDER_MODE: 'fake' }).join('\n'), /AUTH_PROVIDER_MODE=fake/);
  // Every problem is reported at once.
  assert.equal(refusal({ NODE_ENV: 'production', API_INSECURE_COOKIES: 'true' }).length, 3);
});

test('development keeps working without a secret but still validates what is set; messages never echo values', () => {
  const dev = apiConfigFromEnv({});
  assert.equal(dev.production, false);
  assert.equal(dev.flowSecret.length, 32, 'per-process key only outside production');
  assert.equal(dev.publicOrigin, 'http://127.0.0.1:3001');
  assert.equal(apiConfigFromEnv({ API_HOST: '::1' }).publicOrigin, 'http://[::1]:3001');
  const shortSecret = 'deadbeefcafe';
  const issues = refusal({ AUTH_FLOW_SECRET: shortSecret }).join('\n');
  assert.match(issues, /AUTH_FLOW_SECRET must be at least 32 bytes/);
  assert.ok(!issues.includes(shortSecret), 'the secret value is never part of the message');
  assert.match(refusal({ AUTH_FLOW_SECRET: 'not-hex-at-all' }).join('\n'), /AUTH_FLOW_SECRET must be hex/);
  assert.match(refusal({ PUBLIC_ORIGIN: 'https://hub.example.test/app' }).join('\n'), /bare origin/);
  assert.match(refusal({ API_DB_POOL_MAX: '0' }).join('\n'), /API_DB_POOL_MAX/);
  assert.match(refusal({ API_PORT: 'eighty' }).join('\n'), /API_PORT/);
  assert.match(refusal({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:pw@collector.test' }).join('\n'), /must not embed credentials/);
});

test('pool size and per-connection timeouts are configurable', () => {
  const config = apiConfigFromEnv({ API_DB_POOL_MAX: '25', API_DB_STATEMENT_TIMEOUT_MS: '1500', API_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '2500', API_DB_CONNECT_TIMEOUT_MS: '700' });
  assert.deepEqual(config.database, { poolMax: 25, statementTimeoutMs: 1500, idleInTransactionTimeoutMs: 2500, connectionTimeoutMs: 700 });
  assert.deepEqual(apiConfigFromEnv({}).database, { poolMax: 10, statementTimeoutMs: 15_000, idleInTransactionTimeoutMs: 30_000, connectionTimeoutMs: 5_000 });
});

test('proxy trust is explicit: no trust by default, a hop count or an address list, never trust-all', () => {
  assert.equal(trustProxySetting(apiConfigFromEnv({})), false);
  const hops = trustProxySetting(apiConfigFromEnv({ API_TRUSTED_PROXY_HOPS: '1' }));
  assert.equal(typeof hops, 'function');
  assert.equal((hops as (a: string, i: number) => boolean)('10.0.0.1', 0), true);
  assert.equal((hops as (a: string, i: number) => boolean)('6.6.6.6', 1), false);
  assert.deepEqual(trustProxySetting(apiConfigFromEnv({ API_TRUSTED_PROXIES: '10.0.0.0/8, fd00::/8,127.0.0.1' })), ['10.0.0.0/8', 'fd00::/8', '127.0.0.1']);
  assert.match(refusal({ API_TRUST_PROXY: '1' }).join('\n'), /API_TRUST_PROXY .* was removed/);
  assert.match(refusal({ API_TRUSTED_PROXIES: '10.0.0.0/33' }).join('\n'), /API_TRUSTED_PROXIES/);
  assert.match(refusal({ API_TRUSTED_PROXIES: 'proxy.internal' }).join('\n'), /API_TRUSTED_PROXIES/);
  assert.match(refusal({ API_TRUSTED_PROXIES: '10.0.0.1', API_TRUSTED_PROXY_HOPS: '1' }).join('\n'), /not both/);
});

async function boot(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/main.ts'], {
    // A clean environment: no database, loopback only, an ephemeral port in case the guard did not fire.
    env: { PATH: process.env.PATH ?? '', API_HOST: '127.0.0.1', API_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const [code] = (await once(child, 'exit')) as [number | null];
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test('the API process refuses to start in production: exit 78 and one config.invalid JSON line naming the variable', async () => {
  const cases: [string, NodeJS.ProcessEnv, RegExp][] = [
    ['missing flow secret', { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://hub.example.test' }, /AUTH_FLOW_SECRET is required/],
    ['http origin', { ...PRODUCTION, PUBLIC_ORIGIN: 'http://hub.example.test' }, /PUBLIC_ORIGIN must use https/],
    ['insecure cookies', { ...PRODUCTION, API_INSECURE_COOKIES: '1' }, /API_INSECURE_COOKIES is not allowed/],
  ];
  const results = await Promise.all(cases.map(([, env]) => boot(env)));
  results.forEach((result, index) => {
    const [name, , expected] = cases[index]!;
    assert.equal(result.code, 78, `${name}: exit code (stderr: ${result.stderr.slice(-500)})`);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `${name}: exactly one log line, got ${result.stdout}`);
    const record = JSON.parse(lines[0]!) as { level: string; event: string; issues: string[] };
    assert.equal(record.level, 'error');
    assert.equal(record.event, 'config.invalid');
    assert.match(record.issues.join('\n'), expected, name);
    assert.ok(!result.stdout.includes(SECRET), `${name}: the secret is never logged`);
    assert.ok(!/listening/.test(result.stdout), `${name}: never listened`);
  });
});
