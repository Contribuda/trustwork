import test from 'node:test';
import assert from 'node:assert/strict';
import { jobs } from '@trustwork/data';
import { Metrics, reconcileJob } from '../../../apps/worker/src/index.js';
import { mailSettleTask } from '../../../apps/worker/src/mail/index.js';
import { SKIP_REASON, sqlState } from '../../data/helpers/postgres.js';
import { EMAILS, login, seedPersonas } from '../../backend/helpers/personas.js';
import { tx, waitFor } from '../helpers/worker-db.js';
import { linksIn, parseMessage } from './helpers/smtp-sink.js';
import { drain, ORIGIN, signupBody, startMailStack } from './helpers/stack.js';

const stack = await startMailStack('mail_delivery');
const RU_BRAND = 'Строй Репутация';

/**
 * MAIL-001 acceptance on real PostgreSQL with the real API, the real worker (production registry) and a local SMTP
 * sink: sign-up, recovery and invitation end to end; a stalled mail server never fails or slows the request; the
 * personal data of a delivery is gone once it is final; the role boundaries of the new tables.
 */
test('MAIL-001 delivery: identity mail leaves through the outbox and the worker', { skip: stack ? false : SKIP_REASON }, async (t) => {
  if (!stack) return;
  t.after(() => stack.close());
  const seed = await seedPersonas(stack.harness);
  const { worker } = stack.worker();
  const admin = stack.env.db.admin;
  const lastMessage = (address: string) => {
    const messages = stack.sink.to(address);
    assert.ok(messages.length > 0, `no message to ${address}`);
    return parseMessage(messages.at(-1)!.raw);
  };
  const tokenFrom = (url: URL) => decodeURIComponent(url.pathname.split('/').at(-1)!);
  const email = 'new.member@example.test';
  const password = 'correct horse battery staple 42';

  await t.test('sign-up: the request only records the intent; the worker sends it in the requested language; the link verifies', async () => {
    const client = stack.client();
    const response = await client.post('/v1/auth/signup', signupBody(email), { idempotencyKey: null, headers: { 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.5' } });
    assert.equal(response.status, 202);
    assert.equal(stack.sink.to(email).length, 0, 'nothing is sent inside the request');
    const intent = (await stack.mailbox.lastTo(email, 'verify_email'))!;
    assert.equal(intent.state, 'pending');
    assert.deepEqual(intent.localePreferences, ['ru-RU', 'ru', 'en']);
    const outbox = await admin.query<{ payload: unknown }>("SELECT payload FROM trustwork.outbox_event WHERE type = 'mail.requested' AND aggregate_id = $1", [intent.id]);
    assert.deepEqual(outbox.rows.map((r) => r.payload), [{}], 'the outbox event carries the delivery id only');
    const stored = await admin.query<{ token_in_db: boolean }>('SELECT position($1::bytea IN sealed_secret) > 0 AS token_in_db FROM trustwork.mail_delivery WHERE id = $2', [Buffer.from(intent.params.token!), intent.id]);
    assert.equal(stored.rows[0]?.token_in_db, false, 'the token is sealed, never stored in clear');

    await drain(worker);
    const message = lastMessage(email);
    assert.equal(message.headers.get('content-language'), 'ru');
    assert.ok(message.subject.includes(RU_BRAND), 'Russian mail carries the Russian brand overlay');
    assert.ok(!message.text.includes('Trustwork'));
    assert.equal(message.headers.get('message-id'), `<${intent.id}@trustwork.test>`);
    const link = linksIn(message.text).find((u) => u.pathname.startsWith('/verify-email/'))!;
    assert.equal(link.origin, ORIGIN);
    assert.equal(link.searchParams.get('lang'), 'ru');
    const verified = await stack.client().post('/v1/auth/verify-email', { token: tokenFrom(link) }, { idempotencyKey: null });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const row = await admin.query('SELECT state, recipient, sealed_secret, provider_message_id FROM trustwork.mail_delivery WHERE id = $1', [intent.id]);
    assert.equal(row.rows[0].state, 'sent');
    assert.equal(row.rows[0].recipient, null, 'the address is cleared once the delivery is final');
    assert.equal(row.rows[0].sealed_secret, null, 'the sealed token is cleared once the delivery is final');
    assert.match(row.rows[0].provider_message_id, /^SINK\d+$/);
  });

  await t.test('sign-up on a bound address: identical response; the mailbox gets the "already registered" notice without a token', async () => {
    const fresh = await stack.client().post('/v1/auth/signup', signupBody('someone.else@example.test'), { idempotencyKey: null });
    const bound = await stack.client().post('/v1/auth/signup', signupBody(email), { idempotencyKey: null });
    assert.equal(bound.status, fresh.status);
    assert.deepEqual(bound.body, fresh.body);
    await drain(worker);
    const message = lastMessage(email);
    assert.ok(message.subject.includes('Trustwork'), 'no language preference: the hub default (English)');
    const links = linksIn(message.text).map((u) => u.pathname);
    assert.deepEqual(links, ['/login', '/recover']);
  });

  await t.test('recovery: the mailed link resets the password; the security notice follows; unknown addresses answer the same', async () => {
    const known = await stack.client().post('/v1/auth/recovery', { email }, { idempotencyKey: null, headers: { 'accept-language': 'en-US' } });
    const unknown = await stack.client().post('/v1/auth/recovery', { email: 'nobody.here@example.test' }, { idempotencyKey: null });
    assert.equal(known.status, 202);
    assert.deepEqual(known.body, unknown.body);
    await drain(worker);
    assert.equal(stack.sink.to('nobody.here@example.test').length, 0);
    const link = linksIn(lastMessage(email).text).find((u) => u.pathname.startsWith('/recover/'))!;
    assert.equal(link.searchParams.get('lang'), null, 'links in the hub default language carry no lang parameter');
    const newPassword = 'another correct horse battery 7';
    const reset = await stack.client().post('/v1/auth/recovery/complete', { token: tokenFrom(link), newPassword }, { idempotencyKey: null });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    await drain(worker);
    const notice = lastMessage(email);
    assert.ok(/password of your account was reset/.test(notice.text), 'password_reset security notice');
    const client = stack.client();
    assert.equal((await client.post('/v1/auth/login', { email, password: newPassword }, { idempotencyKey: null })).status, 200);
    assert.equal((await client.post('/v1/auth/login', { email, password }, { idempotencyKey: null })).status, 401);
  });

  await t.test('enumeration safety: recovery answers alike for known and unknown addresses, in comparable time', async () => {
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const time = async (fn: () => Promise<{ status: number; body: unknown }>) => {
      const started = performance.now();
      const response = await fn();
      return { ms: performance.now() - started, response };
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const a = await time(() => stack.client().post('/v1/auth/recovery', { email: EMAILS.anna }, { idempotencyKey: null }));
      const b = await time(() => stack.client().post('/v1/auth/recovery', { email: `unknown.${i}@example.test` }, { idempotencyKey: null }));
      assert.equal(a.response.status, b.response.status);
      assert.deepEqual(a.response.body, b.response.body);
      known.push(a.ms);
      unknown.push(b.ms);
    }
    assert.ok(Math.abs(median(known) - median(unknown)) < 75, `recovery medians: known ${median(known).toFixed(1)} ms, unknown ${median(unknown).toFixed(1)} ms`);
    await drain(worker);
  });

  await t.test('invitation: the mailed link carries the membership and the token; the invitee accepts', async () => {
    const carl = stack.client();
    await login(carl, 'carl');
    const invite = await carl.post(`/v1/companies/${seed.companies.unrelated}/memberships`, { companyId: seed.companies.unrelated, inviteeEmail: email, role: 'member', permissions: [] });
    assert.equal(invite.status, 202, JSON.stringify(invite.body));
    await drain(worker);
    const message = lastMessage(email);
    const company = (await admin.query<{ display_name: string }>('SELECT display_name FROM trustwork.company WHERE id = $1', [seed.companies.unrelated])).rows[0]!.display_name;
    assert.ok(message.subject.includes(company), 'the invitation names the company');
    const link = linksIn(message.text).find((u) => u.pathname.startsWith('/invitations/'))!;
    const [, , membershipId, token] = link.pathname.split('/');
    const invitee = stack.client();
    assert.equal((await invitee.post('/v1/auth/login', { email, password: 'another correct horse battery 7' }, { idempotencyKey: null })).status, 200);
    const accepted = await invitee.post(`/v1/companies/${seed.companies.unrelated}/memberships/accept`, { membershipId, invitationToken: decodeURIComponent(token!) });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal((accepted.body as { status: string }).status, 'active');
    assert.equal(stack.sink.to(EMAILS.carl).length, 0);
  });

  await t.test('a stalled mail server never fails or slows the request; the delivery waits for a retry', async () => {
    const timed = async (address: string) => {
      const started = performance.now();
      const response = await stack.client().post('/v1/auth/signup', signupBody(address), { idempotencyKey: null });
      return { ms: performance.now() - started, response };
    };
    const baseline: number[] = [];
    for (let i = 0; i < 5; i += 1) baseline.push((await timed(`baseline.${i}@example.test`)).ms);
    await drain(worker);
    stack.sink.mode = 'stall_greeting';
    worker.start();
    const stalled: { ms: number; response: { status: number; body: unknown } }[] = [];
    try {
      for (let i = 0; i < 5; i += 1) stalled.push(await timed(`stalled.${i}@example.test`));
      const ids = await Promise.all(stalled.map(async (_, i) => (await stack.mailbox.lastTo(`stalled.${i}@example.test`))!.id));
      await waitFor(async () => {
        // The delivery row and its job are settled by the worker in turn; wait until both are, so the job is not read
        // while it is still leased.
        const { rows } = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM trustwork.mail_delivery d JOIN trustwork.job j ON j.id = d.job_id WHERE d.id = ANY($1::uuid[]) AND d.state = 'pending' AND d.last_error IS NOT NULL AND j.state <> 'leased'", [ids]);
        return rows[0]!.n === ids.length;
      }, 20_000, 'every stalled delivery to be back in pending with an error and its job released');
      const { rows } = await admin.query<{ state: string; attempt: number; due_later: boolean }>(
        "SELECT j.state, j.attempt, j.next_at > now() AS due_later FROM trustwork.job j JOIN trustwork.mail_delivery d ON d.job_id = j.id WHERE d.id = ANY($1::uuid[])", [ids]);
      for (const job of rows) assert.deepEqual(job, { state: 'queued', attempt: 1, due_later: true }, 'a definitive not-accepted answer retries later');
    } finally {
      await worker.stop(1000);
      stack.sink.mode = 'ok';
    }
    for (const { response } of stalled) {
      assert.equal(response.status, 202);
      assert.deepEqual(response.body, { status: 'verification_sent' });
    }
    const max = (xs: number[]) => Math.max(...xs);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const stalledMs = stalled.map((s) => s.ms);
    assert.ok(max(stalledMs) < 3000, `request latency with a stalled server: ${stalledMs.map(Math.round).join(', ')} ms`);
    // Other test files share the machine (parallel slots), so the comparison leaves room for load noise; a request that
    // waited for the stalled server would take the full SMTP connect timeout per message instead.
    assert.ok(median(stalledMs) < 2 * median(baseline) + 250, `median ${Math.round(median(stalledMs))} ms vs baseline ${Math.round(median(baseline))} ms`);
  });

  await t.test('a server that swallows the message: the job is parked as outcome_unknown; reconciliation settles the delivery', async () => {
    const address = 'swallowed@example.test';
    const { worker } = stack.worker(); // the previous worker was stopped; a stopped worker leases nothing
    stack.sink.mode = 'stall_after_data';
    try {
      await stack.client().post('/v1/auth/signup', signupBody(address), { idempotencyKey: null });
      await drain(worker);
    } finally {
      stack.sink.mode = 'ok';
    }
    const intent = (await stack.mailbox.lastTo(address))!;
    const row = (await admin.query<{ state: string; job_id: string; recipient: string | null }>('SELECT state, job_id, recipient FROM trustwork.mail_delivery WHERE id = $1', [intent.id])).rows[0]!;
    assert.equal(row.state, 'sending', 'unknown outcome: the delivery is neither sent nor retried');
    const job = (await admin.query<{ state: string }>('SELECT state FROM trustwork.job WHERE id = $1', [row.job_id])).rows[0]!;
    assert.equal(job.state, 'outcome_unknown');
    await drain(worker);
    assert.equal(stack.sink.to(address).length, 1, 'never sent a second time without reconciliation');
    const workerPool = stack.env.workerPool(2);
    await tx(workerPool, (trx) => reconcileJob(trx, { jobId: row.job_id, outcome: 'succeeded', reference: 'sink-log:SINK-swallowed', mode: 'manual', operator: 'test' }));
    await mailSettleTask({ pool: workerPool, metrics: new Metrics() }).run();
    const settled = (await admin.query<{ state: string; recipient: string | null; sealed_secret: Buffer | null }>('SELECT state, recipient, sealed_secret FROM trustwork.mail_delivery WHERE id = $1', [intent.id])).rows[0]!;
    assert.deepEqual(settled, { state: 'sent', recipient: null, sealed_secret: null });
  });

  await t.test('roles: the API only inserts deliveries; the worker cannot delete them, rewrite them or read party tables', async () => {
    const api = stack.env.apiPool;
    const workerPool = stack.env.workerPool(2);
    const denied = async (promise: Promise<unknown>, label: string) => {
      const error = await promise.then(() => null, (e: unknown) => e);
      assert.equal(sqlState(error), '42501', `${label}: expected permission denied, got ${error === null ? 'success' : String(error)}`);
    };
    await denied(api.query('SELECT * FROM trustwork.mail_delivery'), 'API SELECT mail_delivery');
    await denied(api.query('SELECT id FROM trustwork.mail_delivery'), 'API SELECT id');
    await denied(api.query("UPDATE trustwork.mail_delivery SET state = 'sent'"), 'API UPDATE');
    await denied(api.query('DELETE FROM trustwork.mail_delivery'), 'API DELETE');
    await denied(api.query('SELECT * FROM trustwork.suppression_entry'), 'API suppression list');
    await denied(workerPool.query('DELETE FROM trustwork.mail_delivery'), 'worker DELETE');
    await denied(workerPool.query("UPDATE trustwork.mail_delivery SET template = 'recovery'"), 'worker rewrites the template');
    await denied(workerPool.query("UPDATE trustwork.mail_delivery SET recipient_hash = repeat('0', 64)"), 'worker rewrites the address hash');
    await denied(workerPool.query("UPDATE trustwork.mail_delivery SET params = '{}'"), 'worker rewrites parameters');
    await denied(workerPool.query("INSERT INTO trustwork.mail_delivery (id, template, recipient_hash) VALUES (gen_random_uuid(), 'recovery', repeat('0', 64))"), 'worker forges a delivery');
    await denied(workerPool.query('DELETE FROM trustwork.suppression_entry'), 'worker lifts a suppression');
    await denied(workerPool.query('SELECT * FROM trustwork.email_binding'), 'worker reads addresses of people');
    await denied(workerPool.query('SELECT * FROM trustwork.auth_token'), 'worker reads token hashes');
    const final = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.mail_delivery WHERE state NOT IN ('pending', 'sending') AND (recipient IS NOT NULL OR sealed_secret IS NOT NULL)");
    assert.equal(final.rows[0]!.n, 0, 'no final delivery keeps an address or a token');
    await assert.rejects(admin.query("UPDATE trustwork.mail_delivery SET recipient = 'x@example.test' WHERE state = 'sent'"), /mail_delivery_final_minimised/);
    await tx(api, (trx) => jobs.enqueue(trx, { kind: 'probe.after-mail' }));
  });
});
