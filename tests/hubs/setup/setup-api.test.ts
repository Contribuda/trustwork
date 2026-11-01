import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { LAUNCH_GATES } from '@trustwork/contracts';
import { FinishSetupResultSchema, SETUP_TOKEN_HEADER, SetupViewSchema, type SetupView } from '../../../packages/contracts/src/hub-setup.js';
import { createApp, type CreatedApp } from '../../../apps/api/src/app.js';
import { issueSetupToken } from '../../../apps/api/src/modules/hubs/setup/issue-token.js';
import { newSetupToken } from '../../../apps/api/src/modules/hubs/setup/token.js';
import { Client, SKIP_REASON, startHarness, type Harness, type Response } from '../../backend/helpers/app.js';
import { codeNow } from '../../backend/second-factor/helpers.js';
import { CommittedMailbox } from '../../worker/mail/helpers/committed-mailbox.js';
import { addLogins, enrolNow, expectRefusal, signIn } from '../../admin/helpers.js';
import { settle, syncKernel } from '../helpers.js';
import { ANSWERS } from './helpers.js';

const h = await startHarness('hubs_setup_api');
const FOUNDER = 'founder@example.org';
const PASSWORD_FOUNDER = 'synthetic founder password 0001';
const mailKey = randomBytes(32);

