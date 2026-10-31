import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../helpers/app.js';
import { EMAILS, login, seedPersonas, type PersonaKey } from '../helpers/personas.js';
import { auditCount, count } from '../hardening/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS, IDEMPOTENT_ROUTES } from '../../../apps/api/src/common/idempotency/index.js';
import { installCrashPoints, recordState } from './helpers.js';

const h = await startHarness('idem_crash');

/**
 * BE-005 acceptance on real PostgreSQL, for every in-transaction route of every mutating route family (projects,
 * transfers, participants, directory handles, company creation, memberships):
 *
 * 1. crash before COMMIT (the completion inside the handler transaction raises, and the error bookkeeping is lost
 *    too): no effect, the record stays in progress;
 * 2. a retry inside the lease is told to wait; after the lease exactly one retry takes over and runs the handler, while
 *    every bookkeeping write outside the handler transaction is still being "lost": the record is nevertheless
 *    completed, so the completion was part of the handler's own commit;
 * 3. crash after COMMIT (the client never saw the response): a retry after another lease returns the stored response
 *    and repeats no effect (BE-002 re-ran the handler here and duplicated it).
 */
test('exactly-once completion: crash before and after the handler commit, for every in-transaction route', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const crash = await installCrashPoints(h.db.admin);
  const as = async (key: PersonaKey): Promise<Client> => {
    const client = h.client();
    await login(client, key);
    return client;
  };
  const petr = await as('petr');
  const xenia = await as('xenia');
  const carl = await as('carl');
  const covered = new Set<string>();
  const revisionOf = async (table: 'project' | 'membership' | 'object_participation', id: string) =>
    (await h.db.admin.query<{ revision: number }>(`SELECT revision FROM trustwork.${table} WHERE id = $1`, [id])).rows[0]!.revision;
  const created = async (response: Response) => {
    assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.body));
    return response.body as { id: string; revision: number };
  };
  const newProject = async (name: string) => created(await petr.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name, summary: null, leaderPersonId: null }));

  interface Route { action: string; client: Client; url: string; body?: unknown; effects: () => Promise<number> }
  /** Runs the crash sequence for one route and returns the single successful response. */
  const exactlyOnce = async (route: Route): Promise<Response> => {
    assert.equal(IDEMPOTENT_ROUTES[route.action]?.kind, 'in_transaction', `${route.action} completes in its transaction`);
    covered.add(route.action);
    const key = `crash-${route.action}`;
    const send = () => route.client.post(route.url, route.body, { idempotencyKey: key });
    const before = await route.effects();
    try {
      await crash.arm('handler', 'bookkeeping');
      const crashed = await send();
      assert.equal(crashed.status, 500, `${route.action}: crash before COMMIT ${JSON.stringify(crashed.body)}`);
      assert.equal((await recordState(h.db.admin, key))?.state, 'in_progress');
      assert.equal(await route.effects(), before, `${route.action}: nothing committed before the crash`);

      await crash.disarm('handler');
      expectError(await send(), 409, 'validation.idempotency_in_progress');
      h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
      const done = await send();
      assert.ok(done.status >= 200 && done.status < 300, `${route.action}: takeover ${done.status} ${JSON.stringify(done.body)}`);
      const record = await recordState(h.db.admin, key);
      assert.equal(record?.state, 'completed', `${route.action}: completed although every bookkeeping write fails`);
      assert.equal(record?.result?.httpStatus, done.status);
      assert.equal(await route.effects(), before + 1, `${route.action}: one effect`);

      h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
      const retry = await send();
      assert.equal(retry.status, done.status, `${route.action}: retry after a lost response`);
      assert.deepEqual(retry.body, done.body, `${route.action}: the stored response is returned`);
      assert.equal(await route.effects(), before + 1, `${route.action}: the effect is not repeated`);
      return done;
    } finally {
      await crash.clear();
      h.clock.reset();
    }
  };

  await t.test('projects: create, publish, leader, handle', async () => {
    const name = 'Exactly once project';
    const project = await created(await exactlyOnce({
      action: 'project.create', client: petr, url: '/v1/projects', body: { owner: { kind: 'person', id: seed.people.petr }, name, summary: null, leaderPersonId: null },
      effects: () => count(h.db.admin, 'SELECT 1 FROM trustwork.project WHERE name = $1', [name]),
    }));
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.outbox_event WHERE type = 'project.created' AND aggregate_id = $1", [project.id]), 1);
    await exactlyOnce({
      action: 'project.publish', client: petr, url: `/v1/projects/${project.id}/publish`,
      body: { projectId: project.id, publishedStory: 'A synthetic story for the exactly-once test.', openNeedIds: [], expectedRevision: await revisionOf('project', project.id) },
      effects: () => auditCount(h.db.admin, 'project.published'),
    });
    await exactlyOnce({
      action: 'project.assign_leader', client: petr, url: `/v1/projects/${project.id}/leader`,
      body: { projectId: project.id, leaderPersonId: seed.people.carl, expectedRevision: await revisionOf('project', project.id) },
      effects: () => auditCount(h.db.admin, 'project.leader_assigned'),
    });
    await exactlyOnce({
      action: 'project.set_handle', client: petr, url: `/v1/projects/${project.id}/handle`, body: { handle: 'exactly-once-project' },
      effects: () => auditCount(h.db.admin, 'project.handle_changed'),
    });
  });

  await t.test('participants: grant and revoke', async () => {
    const project = await newProject('Exactly once participants');
    const grant = await created(await exactlyOnce({
      action: 'project.participant_grant', client: petr, url: `/v1/projects/${project.id}/participants`,
      body: { party: { kind: 'person', id: seed.people.boris }, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', validUntil: null },
      effects: () => auditCount(h.db.admin, 'participation.granted'),
    }));
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.object_participation WHERE resource_id = $1 AND party_person_id = $2', [project.id, seed.people.boris]), 1);
    await exactlyOnce({
      action: 'project.participant_revoke', client: petr, url: `/v1/projects/${project.id}/participants/${grant.id}/revoke`,
      body: { expectedRevision: await revisionOf('object_participation', grant.id), reason: 'exactly-once test' },
      effects: () => auditCount(h.db.admin, 'participation.revoked'),
    });
  });

  await t.test('transfers: propose, consent, apply, reject, withdraw', async () => {
    const to = { kind: 'person', id: seed.people.xenia };
    const applied = await newProject('Exactly once transfer');
    const transfer = await created(await exactlyOnce({
      action: 'project.transfer_propose', client: petr, url: `/v1/projects/${applied.id}/transfers`, body: { projectId: applied.id, to, expectedRevision: applied.revision },
      effects: () => count(h.db.admin, 'SELECT 1 FROM trustwork.ownership_transfer WHERE project_id = $1', [applied.id]),
    }));
    await exactlyOnce({
      action: 'project.transfer_consent', client: xenia, url: `/v1/projects/${applied.id}/transfers/${transfer.id}/consent`,
      effects: () => auditCount(h.db.admin, 'project.transfer_accepted_by_recipient'),
    });
    await exactlyOnce({
      action: 'project.transfer_apply', client: petr, url: `/v1/projects/${applied.id}/transfers/${transfer.id}/apply`,
      effects: () => auditCount(h.db.admin, 'project.transfer_effective'),
    });
    assert.equal((await h.db.admin.query<{ owner_person_id: string }>('SELECT owner_person_id FROM trustwork.project WHERE id = $1', [applied.id])).rows[0]?.owner_person_id, seed.people.xenia);

    const rejected = await newProject('Exactly once rejected transfer');
    const proposal = await created(await petr.post(`/v1/projects/${rejected.id}/transfers`, { projectId: rejected.id, to, expectedRevision: rejected.revision }));
    await exactlyOnce({
      action: 'project.transfer_reject', client: xenia, url: `/v1/projects/${rejected.id}/transfers/${proposal.id}/reject`,
      effects: () => auditCount(h.db.admin, 'project.transfer_rejected'),
    });
    const withdrawn = await newProject('Exactly once withdrawn transfer');
    const offer = await created(await petr.post(`/v1/projects/${withdrawn.id}/transfers`, { projectId: withdrawn.id, to, expectedRevision: withdrawn.revision }));
    await exactlyOnce({
      action: 'project.transfer_withdraw', client: petr, url: `/v1/projects/${withdrawn.id}/transfers/${offer.id}/withdraw`,
      effects: () => auditCount(h.db.admin, 'project.transfer_withdrawn'),
    });
  });

  await t.test('directory: person handle, company creation, company handle', async () => {
    await exactlyOnce({ action: 'person.set_handle', client: petr, url: '/v1/me/handle', body: { handle: 'petr-exactly-once' }, effects: () => auditCount(h.db.admin, 'person.handle_changed') });
    const name = 'Exactly Once Roofing';
    const result = (await exactlyOnce({
      action: 'company.create', client: xenia, url: '/v1/companies', body: { name, handle: null, publicDescription: null },
      effects: () => count(h.db.admin, 'SELECT 1 FROM trustwork.company WHERE display_name = $1', [name]),
    })).body as { company: { id: string } };
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.membership WHERE person_id = $1 AND status = 'active'", [seed.people.xenia]), 1);
    await exactlyOnce({
      action: 'company.set_handle', client: xenia, url: `/v1/companies/${result.company.id}/handle`, body: { handle: 'exactly-once-roofing' },
      effects: () => auditCount(h.db.admin, 'company.handle_changed'),
    });
  });

  await t.test('memberships: accept (mailbox proof consumed in the same transaction), change, end', async () => {
    const company = seed.companies.unrelated;
    const invite = await carl.post(`/v1/companies/${company}/memberships`, { companyId: company, inviteeEmail: EMAILS.petr, role: 'member', permissions: [] });
    assert.equal(invite.status, 202, JSON.stringify(invite.body));
    const mail = h.mail.lastTo(EMAILS.petr, 'membership_invitation')!;
    const membershipId = mail.params.membershipId as string;
    await exactlyOnce({
      action: 'membership.accept', client: petr, url: `/v1/companies/${company}/memberships/accept`, body: { membershipId, invitationToken: mail.params.token as string },
      effects: () => auditCount(h.db.admin, 'membership.activated'),
    });
    await exactlyOnce({
      action: 'membership.change', client: carl, url: `/v1/companies/${company}/memberships/change`,
      body: { membershipId, role: 'member', permissions: ['company.deals.manage'], expectedRevision: await revisionOf('membership', membershipId) },
      effects: () => auditCount(h.db.admin, 'membership.changed'),
    });
    await exactlyOnce({
      action: 'membership.end', client: carl, url: `/v1/companies/${company}/memberships/end`,
      body: { membershipId, reason: 'exactly-once test', expectedRevision: await revisionOf('membership', membershipId) },
      effects: () => auditCount(h.db.admin, 'membership.ended'),
    });
  });

  await t.test('every in-transaction route was crash-tested', () => {
    const expected = Object.entries(IDEMPOTENT_ROUTES).filter(([, mode]) => mode.kind === 'in_transaction').map(([action]) => action).sort();
    assert.deepEqual([...covered].sort(), expected);
  });
});
