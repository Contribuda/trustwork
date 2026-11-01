import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { AccountServiceActionSchema, SESSION_COOKIE, SupportAccountSummarySchema } from '@trustwork/contracts';
import { Client, SKIP_REASON, startHarness, type Response } from '../backend/helpers/app.js';
import { PASSWORD, signIn, enrolNow } from '../admin/helpers.js';
import { SupportAccountCardSchema } from '../../apps/api/src/modules/support/views.js';
import { AccessExplanationSchema } from '../../apps/api/src/modules/support/explainer.js';
import { backdate, buildSupportWorld, command, count, emailOf, expectRefusal, participation, query, type SupportWorld } from './helpers.js';

const h = await startHarness('support_api');

type Body = Record<string, unknown>;
const body = (r: Response) => r.body as Body;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * SUP-001 on real PostgreSQL under the runtime role, through the HTTP API with real sessions, TOTP enrolment and
 * elevated sessions: the support case paths, recorded lookups, the allowlisted account card (leak probes), servicing
 * actions (immediate ones, and the sign-in factor changes with evidence, a second person bound to the request digest
 * and a 72-hour cooling-off on the database clock, announced on every verified channel), the access explainer (reason
 * codes only), diagnostic snapshots shared by the person, and the absence of any impersonation path.
 */
