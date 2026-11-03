import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { FakeMailTransport, mailConfigFromEnv, registerMail, renderMail, MAIL_LOCALES, type MailTransport } from '../../../../apps/worker/src/mail/index.js';
import { HandlerRegistry, Metrics, silentLogger, Worker } from '../../../../apps/worker/src/index.js';
import { jurisdictionGate } from '../../../../packages/data/src/repositories/jurisdiction.js';
import { screeningNoticeAllowed } from '../../../../packages/data/src/repositories/screening-notices.js';
import { SKIP_REASON } from '../../../data/helpers/postgres.js';
import { provisionWorkerDatabase, tx } from '../../../worker/helpers/worker-db.js';
import { drain } from '../../../worker/mail/helpers/stack.js';
import { company, person, screen, screeningWorld } from '../../../screening/helpers.js';

const env = await provisionWorkerDatabase('sanc006_staff_notice');

/**
 * ADR 014 decision 14 on real PostgreSQL, the worker role and the production mail handlers: a new queue item or hold
 * reaches every independent compliance officer of the node, cannot be muted and names nobody.
 */
test('SANC-006 compliance staff notice', { skip: env ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const worker = env.workerPool(6);
  const world = await screeningWorld(admin, env.apiPool, worker);
  const { moderator, lead, ops, auditor } = world.w.people;
  const officers = [moderator, lead, ops];
  const address = (id: string) => `staff-${id}@example.invalid`;
  await withMaintenance(admin, async (trx) => {
    for (const id of [...officers, auditor]) {
      await trx.deleteFrom('email_binding').where('person_id', '=', id).execute();
      await trx.insertInto('email_binding').values({ person_id: id, email_normalized: address(id), verified_at: new Date(), is_primary: true }).execute();
    }
  });
  const config = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid', MAIL_RECIPIENT_LIMIT_PER_HOUR: '1000' });
  const send = async (transport: MailTransport) => {
    const registry = new HandlerRegistry();
    registerMail(registry, { pool: worker, config, transport, log: silentLogger, metrics: new Metrics() });
    const mailWorker = new Worker({ pool: worker, registry, config: { concurrency: 1 }, tasks: () => [] });
    await drain(mailWorker);
    await mailWorker.stop(200);
  };
  const notices = async () => (await admin.query<{ id: string; person_id: string; state: string; params: Record<string, string> }>(
    `SELECT d.id, a.person_id, d.state, d.params FROM trustwork.mail_delivery d JOIN trustwork.screening_notice_authority a ON a.delivery_id = d.id
      WHERE d.template = 'screening_staff_notice' ORDER BY d.seq`)).rows;
  /** Everything waits to be sent; the next assertions look only at what the event added. */
  const flush = async () => { const fake = new FakeMailTransport(); await send(fake); return fake; };
  const added = async (before: number) => (await notices()).slice(before);

  await t.test('a new queue item tells each independent officer once and nothing about the subject', async () => {
    const subject = await person(admin, 'Zorvan Exampleton');
    const before = (await notices()).length;
    assert.equal((await screen(worker, { kind: 'person', id: subject.id })).opened, 1);
    const rows = await added(before);
    assert.deepEqual(rows.map((r) => r.person_id).sort(), [...officers].sort(), 'officers only: no auditor, no subject');
    for (const row of rows) assert.deepEqual(row.params, {}, 'the notice carries no parameter');
    await screen(worker, { kind: 'person', id: subject.id });
    assert.equal((await added(before)).length, officers.length, 'screening again adds nothing');
    const fake = await flush();
    const staff = fake.sent.filter((mail) => officers.some((id) => mail.to === address(id)));
    assert.equal(staff.length, officers.length);
    for (const mail of staff) {
      const body = `${mail.subject}\n${mail.text}\n${mail.html}`;
      for (const secret of ['Exampleton', 'EXAMPLETON', 'Zorvan', 'ofac', 'SYNTHETIC-A', '920001', subject.id]) assert.ok(!body.includes(secret), secret);
      assert.ok(body.includes('https://hub.example.invalid/admin'), 'the fixed console link');
    }
  });

  await t.test('an unsent notice covers a burst; a sent one never stops the next', async () => {
    const before = (await notices()).length;
    await screen(worker, { kind: 'person', id: (await person(admin, 'Petra Samplewood')).id });
    await screen(worker, { kind: 'person', id: (await person(admin, 'Orla Testworthy')).id });
    assert.equal((await added(before)).length, officers.length, 'one unsent notice per officer');
    await flush();
    await screen(worker, { kind: 'person', id: (await person(admin, 'Milo Fictivsky')).id });
    assert.equal((await added(before)).length, officers.length * 2);
    await flush();
  });

  await t.test('an officer who is the subject, a member of the subject company or conflicted is not told', async () => {
    let before = (await notices()).length;
    await withMaintenance(admin, (trx) => trx.updateTable('person').set({ display_name: 'Milo Fictivsky' }).where('id', '=', moderator).execute());
    await screen(worker, { kind: 'person', id: moderator });
    assert.deepEqual((await added(before)).map((r) => r.person_id).sort(), [lead, ops].sort());
    await flush();
    before = (await notices()).length;
    const northwind = await company(admin, 'Northwind Synthetic Supply LLC', [lead]);
    await screen(worker, { kind: 'company', id: northwind });
    assert.ok(!(await added(before)).some((r) => r.person_id === lead), 'a member of the subject company');
    await flush();
    before = (await notices()).length;
    const conflicted = await person(admin, 'Zorvan Exampleton');
    await withMaintenance(admin, (trx) => trx.insertInto('staff_conflict_declaration').values({ staff_person_id: ops, conflict_person_id: conflicted.id, reason: 'Synthetic declared relation' }).execute());
    await screen(worker, { kind: 'person', id: conflicted.id });
    assert.ok(!(await added(before)).some((r) => r.person_id === ops), 'a declared conflict');
    await flush();
  });

  await t.test('a hold tells the officers and the held person is not among them', async () => {
    const held = await person(admin, 'Quentin Brightwater');
    const before = (await notices()).length;
    assert.equal(await jurisdictionGate.holdSession(env.apiPool, { tokenHashHex: held.tokenHash.toString('hex'), place: 'CU', source: 'geolocation', dataset: 'synthetic-fake' }), true);
    assert.ok((await added(before)).length >= 1);
    assert.ok((await added(before)).every((r) => r.person_id !== held.id));
    await flush();
  });

  await t.test('there is no preference that mutes it', async () => {
    await withMaintenance(admin, async (trx) => {
      for (const category of ['messages', 'commerce', 'tasks', 'projects'] as const) {
        await trx.insertInto('notification_preference').values({ person_id: lead, category, channel: 'email', frequency: 'off' }).execute();
      }
    });
    const before = (await notices()).length;
    await screen(worker, { kind: 'person', id: (await person(admin, 'Orla Testworthy')).id });
    const fresh = (await added(before)).find((r) => r.person_id === lead);
    assert.ok(fresh);
    await flush();
    assert.equal((await notices()).find((r) => r.id === fresh.id)?.state, 'sent');
  });

  await t.test('an officer revoked before dispatch gets nothing', async () => {
    const before = (await notices()).length;
    await screen(worker, { kind: 'person', id: (await person(admin, 'Petra Samplewood')).id });
    const rows = await added(before);
    const revoked = rows.find((r) => r.person_id === ops);
    assert.ok(revoked);
    await withMaintenance(admin, (trx) => trx.updateTable('staff_role_assignment').set({ revoked_at: new Date(), revoked_by: lead, revoke_reason: 'Synthetic revocation' })
      .where('person_id', '=', ops).where('role', '=', 'compliance-officer').execute());
    assert.equal(await tx(worker, (trx) => screeningNoticeAllowed(trx, revoked.id)), false);
    const fake = await flush();
    assert.ok(!fake.sent.some((mail) => mail.to === address(ops)));
    assert.equal((await notices()).find((r) => r.id === revoked.id)?.state, 'suppressed');
  });

  await t.test('the runtime and worker roles cannot record or inspect a staff notice directly', async () => {
    for (const pool of [env.apiPool, worker]) {
      await assert.rejects(tx(pool, (trx) => sql`SELECT trustwork.screening_record_staff_notice(${lead}::uuid, NULL)`.execute(trx)), /permission denied/);
      await assert.rejects(tx(pool, (trx) => sql`SELECT trustwork.screening_staff_notice_eligible(${lead}::uuid, NULL, NULL)`.execute(trx)), /permission denied/);
    }
  });
});

test('the staff notice renders in every mail language and takes no parameter', () => {
  const config = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid', MAIL_LOCALES: MAIL_LOCALES.join(',') });
  for (const locale of MAIL_LOCALES) {
    const mail = renderMail(config.render, { template: 'screening_staff_notice', localePreferences: [locale], params: {}, secret: null });
    assert.ok(mail.subject.length > 0 && mail.text.includes('/admin'), locale);
  }
  assert.throws(() => renderMail(config.render, { template: 'screening_staff_notice', localePreferences: ['en'], params: { subject: 'Synthetic Name' }, secret: null }));
});
