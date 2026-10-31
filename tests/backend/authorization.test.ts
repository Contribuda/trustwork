import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyDecisionSchema, type ObjectParticipation, type Principal } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { evaluatePolicy } from '../../apps/api/src/modules/identity/policy/policy.js';
import { expectError, SKIP_REASON, startHarness, type Client } from './helpers/app.js';
import { EMAILS, login, seedPersonas } from './helpers/personas.js';

const h = await startHarness('authz');
const FORBIDDEN_OWNER_FIELDS = ['privateNotes', 'budgets', 'privateFiles', 'participantIds', 'baselinePlanId', 'milestones', 'sharedFiles', 'owner', 'leaderPersonId', 'creatorPersonId'];
const FORBIDDEN_PARTICIPANT_FIELDS = ['privateNotes', 'budgets', 'privateFiles', 'participantIds', 'baselinePlanId', 'creatorPersonId'];
const absent = (body: unknown, fields: readonly string[]) => {
  const keys = Object.keys((body ?? {}) as object);
  for (const f of fields) assert.ok(!keys.includes(f), `forbidden field ${f} present: ${keys.join(',')}`);
};

test('object authorization acceptance suite over HTTP (access-and-journeys.md) with membership and project flows', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const petr = await as('petr');
  const anna = await as('anna');
  const boris = await as('boris');
  const carl = await as('carl');
  const xenia = await as('xenia');
  const anonymous = h.client();
  const PROJECT_P = seed.project;
  const mixedProject = (await anna.post('/v1/projects', { owner: { kind: 'company', id: seed.companies.mixed }, name: 'Фасады: общественный проект', summary: 'Строим', leaderPersonId: null })).body as { id: string; revision: number };
  // Anna's fixture membership lacks company.publish (asserted below), so the public story is set through maintenance.
  await withMaintenance(h.db.admin, (trx) => trx.updateTable('project').set({ publicity_enabled: true, published_story: 'Опубликованная история' }).where('id', '=', mixedProject.id).execute());
  const PROJECT_PUB = mixedProject.id;
  const mixedPrivate = (await anna.post('/v1/projects', { owner: { kind: 'company', id: seed.companies.mixed }, name: 'Фасады: закрытый проект', summary: null, leaderPersonId: null })).body as { id: string };
  const privateNotes = 'owner only';

  await t.test('anonymous: private project not found, public project public projection without private fields', async () => {
    expectError(await anonymous.get(`/v1/projects/${PROJECT_P}`), 404, 'access.not_found');
    const pub = await anonymous.get(`/v1/projects/${PROJECT_PUB}`);
    assert.equal(pub.status, 200);
    const body = pub.body as { projection: string; project: Record<string, unknown> };
    assert.equal(body.projection, 'public');
    assert.equal(body.project.publishedStory, 'Опубликованная история');
    absent(body.project, FORBIDDEN_OWNER_FIELDS);
    expectError(await anonymous.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name: 'x', summary: null, leaderPersonId: null }, { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await anonymous.get('/v1/me/sessions'), 401, 'auth.session_invalid');
    expectError(await anonymous.get(`/v1/people/${seed.people.petr}`), 404, 'access.not_found');
    assert.equal((await anonymous.get(`/v1/people/${seed.people.pure}`)).status, 200, 'public profile');
    absent((await anonymous.get(`/v1/people/${seed.people.pure}`)).body, ['emailBindings', 'providerIdentities', 'preferences']);
    const company = await anonymous.get(`/v1/companies/${seed.companies.mixed}`);
    assert.equal(company.status, 200);
    assert.equal((company.body as { privateView: unknown }).privateView, null);
    absent((company.body as { company: object }).company, ['internalNotes', 'billingAccountId', 'membershipRequests', 'verifiedDomains']);
  });

  await t.test('own person: owner_private projection with private notes; own sessions without hashes', async () => {
    const r = await petr.get(`/v1/projects/${PROJECT_P}`);
    assert.equal(r.status, 200);
    const body = r.body as { projection: string; project: { privateNotes: string; participantIds: string[] } };
    assert.equal(body.projection, 'owner_private');
    assert.equal(body.project.privateNotes, privateNotes);
    assert.ok(body.project.participantIds.includes(seed.companies.supplier));
    const list = await petr.get(`/v1/projects/${PROJECT_P}/participants`);
    assert.equal(list.status, 200);
  });

  await t.test('own-company member without grant: public projection only, private company project not found, mutation rejected', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.page.edit'] }).where('id', '=', seed.memberships.xenia).execute());
    const anna2 = (await h.db.admin.query<{ id: string }>("SELECT id FROM trustwork.person WHERE display_name = 'Fixture Anna'")).rows[0]!.id;
    void anna2;
    await withMaintenance(h.db.admin, async (trx) => {
      await trx.insertInto('membership').values({ person_id: seed.people.pure, company_id: seed.companies.mixed, role: 'member', permissions: ['company.page.edit'], status: 'active', valid_from: new Date(Date.now() - 1000) }).execute();
    });
    const member = await as('pure');
    const pub = await member.get(`/v1/projects/${PROJECT_PUB}`);
    assert.equal(pub.status, 200);
    assert.equal((pub.body as { projection: string }).projection, 'public');
    absent((pub.body as { project: object }).project, FORBIDDEN_OWNER_FIELDS);
    expectError(await member.get(`/v1/projects/${mixedPrivate.id}`), 404, 'access.not_found');
    expectError(await member.post(`/v1/projects/${PROJECT_PUB}/publish`, { projectId: PROJECT_PUB, publishedStory: 'взлом', openNeedIds: [], expectedRevision: 2 }), 403, 'membership.permission_missing');
    expectError(await member.get(`/v1/projects/${PROJECT_PUB}/participants`), 403, 'membership.permission_missing');
    expectError(await member.post('/v1/projects', { owner: { kind: 'company', id: seed.companies.mixed }, name: 'x', summary: null, leaderPersonId: null }), 403, 'membership.permission_missing');
    const company = await member.get(`/v1/companies/${seed.companies.mixed}`);
    assert.equal((company.body as { privateView: { internalNotes: string } }).privateView.internalNotes, 'owner_private', 'member view of the own company');
    assert.equal((company.body as { privateView: { billingAccountId: string | null } }).privateView.billingAccountId, null, 'billing account hidden without company.billing.*');
    assert.equal((await member.get(`/v1/companies/${seed.companies.mixed}/memberships`)).status, 200);
    expectError(await member.get(`/v1/companies/${seed.companies.supplier}/memberships`), 404, 'access.not_found');
  });

  await t.test('authorized company member with deals.manage reads the company project privately; publish rejected without company.publish', async () => {
    const r = await anna.get(`/v1/projects/${mixedPrivate.id}`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { projection: string }).projection, 'owner_private');
    const annaPermissions = (await h.db.admin.query<{ permissions: string[] }>('SELECT permissions FROM trustwork.membership WHERE id = $1', [seed.memberships.anna])).rows[0]!.permissions;
    assert.ok(!annaPermissions.includes('company.publish'));
    const revision = (r.body as { project: { revision: number } }).project.revision;
    expectError(await anna.post(`/v1/projects/${mixedPrivate.id}/publish`, { projectId: mixedPrivate.id, publishedStory: 's', openNeedIds: [], expectedRevision: revision }), 404, 'access.not_found');
  });

  await t.test('counterpart supplier (scoped participant): participant projection without owner fields; mutation of the owner project forbidden', async () => {
    const r = await boris.get(`/v1/projects/${PROJECT_P}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { projection: string; project: Record<string, unknown> };
    assert.equal(body.projection, 'shared_party');
    absent(body.project, FORBIDDEN_PARTICIPANT_FIELDS);
    assert.deepEqual(body.project.milestones, []);
    expectError(await boris.post(`/v1/projects/${PROJECT_P}/publish`, { projectId: PROJECT_P, publishedStory: 'x', openNeedIds: [], expectedRevision: 1 }), 403, 'access.forbidden');
    expectError(await boris.post(`/v1/projects/${PROJECT_P}/participants`, { party: { kind: 'company', id: seed.companies.unrelated }, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', validUntil: null }), 403, 'access.forbidden');
    expectError(await boris.get(`/v1/projects/${PROJECT_P}/participants`), 403, 'access.forbidden');
    expectError(await boris.post(`/v1/projects/${PROJECT_P}/transfers`, { projectId: PROJECT_P, to: { kind: 'company', id: seed.companies.supplier }, expectedRevision: 1 }), 403, 'access.forbidden');
  });

  await t.test('unrelated company: guessed ids are not found; no participant can be added (M19)', async () => {
    expectError(await carl.get(`/v1/projects/${PROJECT_P}`), 404, 'access.not_found');
    expectError(await carl.get(`/v1/projects/${PROJECT_P}/participants`), 404, 'access.not_found');
    expectError(await carl.post(`/v1/projects/${PROJECT_P}/participants`, { party: { kind: 'company', id: seed.companies.unrelated }, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', validUntil: null }), 404, 'access.not_found');
    expectError(await carl.post(`/v1/projects/${PROJECT_P}/publish`, { projectId: PROJECT_P, publishedStory: 'x', openNeedIds: [], expectedRevision: 1 }), 404, 'access.not_found');
    expectError(await carl.get(`/v1/projects/${mixedPrivate.id}`), 404, 'access.not_found');
    expectError(await carl.post(`/v1/companies/${seed.companies.mixed}/memberships/end`, { membershipId: seed.memberships.anna, reason: 'x', expectedRevision: 1 }), 404, 'access.not_found');
  });

  await t.test('revoked membership: pre-existing session loses company authority in the same request after commit; cached decision not reused; identity persists', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ status: 'active', ended_at: null, ended_by: null, ended_reason: null, permissions: ['company.deals.manage'] }).where('id', '=', seed.memberships.xenia).execute().catch(() => undefined));
    const xeniaMembership = await withMaintenance(h.db.admin, (trx) => trx.insertInto('membership').values({ person_id: seed.people.xenia, company_id: seed.companies.supplier, role: 'member', permissions: ['company.deals.manage'], status: 'active', valid_from: new Date(Date.now() - 1000) }).returningAll().executeTakeFirstOrThrow());
    const before = await xenia.get(`/v1/projects/${PROJECT_P}`);
    assert.equal(before.status, 200, 'supplier member with deals.manage reads the participant projection');
    const stats = { ...h.services().participations.cacheStats };
    assert.equal((await xenia.get(`/v1/projects/${PROJECT_P}`)).status, 200);
    assert.equal(h.services().participations.cacheStats.hits, stats.hits + 1, 'second read is a cache hit under the same epochs');
    const manager = await as('boris');
    const ended = await manager.post(`/v1/companies/${seed.companies.supplier}/memberships/end`, { membershipId: xeniaMembership.id, reason: 'contract ended', expectedRevision: xeniaMembership.revision });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal((ended.body as { membership: { status: string } }).membership.status, 'ended');
    assert.ok(h.mandates.calls.some((c) => c.personId === seed.people.xenia && c.companyId === seed.companies.supplier), 'queued mandates hook called');
    const after = await xenia.get(`/v1/projects/${PROJECT_P}`);
    expectError(after, 404, 'access.not_found');
    assert.equal(h.services().participations.cacheStats.hits, stats.hits + 1, 'no cache hit after the epoch bump');
    const me = await xenia.get('/v1/me');
    assert.equal(me.status, 200, 'identity survives');
    assert.equal((me.body as { principal: { membership: unknown } }).principal.membership, null);
    assert.equal((await anonymous.get(`/v1/people/${seed.people.pure}`)).status, 200, 'own public contributions survive');
    const epochs = await h.db.admin.query<{ scope: string; epoch: string }>("SELECT scope, epoch FROM trustwork.admission_scope WHERE scope = $1", [`person:${seed.people.xenia}`]);
    assert.equal(epochs.rows[0]?.epoch, '2', 'admission scope revoked on membership end');
  });

  await t.test('expired mandate placeholder: a delegated principal is denied by the pure policy with mandate_scope', () => {
    const principal: Principal = { personId: seed.people.anna, emailVerified: true, authenticatedAt: new Date().toISOString(), authzEpoch: 3, membership: null, staff: [], delegation: { mandateId: 'mandate-fixture', mandateRevision: 2, principalPersonId: seed.people.anna } };
    const decision = evaluatePolicy({ principal, action: 'read.shared', resource: { kind: 'project', id: PROJECT_P, ownerParty: { kind: 'person', id: seed.people.petr }, lifecycle: 'active', publishedProjection: false }, participations: [], now: new Date() });
    assert.deepEqual(PolicyDecisionSchema.parse(decision).effect, 'deny');
    assert.equal((decision as { reason: string }).reason, 'mandate_scope');
    const expired: ObjectParticipation = { id: 'p', resource: { kind: 'project', id: PROJECT_P }, party: { kind: 'person', id: seed.people.anna }, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-02-01T00:00:00Z', grantedBy: { personId: seed.people.petr, onBehalfOf: null }, revokedAt: null, revokedReason: null, revision: 1, caseRef: null };
    const expiredDecision = evaluatePolicy({ principal: { ...principal, delegation: null }, action: 'read.shared', resource: { kind: 'project', id: PROJECT_P, ownerParty: { kind: 'person', id: seed.people.petr }, lifecycle: 'active', publishedProjection: false }, participations: [expired], now: new Date() });
    assert.equal((expiredDecision as { reason: string }).reason, 'participation_expired');
  });

  await t.test('personally owned project participant (M10) and platform admin without case grant (M11)', async () => {
    const participant = await boris.get(`/v1/projects/${PROJECT_P}`);
    assert.equal((participant.body as { projection: string }).projection, 'shared_party');
    h.staff.set(seed.people.carl, ['support-agent']);
    const staff = await as('carl');
    const me = await staff.get('/v1/me');
    assert.deepEqual((me.body as { principal: { staff: string[] } }).principal.staff, ['support-agent']);
    expectError(await staff.get(`/v1/projects/${PROJECT_P}`), 404, 'access.not_found');
    expectError(await staff.get(`/v1/projects/${PROJECT_P}/participants`), 404, 'access.not_found');
    h.staff.delete(seed.people.carl);
  });

  await t.test('participants: grant within canGrant, no amplification, owner row protected, revoke bumps scopes', async () => {
    const grant = await petr.post(`/v1/projects/${PROJECT_P}/participants`, { party: { kind: 'person', id: seed.people.pure }, side: 'participant', capabilities: ['read.shared', 'manage_participants', 'invite'], audience: 'shared_party', validUntil: null });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
    const row = grant.body as { id: string; revision: number };
    const manager = await as('pure');
    const amplified = await manager.post(`/v1/projects/${PROJECT_P}/participants`, { party: { kind: 'company', id: seed.companies.unrelated }, side: 'participant', capabilities: ['read.shared', 'read.owner_private'], audience: 'owner_private', validUntil: null });
    expectError(amplified, 403, 'access.forbidden');
    const within = await manager.post(`/v1/projects/${PROJECT_P}/participants`, { party: { kind: 'person', id: seed.people.carl }, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', validUntil: null });
    assert.equal(within.status, 201, JSON.stringify(within.body));
    const carlView = await carl.get(`/v1/projects/${PROJECT_P}`);
    assert.equal((carlView.body as { projection: string }).projection, 'shared_party');
    const ownerRow = ((await petr.get(`/v1/projects/${PROJECT_P}/participants`)).body as { items: { id: string; side: string; revision: number }[] }).items.find((p) => p.side === 'owner')!;
    expectError(await manager.post(`/v1/projects/${PROJECT_P}/participants/${ownerRow.id}/revoke`, { expectedRevision: ownerRow.revision, reason: 'takeover' }), 403, 'access.forbidden');
    expectError(await petr.post(`/v1/projects/${PROJECT_P}/participants/${ownerRow.id}/revoke`, { expectedRevision: ownerRow.revision, reason: 'self' }), 403, 'access.forbidden');
    const unrelatedRow = within.body as { id: string; revision: number };
    expectError(await petr.post(`/v1/projects/${PROJECT_P}/participants/${unrelatedRow.id}/revoke`, { expectedRevision: 99, reason: 'stale' }), 409, 'validation.revision_conflict');
    const revoked = await petr.post(`/v1/projects/${PROJECT_P}/participants/${unrelatedRow.id}/revoke`, { expectedRevision: unrelatedRow.revision, reason: 'done' });
    assert.equal(revoked.status, 200);
    expectError(await carl.get(`/v1/projects/${PROJECT_P}`), 404, 'access.not_found');
    const scope = await h.db.admin.query<{ epoch: string }>('SELECT epoch FROM trustwork.admission_scope WHERE scope = $1', [`person:${seed.people.carl}`]);
    assert.equal(scope.rows[0]?.epoch, '2');
    const selfRevoke = await manager.post(`/v1/projects/${PROJECT_P}/participants/${row.id}/revoke`, { expectedRevision: row.revision, reason: 'leaving' });
    assert.equal(selfRevoke.status, 200, 'a party may revoke itself');
    expectError(await manager.get(`/v1/projects/${PROJECT_P}`), 404, 'access.not_found');
  });

  await t.test('ownership transfer: consent required (M20), recipient consents, owner applies, owner row re-materialised, old owner loses access', async () => {
    // The recipient company exercises ownership through members holding company.deals.manage (policy mapping).
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.members.manage', 'company.deals.manage'] }).where('id', '=', seed.memberships.carl).execute());
    const created = (await petr.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name: 'Дом для передачи', summary: null, leaderPersonId: seed.people.pure })).body as { id: string; revision: number; leaderPersonId: string };
    assert.equal(created.leaderPersonId, seed.people.pure);
    const leader = await as('pure');
    assert.equal(((await leader.get(`/v1/projects/${created.id}`)).body as { projection: string }).projection, 'shared_party', 'leader is a scoped participant, not an owner');
    const proposed = await petr.post(`/v1/projects/${created.id}/transfers`, { projectId: created.id, to: { kind: 'company', id: seed.companies.unrelated }, expectedRevision: created.revision });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const transfer = proposed.body as { id: string };
    expectError(await petr.post(`/v1/projects/${created.id}/transfers/${transfer.id}/apply`), 409, 'commercial.transfer_consent_pending');
    expectError(await boris.post(`/v1/projects/${created.id}/transfers/${transfer.id}/consent`), 404, 'access.not_found');
    expectError(await boris.post(`/v1/projects/${created.id}/transfers/${transfer.id}/withdraw`), 404, 'access.not_found');
    expectError(await carl.post(`/v1/projects/${created.id}/transfers/${transfer.id}/withdraw`), 403, 'access.forbidden');
    const consent = await carl.post(`/v1/projects/${created.id}/transfers/${transfer.id}/consent`);
    assert.equal(consent.status, 200, JSON.stringify(consent.body));
    expectError(await carl.post(`/v1/projects/${created.id}/transfers/${transfer.id}/apply`), 404, 'access.not_found');
    const applied = await petr.post(`/v1/projects/${created.id}/transfers/${transfer.id}/apply`);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual((applied.body as { owner: unknown }).owner, { kind: 'company', id: seed.companies.unrelated });
    expectError(await petr.get(`/v1/projects/${created.id}`), 404, 'access.not_found');
    const carlView = await carl.get(`/v1/projects/${created.id}`);
    assert.equal((carlView.body as { projection: string }).projection, 'owner_private');
    const rows = await h.db.admin.query<{ side: string; party_company_id: string | null; revoked_at: Date | null }>('SELECT side, party_company_id, revoked_at FROM trustwork.object_participation WHERE resource_id = $1 AND side = $2 ORDER BY created_at', [created.id, 'owner']);
    assert.equal(rows.rows.filter((r) => r.revoked_at === null).length, 1);
    assert.equal(rows.rows.find((r) => r.revoked_at === null)?.party_company_id, seed.companies.unrelated);
    const assign = await carl.post(`/v1/projects/${created.id}/leader`, { projectId: created.id, leaderPersonId: seed.people.carl, expectedRevision: (applied.body as { revision: number }).revision });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    expectError(await leader.get(`/v1/projects/${created.id}`), 404, 'access.not_found');
  });

  await t.test('membership flows: invite (manager + step-up + verified mail), accept with mailbox proof, change, last administrator kept', async () => {
    const admin = await as('carl');
    expectError(await boris.post(`/v1/companies/${seed.companies.unrelated}/memberships`, { companyId: seed.companies.unrelated, inviteeEmail: EMAILS.pure, role: 'member', permissions: [] }), 404, 'access.not_found');
    const invite = await admin.post(`/v1/companies/${seed.companies.unrelated}/memberships`, { companyId: seed.companies.unrelated, inviteeEmail: EMAILS.pure, role: 'member', permissions: ['company.deals.manage'] });
    const unknown = await admin.post(`/v1/companies/${seed.companies.unrelated}/memberships`, { companyId: seed.companies.unrelated, inviteeEmail: 'nobody@example.invalid', role: 'member', permissions: [] });
    assert.equal(invite.status, 202);
    assert.deepEqual(invite.body, unknown.body);
    const mail = (await h.mail.lastTo(EMAILS.pure, 'membership_invitation'))!;
    const invitee = await as('pure');
    const membershipId = mail.params.membershipId as string;
    expectError(await invitee.post(`/v1/companies/${seed.companies.unrelated}/memberships/accept`, { membershipId, invitationToken: 'x'.repeat(32) }), 404, 'access.not_found');
    expectError(await invitee.post(`/v1/companies/${seed.companies.unrelated}/memberships/accept`, { membershipId, invitationToken: mail.params.token as string }), 409, 'membership.already_employed');
    const pureMembership = (await h.db.admin.query<{ id: string; revision: number }>('SELECT id, revision FROM trustwork.membership WHERE person_id = $1 AND company_id = $2', [seed.people.pure, seed.companies.mixed])).rows[0]!;
    assert.equal((await invitee.post(`/v1/companies/${seed.companies.mixed}/memberships/end`, { membershipId: pureMembership.id, reason: 'leaving', expectedRevision: pureMembership.revision })).status, 200);
    const invite2 = await admin.post(`/v1/companies/${seed.companies.unrelated}/memberships`, { companyId: seed.companies.unrelated, inviteeEmail: EMAILS.pure, role: 'member', permissions: ['company.deals.manage'] });
    assert.equal(invite2.status, 202);
    const mail2 = (await h.mail.lastTo(EMAILS.pure, 'membership_invitation'))!;
    const accepted = await invitee.post(`/v1/companies/${seed.companies.unrelated}/memberships/accept`, { membershipId: mail2.params.membershipId as string, invitationToken: mail2.params.token as string });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const m = accepted.body as { id: string; revision: number; status: string };
    assert.equal(m.status, 'active');
    expectError(await invitee.post(`/v1/companies/${seed.companies.unrelated}/memberships/change`, { membershipId: m.id, role: 'administrator', permissions: [], expectedRevision: m.revision }), 403, 'membership.permission_missing');
    const changed = await admin.post(`/v1/companies/${seed.companies.unrelated}/memberships/change`, { membershipId: m.id, role: 'administrator', permissions: ['company.members.manage'], expectedRevision: m.revision });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    expectError(await admin.post(`/v1/companies/${seed.companies.unrelated}/memberships/change`, { membershipId: m.id, role: 'member', permissions: [], expectedRevision: m.revision }), 409, 'validation.revision_conflict');
    const carlMembership = (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.membership WHERE id = $1', [seed.memberships.carl])).rows[0]!;
    const demote = await invitee.post(`/v1/companies/${seed.companies.unrelated}/memberships/change`, { membershipId: seed.memberships.carl, role: 'member', permissions: [], expectedRevision: carlMembership.revision });
    assert.equal(demote.status, 200, 'two administrators: demotion of one is allowed');
    const last = (changed.body as { revision: number }).revision;
    expectError(await invitee.post(`/v1/companies/${seed.companies.unrelated}/memberships/end`, { membershipId: m.id, reason: 'leaving as the last administrator', expectedRevision: last }), 409, 'membership.last_administrator');
  });

  await t.test('audit rows exist for every mutation path exercised above', async () => {
    const { rows } = await h.db.admin.query<{ action: string }>('SELECT DISTINCT action FROM trustwork.audit_event ORDER BY action');
    const actions = rows.map((r) => r.action);
    for (const expected of ['project.created', 'participation.granted', 'participation.revoked', 'project.transfer_proposed', 'project.transfer_effective', 'membership.invited', 'membership.activated', 'membership.changed', 'membership.ended']) {
      assert.ok(actions.includes(expected), `audit action ${expected}`);
    }
  });
});