function apiFor(harness: Harness, env: Record<string, string> = {}): Promise<CreatedApp> {
  return createApp({
    env: {
      API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50',
      MAIL_SECRET_KEY: mailKey.toString('hex'), TRUSTWORK_SETUP_OPERATOR_SCREENING: 'fake', ...env,
    },
    pool: harness.pool, clock: harness.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
}

/**
 * HUB-004 through the HTTP API on real PostgreSQL under the runtime role, with the real sign-up, mailbox proof, TOTP
 * enrolment, recovery codes and elevation of BE-004: a fresh node becomes the United States reference hub as a draft.
 * Three API processes share the database and differ only in the jurisdiction gate they run (unconfigured, the stated
 * `upstream_gate`, another mode), so finishing is refused without a configured, matching gate and an attestation.
 */
test('setup wizard API: a fresh node becomes a configured draft hub', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  await syncKernel(h.db.admin);
  const unconfigured = await apiFor(h);
  const gated = await apiFor(h, { TRUSTWORK_JURISDICTION_GATE: 'upstream_gate' });
  const otherGate = await apiFor(h, { TRUSTWORK_JURISDICTION_GATE: 'edge_header', TRUSTWORK_JURISDICTION_COUNTRY_HEADER: 'X-Synthetic-Country' });
  t.after(async () => { await unconfigured.close(); await gated.close(); await otherGate.close(); await h.close(); });
  const mailbox = new CommittedMailbox(h.db.admin, mailKey);
  const count = async (query: string, params: unknown[] = []) => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]!.n;

  const { token } = await issueSetupToken(h.db.admin);
  const anonymous = new Client(unconfigured);
  const withToken = (value: string = token) => ({ headers: { [SETUP_TOKEN_HEADER.toLowerCase()]: value }, idempotencyKey: null });
  const view = (response: Response): SetupView => {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return SetupViewSchema.parse(response.body);
  };
  const save = (client: Client, step: string, answer: unknown) => client.post(`/v1/setup/steps/${step}`, answer, withToken());

  await t.test('only a valid token opens setup; the run starts at the install check', async () => {
    expectRefusal(await anonymous.get('/v1/setup'), 404, 'access.not_found');
    expectRefusal(await anonymous.get('/v1/setup', withToken('short')), 404, 'access.not_found');
    expectRefusal(await anonymous.get('/v1/setup', withToken(newSetupToken())), 404, 'access.not_found');
    const v = view(await anonymous.get('/v1/setup', withToken()));
    assert.equal(v.state.current, 'install_check');
    assert.deepEqual(v.state.completed, []);
    assert.equal(v.state.firstAdmin, null);
    const checks = Object.fromEntries(v.checks.map((c) => [c.id, `${c.state}:${c.reason}`]));
    assert.deepEqual(checks, { address: 'pass:null', database: 'pass:null', object_storage: 'warn:not_configured', worker: 'warn:no_heartbeat_source', clock: 'warn:not_measured', secret_store: 'warn:development_key' });
    assert.equal(v.attestation.state, 'missing');
    assert.deepEqual(v.attestation.launchGate, { gate: 'sanctions_screening_configured', contribution: 'open' });
  });

  await t.test('steps go in order and restricted places are refused at country, region and place level', async () => {
    expectRefusal(await save(anonymous, 'node_identity', ANSWERS.node_identity), 422, 'validation.schema', 'step_out_of_order');
    const checked = view(await save(anonymous, 'install_check', ANSWERS.install_check()));
    assert.equal(checked.checks.find((c) => c.id === 'clock')?.state, 'pass');
    assert.equal(checked.state.current, 'node_identity');

    const refused = await save(anonymous, 'node_identity', { ...ANSWERS.node_identity, jurisdiction: 'RU' });
    expectRefusal(refused, 422, 'validation.schema', 'restricted_place');
    assert.deepEqual((refused.body as { details: { items: string[] } }).details.items, ['jurisdiction:RU']);
    assert.equal(((await save(anonymous, 'node_identity', { ...ANSWERS.node_identity, extra: true })).body as { code: string }).code, 'validation.unknown_field', 'unknown fields are refused');
    view(await save(anonymous, 'node_identity', ANSWERS.node_identity));

    for (const [country, territories] of [['UA', [{ level: 'place', code: 'UA-43:simferopol' }]], ['UA', [{ level: 'region', code: 'UA-14' }]], ['CU', [{ level: 'country', code: 'CU' }]]] as const) {
      expectRefusal(await save(anonymous, 'hub_identity', { ...ANSWERS.hub_identity, country, territories }), 422, 'validation.schema', 'restricted_place');
    }
    expectRefusal(await save(anonymous, 'hub_identity', { ...ANSWERS.hub_identity, territories: [{ level: 'country', code: 'MX' }] }), 422, 'validation.schema');
    expectRefusal(await save(anonymous, 'hub_identity', { ...ANSWERS.hub_identity, timeZone: 'Mars/Olympus_Mons' }), 422, 'validation.schema', 'time_zone_unknown');
    view(await save(anonymous, 'hub_identity', ANSWERS.hub_identity));

    expectRefusal(await save(anonymous, 'operator', { ...ANSWERS.operator, hostingCountry: 'IR' }), 422, 'validation.schema', 'restricted_place');
    const region = await save(anonymous, 'operator', { ...ANSWERS.operator, hostingCountry: 'UA', hostingRegion: null });
    expectRefusal(region, 422, 'validation.schema', 'restricted_place');
    assert.ok((region.body as { details: { items: string[] } }).details.items.includes('hostingRegion:region_required'));
    const operator = view(await save(anonymous, 'operator', ANSWERS.operator));
    assert.equal(operator.operatorScreening?.basis, 'fake', 'the fake screening is labelled as such');
    assert.equal(operator.state.current, 'first_admin');
    // The run resumes from another browser with the same token.
    assert.equal(view(await new Client(unconfigured).get('/v1/setup', withToken())).state.current, 'first_admin');
  });

  const founder = new Client(unconfigured);
  let secret: Buffer = Buffer.alloc(0);
  await t.test('the founding administrator: an account verified by the mailbox proof, an authenticator app and recovery codes', async () => {
    const created = await anonymous.post('/v1/setup/first-admin/account', { name: 'Synthetic Founding Administrator', email: FOUNDER, password: PASSWORD_FOUNDER }, withToken());
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(view(await anonymous.get('/v1/setup', withToken())).adminAccount?.maskedEmail, 'fo*****@example.org');
    const verifyToken = (await mailbox.lastTo(FOUNDER, 'verify_email'))?.params.token as string;
    assert.ok(verifyToken, 'the verification mail was recorded');
    assert.equal((await founder.post('/v1/auth/verify-email', { token: verifyToken }, { idempotencyKey: null })).status, 200);

    expectRefusal(await anonymous.post('/v1/setup/first-admin', { secondFactor: 'totp', recoveryCodesStored: true }, withToken()), 401, 'auth.session_invalid');
    expectRefusal(await founder.post('/v1/setup/first-admin', { secondFactor: 'totp', recoveryCodesStored: true }, withToken()), 422, 'validation.schema', 'second_factor_required');
    expectRefusal(await founder.post('/v1/setup/first-admin', { secondFactor: 'totp', recoveryCodesStored: false }, withToken()), 422, 'validation.schema');

    // Someone else, signed in with a second factor, cannot take the founding role.
    const [outsiderId] = (await h.db.admin.query<{ id: string }>("INSERT INTO trustwork.person (display_name) VALUES ('Synthetic Outsider') RETURNING id")).rows.map((r) => r.id);
    await addLogins(h, [[outsiderId!, 'outsider@example.org']]);
    const outsider = new Client(unconfigured);
    await signIn(outsider, 'outsider@example.org');
    await enrolNow(h, outsider);
    expectRefusal(await outsider.post('/v1/setup/first-admin', { secondFactor: 'totp', recoveryCodesStored: true }, withToken()), 403, 'access.forbidden', 'admin_account_mismatch');

    h.clock.advance(30_000);
    secret = await enrolNow(h, founder);
    expectRefusal(await founder.post('/v1/setup/first-admin', { secondFactor: 'webauthn', recoveryCodesStored: true }, withToken()), 422, 'validation.schema', 'second_factor_unavailable');
    const bound = view(await founder.post('/v1/setup/first-admin', { secondFactor: 'totp', recoveryCodesStored: true }, withToken()));
    assert.equal(bound.session.isFirstAdmin, true);
    assert.equal(bound.state.firstAdmin?.secondFactor, 'totp');
    assert.ok(bound.state.completed.includes('first_admin'));
    assert.equal(await count("SELECT 1 FROM trustwork.staff_role_assignment WHERE setup_bootstrap AND role = 'node-operator' AND scope_kind = 'node'"), 1);

    // From now on the token alone (or another person) changes nothing.
    expectRefusal(await save(anonymous, 'storage_residency', ANSWERS.storage_residency), 403, 'access.forbidden', 'first_admin_only');
    expectRefusal(await save(outsider, 'storage_residency', ANSWERS.storage_residency), 403, 'access.forbidden', 'first_admin_only');
    expectRefusal(await outsider.post('/v1/setup/first-admin', { secondFactor: 'totp', recoveryCodesStored: true }, withToken()), 403, 'access.forbidden', 'first_admin_only');
  });

  await t.test('residency, providers (OpenRouter optional next to direct providers) and modes', async () => {
    expectRefusal(await save(founder, 'storage_residency', { ...ANSWERS.storage_residency, personalDataCountry: 'KP' }), 422, 'validation.schema', 'restricted_place');
    view(await save(founder, 'storage_residency', ANSWERS.storage_residency));
    expectRefusal(await save(founder, 'providers', { ...ANSWERS.providers, models: 'direct', directModelAdapter: null }), 422, 'validation.schema');
    expectRefusal(await save(founder, 'providers', { ...ANSWERS.providers, models: 'direct', directModelAdapter: 'openrouter' }), 422, 'validation.schema');
    view(await save(founder, 'providers', { ...ANSWERS.providers, models: 'direct', directModelAdapter: 'anthropic' }));
    view(await save(founder, 'providers', ANSWERS.providers));
    expectRefusal(await save(founder, 'modes', { dataMode: 'demo', modules: ['sales'] }), 422, 'validation.schema', 'modes_violation');
    const ready = view(await save(founder, 'modes', ANSWERS.modes));
    assert.equal(ready.state.current, 'review');
  });

  const elevate = async (client: Client) => {
    h.clock.advance(30_000);
    assert.equal((await client.post('/v1/auth/step-up', { password: PASSWORD_FOUNDER }, { idempotencyKey: null })).status, 200);
    const response = await client.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const finish = (client: Client) => client.post('/v1/setup/finish', { confirm: true }, withToken());

  await t.test('finishing needs an elevation, a configured jurisdiction gate matching the statement and an attestation', async () => {
    expectRefusal(await finish(anonymous), 401, 'auth.session_invalid');
    expectRefusal(await finish(founder), 403, 'access.forbidden', 'elevation');
    await elevate(founder);
    expectRefusal(await finish(founder), 422, 'validation.schema', 'jurisdiction_gate_unconfigured');
    const other = new Client(otherGate);
    other.setSessionCookie(founder.sessionCookie);
    expectRefusal(await finish(other), 422, 'validation.schema', 'jurisdiction_gate_mismatch');
    assert.equal(await count('SELECT 1 FROM trustwork.hub'), 0, 'nothing was created');
    assert.equal(await count('SELECT 1 FROM trustwork.deployment_location_attestation'), 0, 'nothing was attested');
    assert.equal(view(await founder.get('/v1/setup', withToken())).state.current, 'review', 'the run is still open');
  });

  await t.test('finishing creates the draft hub, attests the location, records configuration and invalidates the token; a simultaneous finish finds it finished', async () => {
    const a = new Client(gated);
    const b = new Client(gated);
    a.setSessionCookie(founder.sessionCookie);
    b.setSessionCookie(founder.sessionCookie);
    const [first, second] = await Promise.all([finish(a), finish(b)]);
    const results = [first, second].sort((x, y) => x.status - y.status);
    assert.equal(results[0]!.status, 200, JSON.stringify(results[0]!.body));
    expectRefusal(results[1]!, 404, 'access.not_found');
    const done = FinishSetupResultSchema.parse(results[0]!.body);
    assert.equal(done.slug, 'synthetic-us');
    assert.deepEqual(done.configVersions.map((v) => `${v.domain}:${v.status}`), ['identity:active', 'country:active', 'modes:active', 'legal:draft', 'residency:draft', 'providers:draft']);

    const hub = (await h.db.admin.query('SELECT lifecycle, pack_code FROM trustwork.hub WHERE id = $1', [done.hubId])).rows[0];
    assert.deepEqual(hub, { lifecycle: 'draft', pack_code: null });
    assert.deepEqual((await h.db.admin.query('SELECT code FROM trustwork.hub_territory WHERE hub_id = $1 ORDER BY code', [done.hubId])).rows.map((r) => r.code), ['US', 'US-CA', 'US-CA:san-diego']);
    assert.equal(await count("SELECT 1 FROM trustwork.launch_gate WHERE hub_id = $1 AND state = 'open'", [done.hubId]), LAUNCH_GATES.length, 'every gate is open');
    const modes = (await h.db.admin.query("SELECT v.payload FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id = c.version_id WHERE c.hub_id = $1 AND c.domain = 'modes'", [done.hubId])).rows[0].payload;
    assert.equal(modes.registration, 'closed');
    assert.equal(modes.searchEngineIndexing, false);
    assert.equal(modes.dataMode, 'demo');
    const providers = (await h.db.admin.query("SELECT payload, status FROM trustwork.hub_config_version WHERE hub_id = $1 AND domain = 'providers'", [done.hubId])).rows[0];
    assert.equal(providers.status, 'draft');
    assert.ok(Object.values(providers.payload.capabilities as Record<string, { mode: string }>).every((c) => c.mode === 'fake' || c.mode === 'manual'), 'every provider stays fake or manual');
    assert.equal(providers.payload.models.route, 'openrouter');
    const identity = (await h.db.admin.query("SELECT v.payload, v.source FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id = c.version_id WHERE c.hub_id = $1 AND c.domain = 'identity'", [done.hubId])).rows[0];
    assert.equal(identity.source, 'deployment_import', 'CFG-001 deployment settings are configuration version 1');
    assert.deepEqual(identity.payload.languages, { default: 'en', enabled: ['en', 'es'] });

    const attestation = (await h.db.admin.query('SELECT a.id, a.gate_mode, a.hosting_country, p.display_name FROM trustwork.deployment_location_attestation a JOIN trustwork.person p ON p.id = a.attested_by')).rows;
    assert.deepEqual(attestation.map((r) => [r.id, r.gate_mode, r.hosting_country, r.display_name]), [[done.attestationId, 'upstream_gate', 'US', 'Synthetic Founding Administrator']]);
    const audited = (await h.db.admin.query("SELECT action FROM trustwork.admin_audit_event WHERE action IN ('hub.created', 'jurisdiction.location_attested', 'hub.config_drafted', 'hub.config_activated') ORDER BY sequence")).rows.map((r) => r.action);
    assert.ok(audited.includes('hub.created') && audited.includes('jurisdiction.location_attested'), JSON.stringify(audited));

    expectRefusal(await founder.get('/v1/setup', withToken()), 404, 'access.not_found');
    expectRefusal(await finish(a), 404, 'access.not_found');
    const again = await settle(issueSetupToken(h.db.admin));
    assert.equal(again?.hint, 'setup.finished', 'no second setup can start');

    // The founding administrator continues in the console (HUB-001) with the same elevated session.
    const console = await a.get(`/v1/admin/hubs/${done.hubId}`);
    assert.equal(console.status, 200, JSON.stringify(console.body));
    assert.equal((console.body as { hub: { lifecycle: string } }).hub.lifecycle, 'draft');
    const status = await a.get('/v1/admin/jurisdiction/attestation');
    assert.equal((status.body as { launchGate: { contribution: string } }).launchGate.contribution, 'satisfied');
  });

});