test('support workspace API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: SupportWorld = await buildSupportWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const S = '/v1/admin/support';
  const sessionsOf = (personId: string) => count(h, 'SELECT 1 FROM trustwork.session WHERE person_id = $1', [personId]);
  const notices = async (key: keyof typeof p, event: string) => (await w.mail.to(emailOf(key), 'security_notice')).filter((m) => m.params.event === event).length;
  const stepUp = async (client: Client) => assert.equal((await client.post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);

  // The customer opens a case about themselves (the participant path).
  const opened = await c.customer.post('/v1/support/cases', { hubId: w.world.hubId, category: 'account_access', summary: 'Synthetic: I lost the mailbox of my former employer' });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const caseId = (body(opened).case as { id: string }).id;
  assert.deepEqual(Object.keys(body(opened).case as Body).sort(), ['category', 'closedAt', 'forCompany', 'id', 'number', 'openedAt', 'resolvedAt', 'status', 'summary']);

  await t.test('negative: anonymous, participants, other-hub staff and unelevated staff never reach a staff route', async () => {
    expectRefusal(await new Client(w.app).get(`${S}/cases`), 401, 'auth.session_invalid');
    expectRefusal(await c.customer.get(`${S}/cases`), 403, 'access.forbidden', 'staff');
    expectRefusal(await query(c.customer, `${S}/lookup`, { hubId: w.world.hubId, kind: 'email', value: emailOf('employee') }), 403, 'access.forbidden', 'staff');
    expectRefusal(await c.otherAgent.get(`${S}/cases`), 403, 'access.forbidden', 'staff');
    expectRefusal(await query(c.agent, `${S}/cases/${caseId}/people/${p.customer}/account`), 403, 'access.forbidden', 'elevation');
    expectRefusal(await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'revoke_all_sessions' }), 403, 'access.forbidden', 'elevation');
  });

  await w.elevateAll();

  await t.test('cases: staff see the hub queue; notes reach the requester without staff identities; conflicts are refused', async () => {
    const queue = body(await c.agent.get(`${S}/cases`)).cases as Array<{ id: string }>;
    assert.ok(queue.some((x) => x.id === caseId));
    // Staff without a support permission see no case.
    assert.deepEqual(body(await c.moderator.get(`${S}/cases`)).cases, []);
    expectRefusal(await c.moderator.get(`${S}/cases/${caseId}`), 404, 'access.not_found');
    assert.equal((await command(c.agent, `${S}/cases/${caseId}/notes`, { body: 'Synthetic internal triage note', visibility: 'internal' })).status, 201);
    assert.equal((await command(c.agent, `${S}/cases/${caseId}/notes`, { body: 'Synthetic: we are checking your identity', visibility: 'requester' })).status, 201);
    assert.equal((await command(c.lead, `${S}/cases/${caseId}/update`, { status: 'triaged', assignedTo: p.agent })).status, 200);
    const own = body(await c.customer.get(`/v1/support/cases/${caseId}`));
    assert.deepEqual((own.notes as Array<Body>).map((n) => ({ fromSupport: n.fromSupport, body: n.body })), [{ fromSupport: true, body: 'Synthetic: we are checking your identity' }]);
    assert.ok(!JSON.stringify(own).includes(p.agent), 'no staff identity reaches the requester');
    assert.equal((await c.customer.post(`/v1/support/cases/${caseId}/notes`, { body: 'Synthetic reply from the requester' })).status, 201);
    // Another person never reaches the case.
    expectRefusal(await c.outsider.get(`/v1/support/cases/${caseId}`), 404, 'access.not_found');
    expectRefusal(await c.outsider.post(`/v1/support/cases/${caseId}/notes`, { body: 'Synthetic intrusion' }), 404, 'access.not_found');
    // The agent is a member of the company: a company case is a conflict of interest for them, and nobody handles their own case.
    const company = await c.employee.post('/v1/support/cases', { hubId: w.world.hubId, forCompany: true, category: 'billing_question', summary: 'Synthetic: invoice question' });
    assert.equal(company.status, 201, JSON.stringify(company.body));
    const companyCaseId = (body(company).case as { id: string }).id;
    expectRefusal(await query(c.agent, `${S}/cases/${companyCaseId}/people/${p.employee}/account`), 403, 'access.forbidden', 'conflict_of_interest');
    expectRefusal(await command(c.agent, `${S}/cases`, { hubId: w.world.hubId, requesterPersonId: p.agent, subject: { kind: 'person', id: p.agent }, category: 'account_access', summary: 'Synthetic self' }), 403, 'access.forbidden', 'conflict_of_interest');
    const onBehalf = await command(c.agent, `${S}/cases`, { hubId: w.world.hubId, requesterPersonId: p.outsider, subject: { kind: 'person', id: p.outsider }, category: 'account_access', summary: 'Synthetic: called the hotline' });
    assert.equal(onBehalf.status, 201, JSON.stringify(onBehalf.body));
  });

  await t.test('lookup: exact e-mail and ids without a case, names only inside one; recorded as a hash, never the query', async () => {
    const found = await query(c.agent, `${S}/lookup`, { hubId: w.world.hubId, kind: 'email', value: emailOf('customer').toUpperCase() });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual(body(found).results, [{ kind: 'person', id: p.customer, displayName: 'Synthetic Customer' }]);
    assert.deepEqual(body(await query(c.agent, `${S}/lookup`, { hubId: w.world.hubId, kind: 'email', value: 'nobody@example.invalid' })).results, []);
    expectRefusal(await query(c.agent, `${S}/lookup`, { hubId: w.world.hubId, kind: 'name', value: 'Synthetic' }), 422, 'validation.schema', 'case_required');
    const byName = body(await query(c.agent, `${S}/lookup`, { hubId: w.world.hubId, caseId, kind: 'name', value: 'Synthetic Cust' })).results as Array<Body>;
    assert.deepEqual(byName.map((r) => r.id), [p.customer]);
    // A name prefix is never a pattern: % and _ match literally.
    assert.deepEqual(body(await query(c.agent, `${S}/lookup`, { hubId: w.world.hubId, caseId, kind: 'name', value: '%' })).results, []);
    assert.deepEqual((body(await query(c.agent, `${S}/lookup`, { hubId: w.world.hubId, kind: 'company_id', value: w.world.company })).results as Body[]).map((r) => r.displayName), ['Synthetic Builders LLC']);
    expectRefusal(await query(c.moderator, `${S}/lookup`, { hubId: w.world.hubId, kind: 'email', value: emailOf('customer') }), 403, 'access.forbidden', 'forbidden');
    const records = await h.db.admin.query('SELECT row_to_json(r)::text AS j, r.query_digest FROM trustwork.support_access_record r WHERE r.kind = $1 AND r.actor_person_id = $2', ['lookup', p.agent]);
    assert.ok(records.rows.length >= 5);
    for (const row of records.rows as Array<{ j: string; query_digest: string }>) {
      assert.match(row.query_digest, /^[a-f0-9]{64}$/);
      assert.ok(!row.j.includes('example.invalid') && !row.j.includes('Synthetic Cust'), 'the query itself is never stored');
    }
  });

  await t.test('account card: only allowlisted fields (strict schema, leak probes), recorded and visible to the person as "support looked"', async () => {
    await withMaintenance(h.db.admin, async (trx) => {
      // A billing account with a tax registration exists, but billing tables stay closed to the support module (payment neutrality).
      const offer = await trx.insertInto('offer').values({ hub_id: w.world.hubId, code: 'basic_free', name: 'Synthetic basic', kind: 'plan', status: 'active', created_by: w.world.people.owner }).returning('id').executeTakeFirstOrThrow();
      const account = await trx.insertInto('billing_account').values({ hub_id: w.world.hubId, owner_person_id: p.customer, currency: 'USD', created_by: p.customer, tax_registration_id: 'SYNTHETIC-TAX-0001' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('entitlement').values({ billing_account_id: account.id, offer_id: offer.id, valid_from: new Date(Date.now() - 86_400_000), source: 'free_basic', limits: JSON.stringify({ agentRuns: 30 }) }).execute();
      await trx.insertInto('consent_record').values({ subject_person_id: p.customer, purpose: 'marketing', notice_version: 'marketing.v1', evidence: JSON.stringify({ method: 'first_party_form', requestId: 'req-synthetic-1' }) }).execute();
    });
    const sessionsBefore = await sessionsOf(p.customer);
    const response = await query(c.agent, `${S}/cases/${caseId}/people/${p.customer}/account`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers['set-cookie'], undefined);
    const card = body(response).account as Body;
    SupportAccountCardSchema.parse(card);
    SupportAccountSummarySchema.parse(card); // the customer has a name and an address: the frozen contract itself holds
    assert.deepEqual(Object.keys(card).sort(), Object.keys(SupportAccountSummarySchema.shape).sort());
    assert.equal(card.maskedEmail, 'su***@example.invalid');
    assert.equal(card.accountState, 'active');
    assert.equal(card.emailVerified, true);
    assert.deepEqual(card.secondFactor, { enrolled: false, methods: 0 });
    // Entitlements come from billing through a port; no billing read for staff exists yet, so the card says so.
    assert.deepEqual(card.entitlements, []);
    assert.equal(body(response).entitlementsAvailable, false);
    assert.deepEqual((card.consents as Body[]).map((x) => [x.kind, x.version, x.state]), [['marketing', 'marketing.v1', 'given']]);
    assert.equal(card.openCases, 1);
    const text = JSON.stringify(body(response));
    for (const probe of [emailOf('customer'), 'argon2', '127.0.0', 'trustwork-test', 'SYNTHETIC-TAX', 'agentRuns', 'req-synthetic-1', 'token', 'password', 'ip_prefix', 'user_agent']) {
      assert.ok(!text.includes(probe), `the card leaks ${probe}`);
    }
    assert.equal(await sessionsOf(p.customer), sessionsBefore, 'reading the card creates no session');
    // A person who is not a party of the case is refused.
    expectRefusal(await query(c.agent, `${S}/cases/${caseId}/people/${p.outsider}/account`), 422, 'validation.schema', 'case_mismatch');
    const seen = body(await c.customer.get('/v1/support/access')).records as Body[];
    assert.ok(seen.some((r) => r.kind === 'account_card' && r.supportCaseId === caseId));
    assert.ok(!JSON.stringify(seen).includes(p.agent), 'the person sees that support looked, never who');
  });

  const R = { revoked: randomUUID(), expired: randomUUID(), capability: randomUUID(), none: randomUUID(), ended: randomUUID(), allowed: randomUUID() };
  await t.test('access explainer: reason codes only, never an id or a value', async () => {
    const owner = { kind: 'company' as const, id: w.world.company };
    const formerEmployer = await withMaintenance(h.db.admin, async (trx) => {
      const company = await trx.insertInto('company').values({ display_name: 'Synthetic Former Employer LLC', claim_status: 'unclaimed' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('membership').values({ person_id: p.customer, company_id: company.id, role: 'member', permissions: ['company.deals.manage'], status: 'ended', valid_from: new Date('2026-09-01T09:00:00Z'),
        ended_at: new Date('2026-10-01T09:00:00Z'), ended_by: p.employee, ended_reason: 'Synthetic: left the company' }).execute();
      return company.id;
    });
    for (const id of Object.values(R)) await participation(h, { resourceId: id, party: owner, side: 'owner', capabilities: ['read.owner_private', 'read.shared', 'manage_participants'], audience: 'owner_private', grantedBy: p.employee });
    const customer = { kind: 'person' as const, id: p.customer };
    await participation(h, { resourceId: R.revoked, party: customer, side: 'participant', capabilities: ['read.shared'], revoked: true, grantedBy: p.employee });
    await participation(h, { resourceId: R.expired, party: customer, side: 'participant', capabilities: ['read.shared'], validFrom: new Date(Date.now() - 2 * 86_400_000), validUntil: new Date(Date.now() - 86_400_000), grantedBy: p.employee });
    await participation(h, { resourceId: R.capability, party: customer, side: 'participant', capabilities: ['read.shared'], grantedBy: p.employee });
    await participation(h, { resourceId: R.ended, party: { kind: 'company', id: formerEmployer }, side: 'buyer', capabilities: ['read.shared'], grantedBy: p.employee });
    await participation(h, { resourceId: R.allowed, party: customer, side: 'participant', capabilities: ['read.shared'], grantedBy: p.employee });
    const explain = async (resourceId: string, capability?: string) => {
      const r = await query(c.agent, `${S}/cases/${caseId}/explain`, { subjectPersonId: p.customer, resource: { kind: 'project', id: resourceId }, ...(capability ? { capability } : {}) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const explanation = body(r).explanation as Body;
      AccessExplanationSchema.parse(explanation);
      assert.ok(!UUID.test(JSON.stringify(body(r))), `no id in ${JSON.stringify(body(r))}`);
      assert.ok(!JSON.stringify(body(r)).includes('Synthetic'), 'no name');
      return explanation;
    };
    assert.deepEqual(await explain(R.revoked), { effect: 'deny', capability: 'read.shared', reason: 'participation_revoked', disclose: 'not_found' });
    assert.deepEqual(await explain(R.expired), { effect: 'deny', capability: 'read.shared', reason: 'participation_expired', disclose: 'forbidden' });
    assert.deepEqual(await explain(R.capability, 'negotiate'), { effect: 'deny', capability: 'negotiate', reason: 'capability_missing', disclose: 'forbidden' });
    assert.deepEqual(await explain(R.none), { effect: 'deny', capability: 'read.shared', reason: 'no_participation', disclose: 'not_found' });
    assert.deepEqual(await explain(R.ended), { effect: 'deny', capability: 'read.shared', reason: 'membership_ended', disclose: 'not_found' });
    assert.deepEqual(await explain(R.allowed), { effect: 'allow', capability: 'read.shared', projection: 'shared_party', basis: ['participation'] });
    expectRefusal(await query(c.agent, `${S}/cases/${caseId}/explain`, { subjectPersonId: p.customer, resource: { kind: 'project', id: R.allowed }, capability: 'staff.case_read' }), 422, 'validation.schema');
    expectRefusal(await query(c.moderator, `${S}/cases/${caseId}/explain`, { subjectPersonId: p.customer, resource: { kind: 'project', id: R.allowed } }), 403, 'access.forbidden', 'forbidden');
    assert.ok(await count(h, "SELECT 1 FROM trustwork.support_access_record WHERE kind = 'access_explainer' AND support_case_id = $1", [caseId]) >= 6);
  });

  await t.test('diagnostic snapshots: shared by the person from their own session, only objects they take part in', async () => {
    const shared = await c.customer.post(`/v1/support/cases/${caseId}/diagnostics`, {
      pageId: 'app/projects/detail', appVersion: '0.9.0+synthetic', locale: 'en-US', featureFlags: ['ui.dense_tables'], errorCodes: ['access.not_found'], requestIds: ['req-synthetic-42'],
      objects: [{ type: 'project', id: R.allowed }],
    });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    expectRefusal(await c.customer.post(`/v1/support/cases/${caseId}/diagnostics`, { pageId: 'app/home', appVersion: '0.9.0', objects: [{ type: 'project', id: R.none }] }), 404, 'access.not_found');
    expectRefusal(await c.customer.post(`/v1/support/cases/${caseId}/diagnostics`, { pageId: 'app/home', appVersion: '0.9.0', screenshot: 'data:' }), 422, 'validation.unknown_field');
    expectRefusal(await c.outsider.post(`/v1/support/cases/${caseId}/diagnostics`, { pageId: 'app/home', appVersion: '0.9.0' }), 404, 'access.not_found');
    const detail = body(await c.agent.get(`${S}/cases/${caseId}`));
    const snapshots = detail.snapshots as Body[];
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0]!.objects, [{ type: 'project', id: R.allowed }]);
  });

  await t.test('immediate servicing: sessions, password, lockout, verification resend and guided task; every verified channel told', async () => {
    // Sessions: the person is signed out everywhere; nobody gets a session in their place.
    const before = await sessionsOf(p.customer);
    const revoked = await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'revoke_all_sessions' });
    assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
    assert.equal(revoked.headers['set-cookie'], undefined);
    const record = (body(revoked).action as { record: unknown }).record;
    assert.equal(AccountServiceActionSchema.parse(record).state, 'done');
    assert.equal(await sessionsOf(p.customer), before, 'no session row was created');
    assert.equal(await count(h, 'SELECT 1 FROM trustwork.session WHERE person_id = $1 AND revoked_at IS NULL', [p.customer]), 0);
    expectRefusal(await c.customer.get('/v1/me'), 401, 'auth.session_invalid');
    assert.equal(await notices('customer', 'sessions_revoked_by_support'), 1);
    await signIn(c.customer, emailOf('customer'));

    // Lockout: failed attempts are cleared.
    await h.db.admin.query("INSERT INTO trustwork.login_failure (subject_hash, expires_at) SELECT sha256(convert_to('account:' || $1::text, 'UTF8')), now() + interval '1 hour' FROM generate_series(1, 3)", [emailOf('customer')]);
    assert.equal((await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'unlock_after_lockout' })).status, 201);
    assert.equal(await count(h, "SELECT 1 FROM trustwork.login_failure WHERE subject_hash = sha256(convert_to('account:' || $1::text, 'UTF8'))", [emailOf('customer')]), 0);
    assert.equal(await notices('customer', 'account_unlocked'), 1);

    // Guided task: the person performs it in their own session; they see it on their account.
    assert.equal((await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'send_guided_task', taskCode: 'reinvite_colleague' })).status, 201);
    expectRefusal(await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'send_guided_task' }), 422, 'validation.schema');
    const mine = body(await c.customer.get('/v1/support/actions')).actions as Body[];
    assert.ok(mine.some((a) => a.action === 'send_guided_task' && a.guidedTask === 'reinvite_colleague' && a.state === 'done'));
    assert.ok(!JSON.stringify(mine).includes(p.agent), 'no staff identity on the person\'s own list');

    // Data export waits for the privacy officer.
    const exported = await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'start_data_export' });
    assert.equal((body(exported).action as Body).state, 'pending');

    // Verification resend: only to the unverified address on file, rate-limited.
    expectRefusal(await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'resend_verification' }), 409, 'validation.revision_conflict', 'nothing_to_verify');
    const pending = await withMaintenance(h.db.admin, async (trx) => {
      const person = await trx.insertInto('person').values({ display_name: 'Synthetic Unverified Person' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('email_binding').values({ person_id: person.id, email_normalized: 'support-unverified@example.invalid', is_primary: true }).execute();
      return person.id;
    });
    const pendingCase = await command(c.agent, `${S}/cases`, { hubId: w.world.hubId, requesterPersonId: pending, subject: { kind: 'person', id: pending }, category: 'account_access', summary: 'Synthetic: no verification mail' });
    const pendingCaseId = (body(pendingCase).case as { id: string }).id;
    const resent = await command(c.agent, `${S}/cases/${pendingCaseId}/actions`, { subjectPersonId: pending, action: 'resend_verification' });
    assert.equal(resent.status, 201, JSON.stringify(resent.body));
    const mail = await w.mail.lastTo('support-unverified@example.invalid', 'verify_email');
    assert.ok(mail?.params.token, 'a verification link to the address on file');
    expectRefusal(await command(c.agent, `${S}/cases/${pendingCaseId}/actions`, { subjectPersonId: pending, action: 'resend_verification' }), 409, 'validation.revision_conflict', 'rate_limited');

    // Password reset required: password sign-in stops working until the person resets it from their mailbox.
    const outsiderCase = await c.outsider.post('/v1/support/cases', { hubId: w.world.hubId, category: 'account_access', summary: 'Synthetic: suspicious sign-ins' });
    const outsiderCaseId = (body(outsiderCase).case as { id: string }).id;
    assert.equal((await command(c.agent, `${S}/cases/${outsiderCaseId}/actions`, { subjectPersonId: p.outsider, action: 'require_password_reset' })).status, 201);
    expectRefusal(await new Client(w.app).post('/v1/auth/login', { email: emailOf('outsider'), password: PASSWORD }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    expectRefusal(await c.outsider.get('/v1/me'), 401, 'auth.session_invalid');
    assert.equal(await notices('outsider', 'password_reset_required'), 1);
  });

  await t.test('negative: staff never service their own account and only parties of the case are subjects', async () => {
    const own = await c.agent.post('/v1/support/cases', { hubId: w.world.hubId, category: 'account_access', summary: 'Synthetic: my own account' });
    const ownId = (body(own).case as { id: string }).id;
    expectRefusal(await command(c.agent, `${S}/cases/${ownId}/actions`, { subjectPersonId: p.agent, action: 'revoke_all_sessions' }), 403, 'access.forbidden', 'conflict_of_interest');
    expectRefusal(await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.agent, action: 'revoke_all_sessions' }), 422, 'validation.schema', 'case_mismatch');
    expectRefusal(await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.outsider, action: 'revoke_all_sessions' }), 422, 'validation.schema', 'case_mismatch');
    expectRefusal(await command(c.moderator, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'revoke_all_sessions' }), 403, 'access.forbidden', 'forbidden');
  });

  const NEW_EMAIL = 'support-customer-private@example.invalid';
  let rebindId = '';
  await t.test('recovery e-mail rebind: evidence, a second person bound to the digest, 72 hours on the database clock, every verified channel told', async () => {
    const url = `${S}/cases/${caseId}/actions`;
    expectRefusal(await command(c.agent, url, { subjectPersonId: p.customer, action: 'rebind_recovery_email', newEmail: NEW_EMAIL }), 422, 'validation.schema', 'evidence_required');
    expectRefusal(await command(c.agent, url, { subjectPersonId: p.customer, action: 'rebind_recovery_email', newEmail: emailOf('employee'), evidenceRefs: [randomUUID()] }), 422, 'validation.schema', 'address_unavailable');
    const evidence = [randomUUID(), randomUUID()];
    // Concurrency: two simultaneous requests of the same change for the same person; exactly one opens.
    const raced = await Promise.all([1, 2].map(() => command(c.agent, url, { subjectPersonId: p.customer, action: 'rebind_recovery_email', newEmail: NEW_EMAIL, evidenceRefs: evidence })));
    assert.deepEqual(raced.map((r) => r.status).sort(), [201, 409], JSON.stringify(raced.map((r) => r.body)));
    const requested = raced.find((r) => r.status === 201) as Response;
    const view = body(requested).action as Body;
    rebindId = view.id as string;
    assert.equal(view.state, 'pending');
    assert.equal(view.record, null, 'not yet an AccountServiceAction: no second person');
    assert.equal(view.newEmailMasked, 'su***@example.invalid');
    assert.ok(!JSON.stringify(body(requested)).includes(NEW_EMAIL), 'the new address never comes back in clear');
    assert.equal(await notices('customer', 'recovery_email_rebind_requested'), 1);
    const approvalId = view.approvalId as string;
    const digest = view.requestDigest as string;

    expectRefusal(await command(c.agent, `${S}/actions/${rebindId}/activate`), 403, 'access.approval_required');
    expectRefusal(await command(c.agent, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: digest }), 403, 'access.second_approver_required', 'self_approval');
    expectRefusal(await command(c.lead, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: 'f'.repeat(64) }), 409, 'access.approval_digest_mismatch');
    // Concurrency: two leads approve at once; exactly one decision wins.
    const approvals = await Promise.all([c.lead, c.lead2].map((client) => command(client, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: digest })));
    // ADM-001 answers the loser with a revision conflict, or "not found" once the decided request is no longer in its queue.
    assert.equal(approvals.filter((r) => r.status === 200).length, 1, JSON.stringify(approvals.map((r) => r.body)));
    assert.ok(approvals.some((r) => r.status === 409 || r.status === 404), JSON.stringify(approvals.map((r) => r.body)));
    const approver = approvals[0]!.status === 200 ? p.lead : p.lead2;
    expectRefusal(await command(approver === p.lead ? c.lead : c.lead2, `${S}/actions/${rebindId}/activate`), 403, 'access.forbidden', 'not_requester');
    // Concurrency: the requester activates twice at once; one cooling-off starts.
    const activated = await Promise.all([1, 2].map(() => command(c.agent, `${S}/actions/${rebindId}/activate`)));
    assert.deepEqual(activated.map((r) => r.status).sort(), [200, 409], JSON.stringify(activated.map((r) => r.body)));
    const cooling = body(activated.find((r) => r.status === 200) as Response).action as Body;
    assert.equal(cooling.state, 'cooling_off');
    assert.equal(cooling.approvedBy, approver);
    const contract = AccountServiceActionSchema.parse(cooling.record);
    assert.ok(Date.parse(contract.effectiveAt) - Date.parse(contract.requestedAt) >= 72 * 3_600_000);
    assert.equal(await notices('customer', 'recovery_email_rebind_approved'), 1);
    assert.equal(await count(h, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'support.rebind_recovery_email' AND object_id = $1 AND second_approver_person_id = $2", [rebindId, approver]), 1);

    // Not before 72 hours: the API clock cannot shorten the database clock.
    expectRefusal(await command(c.agent, `${S}/actions/${rebindId}/execute`), 403, 'access.forbidden', 'cooling_off');
    assert.equal(await count(h, "SELECT 1 FROM trustwork.auth_token WHERE kind = 'email_change' AND email_normalized = $1", [NEW_EMAIL]), 0);

    await backdate(h, rebindId);
    expectRefusal(await command(c.employee, `${S}/actions/${rebindId}/execute`), 403, 'access.forbidden', 'staff');
    const done = await command(approver === p.lead ? c.lead : c.lead2, `${S}/actions/${rebindId}/execute`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((body(done).action as Body).state, 'done');
    assert.equal(await notices('customer', 'recovery_email_rebind_completed'), 1);
    // The new address is bound only when the person proves the mailbox; that proof is theirs, not staff's.
    const proof = await w.mail.lastTo(NEW_EMAIL, 'email_change');
    assert.ok(proof?.params.token, 'a proof link to the new address');
    assert.equal(await count(h, 'SELECT 1 FROM trustwork.email_binding WHERE email_normalized = $1', [NEW_EMAIL]), 0);
    const verified = await new Client(w.app).post('/v1/auth/verify-email', { token: proof.params.token }, { idempotencyKey: null });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(await count(h, 'SELECT 1 FROM trustwork.email_binding WHERE email_normalized = $1 AND person_id = $2 AND is_primary AND verified_at IS NOT NULL', [NEW_EMAIL, p.customer]), 1);
  });

  await t.test('the person cancels a pending sign-in factor change from their own account', async () => {
    await signIn(c.customer, NEW_EMAIL);
    const requested = await command(c.agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: p.customer, action: 'rebind_recovery_email', newEmail: 'support-customer-third@example.invalid', evidenceRefs: [randomUUID()] });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const id = (body(requested).action as { id: string }).id;
    const mine = body(await c.customer.get('/v1/support/actions')).actions as Body[];
    assert.deepEqual(mine.find((a) => a.id === id) && { cancellable: mine.find((a) => a.id === id)!.cancellable, state: mine.find((a) => a.id === id)!.state }, { cancellable: true, state: 'pending' });
    await stepUp(c.customer);
    await stepUp(c.employee);
    expectRefusal(await c.employee.post(`/v1/support/actions/${id}/cancel`), 404, 'access.not_found');
    const cancelled = await c.customer.post(`/v1/support/actions/${id}/cancel`);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((body(cancelled).action as Body).state, 'cancelled');
    assert.equal(await count(h, "SELECT 1 FROM trustwork.second_person_approval a JOIN trustwork.account_service_action s ON s.approval_id = a.id WHERE s.id = $1 AND a.status = 'revoked'", [id]), 1);
    assert.equal(await notices('customer', 'recovery_email_rebind_cancelled'), 1);
    assert.equal((await w.mail.to(NEW_EMAIL, 'security_notice')).filter((m) => m.params.event === 'recovery_email_rebind_cancelled').length, 1, 'every verified address is told');
  });

  await t.test('second-factor reset: reuses BE-004 with a case, evidence, a second person and the cooling-off; the subject can stop it', async () => {
    await signIn(c.customer, NEW_EMAIL);
    await enrolNow(h, c.customer);
    await w.elevateAll();
    const url = `${S}/cases/${caseId}/actions`;
    const run = async () => {
      const requested = await command(c.agent, url, { subjectPersonId: p.customer, action: 'reset_second_factor', evidenceRefs: [randomUUID()], reason: 'Lost authenticator; identity checked on a recorded call' });
      assert.equal(requested.status, 201, JSON.stringify(requested.body));
      const view = body(requested).action as Body;
      assert.equal((await command(c.lead, `/v1/admin/approvals/${view.approvalId as string}/approve`, { actionDigest: view.requestDigest })).status, 200);
      const activated = await command(c.agent, `${S}/actions/${view.id as string}/activate`);
      assert.equal(activated.status, 200, JSON.stringify(activated.body));
      return body(activated).action as Body;
    };
    const first = await run();
    assert.ok(first.secondFactorResetId, 'the BE-004 reset opened with the action');
    const status = body(await c.customer.get('/v1/me/second-factor')) as { pendingReset: { id: string; state: string } | null };
    assert.deepEqual(status.pendingReset && { id: status.pendingReset.id, state: status.pendingReset.state }, { id: first.secondFactorResetId, state: 'cooling_off' });
    // The subject stops it in their security settings (BE-004 route): the servicing action follows.
    await stepUp(c.customer);
    assert.equal((await c.customer.post(`/v1/me/second-factor/resets/${first.secondFactorResetId as string}/cancel`)).status, 200);
    assert.equal((body(await c.agent.get(`${S}/actions/${first.id as string}`)).action as Body).state, 'cancelled');

    const second = await run();
    await backdate(h, second.id as string);
    const sessionsBefore = await sessionsOf(p.customer);
    const done = await command(c.lead, `${S}/actions/${second.id as string}/execute`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((body(done).action as Body).state, 'done');
    assert.equal(await count(h, "SELECT 1 FROM trustwork.second_factor WHERE person_id = $1 AND state = 'active'", [p.customer]), 0);
    assert.equal(await count(h, 'SELECT 1 FROM trustwork.session WHERE person_id = $1 AND revoked_at IS NULL', [p.customer]), 0, 'every session of the subject ends');
    assert.equal(await sessionsOf(p.customer), sessionsBefore, 'and nobody gets a new one');
    assert.equal(await count(h, "SELECT 1 FROM trustwork.second_factor_reset WHERE id = $1 AND state = 'done'", [second.secondFactorResetId]), 1);
    assert.ok(await notices('customer', 'second_factor_reset_completed') >= 1);
  });

  await t.test('negative: an approver conflicted with the person cannot start the cooling-off', async () => {
    const declared = await command(c.lead2, '/v1/admin/staff/conflicts', { party: { kind: 'person', id: p.outsider } });
    assert.equal(declared.status, 201, JSON.stringify(declared.body));
    const outsiderCase = await command(c.agent, `${S}/cases`, { hubId: w.world.hubId, requesterPersonId: p.outsider, subject: { kind: 'person', id: p.outsider }, category: 'account_access', summary: 'Synthetic: lost mailbox' });
    const outsiderCaseId = (body(outsiderCase).case as { id: string }).id;
    const requested = body(await command(c.agent, `${S}/cases/${outsiderCaseId}/actions`, { subjectPersonId: p.outsider, action: 'rebind_recovery_email', newEmail: 'support-outsider-new@example.invalid', evidenceRefs: [randomUUID()] })).action as Body;
    assert.equal((await command(c.lead2, `/v1/admin/approvals/${requested.approvalId as string}/approve`, { actionDigest: requested.requestDigest })).status, 200);
    expectRefusal(await command(c.agent, `${S}/actions/${requested.id as string}/activate`), 403, 'access.forbidden', 'conflict_of_interest');
    assert.equal((await command(c.agent, `${S}/actions/${requested.id as string}/cancel`)).status, 200);
  });

  await t.test('no impersonation: no support route sets a session cookie or creates a session for anyone', async () => {
    const before = await count(h, 'SELECT 1 FROM trustwork.session');
    const staffResponses = await Promise.all([
      c.agent.get(`${S}/cases`), c.agent.get(`${S}/cases/${caseId}`), query(c.agent, `${S}/cases/${caseId}/people/${p.customer}/account`),
      query(c.agent, `${S}/lookup`, { hubId: w.world.hubId, kind: 'person_id', value: p.customer }),
    ]);
    for (const r of staffResponses) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const cookies = r.headers['set-cookie'];
      assert.ok(!cookies || !String(cookies).includes(SESSION_COOKIE), 'no session cookie');
    }
    assert.equal(await count(h, 'SELECT 1 FROM trustwork.session'), before, 'no session row was created');
  });
});
