import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { auditSequenceContinuous } from '@trustwork/contracts';
import { createPool, type DataPool } from '@trustwork/data';
import { adminDigests, caseGrants, supportCases, type CommandContext } from '../../../packages/data/src/repositories/admin.js';
import { provisionTestDatabase, SKIP_REASON, untilDatabaseTimePasses } from '../helpers/postgres.js';
import { actors, buildAdminWorld, fieldsHash, rejects, type AdminWorld } from './helpers.js';

// Weight 2: the runtime pool holds up to ten connections for the racing approvers.
const db = await provisionTestDatabase('admin_cases', { weight: 2 });

test('support cases and case access grants: the only staff path to private objects, time-boxed, second-person approved and logged', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 10 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, assign, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hubScope = { kind: 'hub', hubId: w.hubId } as const;
  await assign({ personId: p.agent, role: 'support-agent', scope: hubScope });
  await assign({ personId: p.lead, role: 'support-lead', scope: hubScope });
  await assign({ personId: p.lead2, role: 'support-lead', scope: hubScope });
  await assign({ personId: p.otherAgent, role: 'support-agent', scope: { kind: 'hub', hubId: w.otherHubId } });

  // A private project of the customer with evidence files of every class (synthetic).
  const { project, otherProject, files } = await owner(async (trx) => {
    const mk = async (name: string) => (await trx.insertInto('project').values({ owner_person_id: p.customer, creator_person_id: p.customer, name }).returning('id').executeTakeFirstOrThrow()).id;
    const projectId = await mk('Synthetic private house extension');
    const otherId = await mk('Synthetic other project');
    const file = async (parent: string, classification: 'restricted' | 'party_private' | 'owner_private' | 'public', scan: 'clean' | 'quarantined' = 'clean') =>
      (await trx.insertInto('evidence_artifact').values({ owner_person_id: p.customer, parent_kind: 'project', parent_id: parent, classification, storage_key: `synthetic/${randomBytes(8).toString('hex')}`,
        sha256: randomBytes(32).toString('hex'), bytes: '1024', media_type: 'application/pdf', uploaded_by: p.customer, scan_state: scan }).returning('id').executeTakeFirstOrThrow()).id;
    return {
      project: projectId, otherProject: otherId,
      files: { restricted: await file(projectId, 'restricted'), partyPrivate: await file(projectId, 'party_private'), quarantined: await file(projectId, 'restricted', 'quarantined'), other: await file(otherId, 'restricted') },
    };
  });

  let agentCtx: CommandContext;
  let leadCtx: CommandContext;
  let lead2Ctx: CommandContext;
  let caseId: string;
  await t.test('cases: a person opens one about themselves; staff of the hub see it; nobody else does', async () => {
    const own = await as(p.customer, (trx) => supportCases.openOwn(trx, { hubId: w.hubId, category: 'account_access', summary: 'Synthetic: cannot see my project files' }));
    caseId = own.id;
    assert.deepEqual([own.status, own.requester_person_id, own.subject_person_id, own.opened_by], ['open', p.customer, p.customer, p.customer]);
    await rejects(as(p.customer, (trx) => supportCases.openOwn(trx, { hubId: w.hubId, forCompany: true, category: 'billing', summary: 'x' })), '42501', 'admin.forbidden');
    const company = await as(p.employee, (trx) => supportCases.openOwn(trx, { hubId: w.hubId, forCompany: true, category: 'billing', summary: 'Synthetic company question' }));
    assert.equal(company.subject_company_id, w.company);
    assert.ok((await as(p.agent, (trx) => supportCases.get(trx, caseId))), 'hub support staff see the case');
    assert.equal(await as(p.outsider, (trx) => supportCases.get(trx, caseId)), undefined);
    assert.equal(await as(p.otherAgent, (trx) => supportCases.get(trx, caseId)), undefined, 'support staff of another hub see nothing');
    assert.equal(await as(p.employee, (trx) => supportCases.get(trx, caseId)), undefined);
    await rejects(as(p.customer, (trx) => trx.insertInto('support_case').values({ hub_id: w.hubId, requester_person_id: p.customer, opened_by: p.customer, subject_person_id: p.customer, category: 'x_y', summary: 'x' }).execute()), '42501');
    agentCtx = await elevate(p.agent);
    leadCtx = await elevate(p.lead);
    lead2Ctx = await elevate(p.lead2);
    // Staff on behalf of someone: never about themselves or their own employer.
    await rejects(as(p.agent, (trx) => supportCases.open(trx, agentCtx, { hubId: w.hubId, requesterPersonId: p.employee, subject: { kind: 'company', id: w.company }, category: 'billing', summary: 'x' })), '42501', 'admin.conflict_of_interest');
    await rejects(as(p.agent, (trx) => supportCases.open(trx, agentCtx, { hubId: w.hubId, requesterPersonId: p.agent, subject: { kind: 'person', id: p.agent }, category: 'billing', summary: 'x' })), '42501', 'admin.conflict_of_interest');
    const behalf = await as(p.lead, (trx) => supportCases.open(trx, leadCtx, { hubId: w.hubId, requesterPersonId: p.employee, subject: { kind: 'company', id: w.company }, category: 'billing', summary: 'Synthetic on behalf', priority: 'high' }));
    assert.equal(behalf.opened_by, p.lead);
    await rejects(as(p.agent, (trx) => supportCases.update(trx, agentCtx, behalf.id, { status: 'triaged' })), '42501', 'admin.conflict_of_interest');
    await rejects(as(p.otherAgent, async (trx) => supportCases.open(trx, await elevate(p.otherAgent), { hubId: w.hubId, requesterPersonId: p.customer, subject: { kind: 'person', id: p.customer }, category: 'x_y', summary: 'x' })), '42501', 'admin.forbidden');
  });

  await t.test('lifecycle and notes: transitions follow the lifecycle; closing needs admin.support.case.close; requesters see only notes meant for them', async () => {
    await rejects(as(p.agent, (trx) => supportCases.update(trx, agentCtx, caseId, { status: 'resolved' })), '23514', 'admin.invalid_transition');
    const triaged = await as(p.agent, (trx) => supportCases.update(trx, agentCtx, caseId, { status: 'triaged', assignedTo: p.agent }));
    assert.equal(triaged.assigned_to, p.agent);
    await rejects(as(p.lead, (trx) => supportCases.update(trx, leadCtx, caseId, { assignedTo: p.outsider })), '23514', 'admin.assignee_invalid');
    await rejects(as(p.customer, (trx) => supportCases.requesterUpdate(trx, caseId, 'closed')), '23514', 'admin.invalid_transition');
    await as(p.agent, (trx) => supportCases.addNote(trx, agentCtx, caseId, 'Synthetic internal diagnosis without private payloads', 'internal'));
    await as(p.agent, (trx) => supportCases.addNote(trx, agentCtx, caseId, 'Synthetic: we are looking into it', 'requester'));
    await as(p.customer, (trx) => supportCases.addRequesterNote(trx, caseId, 'Synthetic: thank you'));
    await rejects(as(p.outsider, (trx) => supportCases.addRequesterNote(trx, caseId, 'x')), 'P0002', 'admin.not_found');
    const seenByCustomer = await as(p.customer, (trx) => supportCases.notes(trx, caseId));
    assert.deepEqual(seenByCustomer.map((n) => n.visibility), ['requester', 'requester']);
    assert.equal((await as(p.agent, (trx) => supportCases.notes(trx, caseId))).length, 3);
    assert.equal((await as(p.outsider, (trx) => supportCases.notes(trx, caseId))).length, 0);
    await rejects(owner((trx) => trx.updateTable('support_case_note').set({ body: 'rewritten' }).where('support_case_id', '=', caseId).execute()), '23000', 'audit.append_only');
    await rejects(as(p.agent, (trx) => trx.insertInto('support_case_note').values({ support_case_id: caseId, author_person_id: p.agent, body: 'x', visibility: 'internal' }).execute()), '42501');
  });

  let grantId: string;
  let grantDigest: string;
  await t.test('grant request: inside an open case, named objects, at most the role cap and 72 hours, digest computed by the database', async () => {
    const input = { supportCaseId: caseId, objectType: 'project', objectIds: [project], projectionClass: 'evidence' as const, purpose: 'Synthetic: verify the uploaded permit file', expiresInSeconds: 3600 };
    await rejects(as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { ...input, expiresInSeconds: 25 * 3600 })), '23514', 'admin.grant_too_long');
    await rejects(as(p.lead, (trx) => caseGrants.request(trx, leadCtx, { ...input, expiresInSeconds: 73 * 3600 })), '23514', 'admin.grant_too_long');
    await rejects(as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { ...input, objectIds: [] })), '23514');
    await rejects(as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { ...input, objectIds: Array.from({ length: 101 }, () => project) })), '23514');
    await rejects(as(p.otherAgent, async (trx) => caseGrants.request(trx, await elevate(p.otherAgent), input)), '42501', 'admin.forbidden');
    const grant = await as(p.agent, (trx) => caseGrants.request(trx, agentCtx, input));
    grantId = grant.id;
    grantDigest = grant.request_digest;
    assert.equal(grant.status, 'requested');
    assert.equal(grant.request_digest, adminDigests.caseGrant(input), 'the application can show the approver exactly what the database binds');
    assert.deepEqual([...grant.excluded_field_classes].sort(), ['credentials', 'negotiation_private', 'payment_refs']);
    assert.equal(grant.hub_id, w.hubId);
    assert.equal(await as(p.agent, (trx) => caseGrants.covers(trx, 'project', project)), false, 'a requested grant opens nothing');
    await rejects(as(p.agent, (trx) => caseGrants.evidence(trx, grantId, files.restricted, fieldsHash())), 'P0002', 'admin.not_found');
    // Raw writes are impossible for the runtime role; the owner path cannot widen or self-approve a grant either.
    await rejects(as(p.agent, (trx) => trx.updateTable('case_access_grant').set({ status: 'approved' }).where('id', '=', grantId).execute()), '42501');
    await rejects(owner((trx) => trx.updateTable('case_access_grant').set({ object_ids: [project, otherProject] }).where('id', '=', grantId).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.updateTable('case_access_grant').set({ status: 'approved', approved_by: p.agent, approved_at: new Date(), expires_at: new Date(Date.now() + 3_600_000) }).where('id', '=', grantId).execute()), '23514');
    await rejects(owner((trx) => trx.deleteFrom('case_access_grant').where('id', '=', grantId).execute()), '23000', 'audit.append_only');
    await rejects(owner((trx) => trx.insertInto('case_access_grant').values({ support_case_id: caseId, hub_id: w.hubId, requested_by: p.agent, object_type: 'project', object_ids: [project], projection_class: 'evidence',
      purpose: 'x', expires_in: '73 hours', request_digest: '0'.repeat(64) }).execute()), '23514');
    await rejects(owner((trx) => trx.insertInto('case_access_grant').values({ support_case_id: caseId, hub_id: w.hubId, requested_by: p.agent, object_type: 'project', object_ids: [project], projection_class: 'evidence',
      purpose: 'x', expires_in: '1 hour', request_digest: '0'.repeat(64), excluded_field_classes: ['credentials'] }).execute()), '23514');
  });

  await t.test('grant decision: never by the requester, by a holder of admin.support.grant.approve who restates the digest', async () => {
    await rejects(as(p.agent, (trx) => caseGrants.decide(trx, agentCtx, grantId, 'approve', grantDigest)), '42501', 'admin.self_approval');
    await rejects(as(p.otherAgent, async (trx) => caseGrants.decide(trx, await elevate(p.otherAgent), grantId, 'approve', grantDigest)), '42501', 'admin.forbidden');
    await rejects(as(p.lead, (trx) => caseGrants.decide(trx, leadCtx, grantId, 'approve', 'a'.repeat(64))), '23514', 'access.approval_digest_mismatch');
    // A lead's own request is never approved by that lead.
    const own = await as(p.lead, (trx) => caseGrants.request(trx, leadCtx, { supportCaseId: caseId, objectType: 'project', objectIds: [project], projectionClass: 'diagnostic', purpose: 'Synthetic', expiresInSeconds: 600 }));
    await rejects(as(p.lead, (trx) => caseGrants.decide(trx, leadCtx, own.id, 'approve', own.request_digest)), '42501', 'admin.self_approval');
    const approved = await as(p.lead, (trx) => caseGrants.decide(trx, leadCtx, grantId, 'approve', grantDigest));
    assert.equal(approved.approved_by, p.lead);
    assert.equal(approved.expires_at!.getTime() - approved.approved_at!.getTime(), 3_600_000);
    const audit = await owner((trx) => trx.selectFrom('admin_audit_event').selectAll().where('object_id', '=', grantId).orderBy('sequence').execute());
    assert.deepEqual(audit.map((a) => [a.action, a.case_id, a.permission]), [['support.grant_request', caseId, 'admin.support.grant.request'], ['support.grant_approve', caseId, 'admin.support.grant.approve']]);
    await rejects(as(p.lead2, (trx) => caseGrants.decide(trx, lead2Ctx, grantId, 'deny', grantDigest)), '23514', 'admin.grant_not_requested');
  });

  await t.test('concurrency: two approvers racing on one grant request; exactly one decision wins each time', async () => {
    for (let round = 0; round < 4; round++) {
      const g = await as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { supportCaseId: caseId, objectType: 'project', objectIds: [project], projectionClass: 'diagnostic', purpose: `Synthetic race ${round}`, expiresInSeconds: 600 }));
      const results = await Promise.allSettled([
        as(p.lead, (trx) => caseGrants.decide(trx, leadCtx, g.id, 'approve', g.request_digest)),
        as(p.lead2, (trx) => caseGrants.decide(trx, lead2Ctx, g.id, round % 2 ? 'approve' : 'deny', g.request_digest)),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `round ${round}`);
      assert.equal(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as { hint?: string }).hint, 'admin.grant_not_requested');
      await as(p.agent, (trx) => caseGrants.revoke(trx, agentCtx, g.id)).catch(() => undefined);
    }
  });

  await t.test('reads under an approved grant: only the grantee, only the named objects, restricted files only under `evidence`, every read logged', async () => {
    assert.equal(await as(p.agent, (trx) => caseGrants.covers(trx, 'project', project)), true);
    assert.equal(await as(p.agent, (trx) => caseGrants.covers(trx, 'project', otherProject)), false);
    assert.equal(await as(p.lead, (trx) => caseGrants.covers(trx, 'project', project)), false, 'the approver gains no access');
    // The grant does not widen ordinary row-level security: the private project stays invisible to staff queries.
    assert.equal((await as(p.agent, (trx) => trx.selectFrom('project').select('id').where('id', '=', project).execute())).length, 0);
    assert.equal((await as(p.agent, (trx) => trx.selectFrom('evidence_artifact').select('id').where('parent_id', '=', project).execute())).length, 0);
    const restricted = await as(p.agent, (trx) => caseGrants.evidence(trx, grantId, files.restricted, fieldsHash()));
    assert.equal(restricted.classification, 'restricted');
    assert.ok(restricted.storage_key.startsWith('synthetic/'));
    const party = await as(p.agent, (trx) => caseGrants.evidence(trx, grantId, files.partyPrivate, fieldsHash()));
    assert.equal(party.classification, 'party_private');
    await rejects(as(p.agent, (trx) => caseGrants.evidence(trx, grantId, files.quarantined, fieldsHash())), 'P0002', 'admin.not_found');
    await rejects(as(p.agent, (trx) => caseGrants.evidence(trx, grantId, files.other, fieldsHash())), 'P0002', 'admin.not_found');
    await rejects(as(p.lead, (trx) => caseGrants.evidence(trx, grantId, files.restricted, fieldsHash())), 'P0002', 'admin.not_found');
    await rejects(as(p.customer, (trx) => caseGrants.evidence(trx, grantId, files.restricted, fieldsHash())), 'P0002', 'admin.not_found');
    // The owner sees their own non-restricted files as before, never their restricted ones through the runtime policy.
    const ownerView = await as(p.customer, (trx) => trx.selectFrom('evidence_artifact').select(['id', 'classification']).where('parent_id', '=', project).execute());
    assert.ok(ownerView.every((f) => f.classification !== 'restricted'));
    // A diagnostic grant never opens a file; support_private_limited opens non-restricted files only.
    const openWith = async (projectionClass: 'diagnostic' | 'support_private_limited', objectType = 'project', ids = [project]) => {
      const g = await as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { supportCaseId: caseId, objectType, objectIds: ids, projectionClass, purpose: 'Synthetic', expiresInSeconds: 600 }));
      return as(p.lead, (trx) => caseGrants.decide(trx, leadCtx, g.id, 'approve', g.request_digest));
    };
    const diagnostic = await openWith('diagnostic');
    await rejects(as(p.agent, (trx) => caseGrants.evidence(trx, diagnostic.id, files.partyPrivate, fieldsHash())), 'P0002', 'admin.not_found');
    const limited = await openWith('support_private_limited');
    await rejects(as(p.agent, (trx) => caseGrants.evidence(trx, limited.id, files.restricted, fieldsHash())), 'P0002', 'admin.not_found');
    assert.equal((await as(p.agent, (trx) => caseGrants.evidence(trx, limited.id, files.partyPrivate, fieldsHash()))).id, files.partyPrivate);
    const byFile = await openWith('support_private_limited', 'evidence_artifact', [files.partyPrivate]);
    assert.equal((await as(p.agent, (trx) => caseGrants.evidence(trx, byFile.id, files.partyPrivate, fieldsHash()))).id, files.partyPrivate);
    await rejects(as(p.agent, (trx) => caseGrants.evidence(trx, byFile.id, files.restricted, fieldsHash())), 'P0002', 'admin.not_found');

    // Every successful read wrote an access-log row; the application logs other reads itself, only under its own usable grant.
    const log = await as(p.agent, (trx) => caseGrants.accessLog(trx));
    assert.equal(log.length, 4);
    assert.ok(log.every((e) => e.actor_person_id === p.agent && e.kind === 'evidence_view' && e.case_id === caseId && e.hub_id === w.hubId));
    await as(p.agent, (trx) => caseGrants.logAccess(trx, { actorPersonId: p.agent, grantId, caseId, hubId: w.hubId, kind: 'case_read', objectType: 'project', objectId: project, fieldsHash: fieldsHash() }));
    await rejects(as(p.agent, (trx) => caseGrants.logAccess(trx, { actorPersonId: p.agent, grantId, caseId, hubId: w.hubId, kind: 'case_read', objectType: 'project', objectId: otherProject, fieldsHash: fieldsHash() })), '42501');
    await rejects(as(p.lead, (trx) => caseGrants.logAccess(trx, { actorPersonId: p.lead, grantId, caseId, hubId: w.hubId, kind: 'case_read', objectType: 'project', objectId: project, fieldsHash: fieldsHash() })), '23514', 'admin.grant_mismatch');
    assert.equal((await as(p.customer, (trx) => caseGrants.accessLog(trx))).length, 0);
    assert.equal((await as(p.lead, (trx) => caseGrants.accessLog(trx))).length, 0, 'access-log reading needs admin.audit.read');
    assert.equal((await as(p.owner, (trx) => caseGrants.accessLog(trx))).length, 5, 'a platform auditor reads the access log');
    const someEntry = log[0]!.id;
    await rejects(as(p.agent, (trx) => trx.updateTable('access_log_entry').set({ kind: 'audit_read' }).where('id', '=', someEntry).execute()), '42501');
    await rejects(as(p.agent, (trx) => trx.deleteFrom('access_log_entry').where('id', '=', someEntry).execute()), '42501');
    await rejects(owner((trx) => trx.updateTable('access_log_entry').set({ kind: 'audit_read' }).where('id', '=', someEntry).execute()), '23000', 'audit.append_only');
    await rejects(owner((trx) => trx.deleteFrom('access_log_entry').where('id', '=', someEntry).execute()), '23000', 'audit.append_only');
    const sequences = (await owner((trx) => trx.selectFrom('access_log_entry').select('sequence').orderBy('sequence').execute())).map((r) => Number(r.sequence));
    assert.ok(sequences[0] === 1 && auditSequenceContinuous(sequences), sequences.join(','));
  });

  await t.test('expiry and revocation: an expired or revoked grant opens nothing', async () => {
    const short = await as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { supportCaseId: caseId, objectType: 'project', objectIds: [project], projectionClass: 'evidence', purpose: 'Synthetic short grant', expiresInSeconds: 2 }));
    const approved = await as(p.lead, (trx) => caseGrants.decide(trx, leadCtx, short.id, 'approve', short.request_digest));
    assert.equal(approved.expires_at!.getTime() - approved.approved_at!.getTime(), 2000);
    assert.equal((await as(p.agent, (trx) => caseGrants.evidence(trx, short.id, files.restricted, fieldsHash()))).id, files.restricted);
    await untilDatabaseTimePasses(db.admin, approved.expires_at as Date);
    await rejects(as(p.agent, (trx) => caseGrants.evidence(trx, short.id, files.restricted, fieldsHash())), 'P0002', 'admin.not_found');
    await rejects(as(p.agent, (trx) => caseGrants.logAccess(trx, { actorPersonId: p.agent, grantId: short.id, caseId, hubId: w.hubId, kind: 'case_read', objectType: 'project', objectId: project, fieldsHash: fieldsHash() })), '42501');
    // The main grant is revoked by its grantee.
    const revoked = await as(p.agent, (trx) => caseGrants.revoke(trx, agentCtx, grantId));
    assert.deepEqual([revoked.status, revoked.revoke_reason, revoked.revoked_by], ['revoked', 'requester_done', p.agent]);
    assert.equal(await as(p.agent, (trx) => caseGrants.covers(trx, 'project', project)), true, 'other grants of the agent still name the project');
    await rejects(as(p.agent, (trx) => caseGrants.evidence(trx, grantId, files.restricted, fieldsHash())), 'P0002', 'admin.not_found');
    await rejects(as(p.agent, (trx) => caseGrants.revoke(trx, agentCtx, grantId)), '23514', 'admin.invalid_transition');
  });

  await t.test('closing the case revokes every open grant in the same transaction; a closed case takes no grants or notes', async () => {
    const live = await as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { supportCaseId: caseId, objectType: 'project', objectIds: [project], projectionClass: 'evidence', purpose: 'Synthetic before close', expiresInSeconds: 3600 }));
    await as(p.lead, (trx) => caseGrants.decide(trx, leadCtx, live.id, 'approve', live.request_digest));
    const pending = await as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { supportCaseId: caseId, objectType: 'project', objectIds: [project], projectionClass: 'diagnostic', purpose: 'Synthetic pending', expiresInSeconds: 600 }));
    await as(p.agent, (trx) => supportCases.update(trx, agentCtx, caseId, { status: 'in_progress' }));
    await as(p.agent, (trx) => supportCases.update(trx, agentCtx, caseId, { status: 'resolved' }));
    await rejects(as(p.agent, (trx) => supportCases.update(trx, agentCtx, caseId, { status: 'closed' })), '42501', 'admin.forbidden');
    const reopened = await as(p.customer, (trx) => supportCases.requesterUpdate(trx, caseId, 'open'));
    assert.equal(reopened.resolved_at, null);
    await as(p.lead, (trx) => supportCases.update(trx, leadCtx, caseId, { status: 'triaged' }));
    await as(p.lead, (trx) => supportCases.update(trx, leadCtx, caseId, { status: 'in_progress' }));
    await as(p.lead, (trx) => supportCases.update(trx, leadCtx, caseId, { status: 'resolved', resolutionCode: 'explained' }));
    const closed = await as(p.customer, (trx) => supportCases.requesterUpdate(trx, caseId, 'closed'));
    assert.deepEqual([closed.status, closed.closed_by], ['closed', p.customer]);
    const grants = await owner((trx) => trx.selectFrom('case_access_grant').select(['id', 'status', 'revoke_reason', 'revoked_by']).where('id', 'in', [live.id, pending.id]).execute());
    for (const g of grants) assert.deepEqual([g.status, g.revoke_reason, g.revoked_by], ['revoked', 'case_closed', p.customer]);
    assert.equal(await as(p.agent, (trx) => caseGrants.covers(trx, 'project', project)), false, 'no grant survives the case');
    await rejects(as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { supportCaseId: caseId, objectType: 'project', objectIds: [project], projectionClass: 'evidence', purpose: 'x', expiresInSeconds: 60 })), '23514', 'admin.case_closed');
    await rejects(as(p.agent, (trx) => supportCases.addNote(trx, agentCtx, caseId, 'x', 'internal')), '23514', 'admin.case_closed');
    await rejects(as(p.lead, (trx) => supportCases.update(trx, leadCtx, caseId, { status: 'open' })), '23514', 'admin.invalid_transition');
    await rejects(owner((trx) => trx.deleteFrom('support_case').where('id', '=', caseId).execute()), '23000', 'audit.append_only');
    const number = await owner((trx) => trx.selectFrom('support_case').select('number').where('id', '=', caseId).executeTakeFirstOrThrow());
    assert.match(String(number.number), /^[1-9][0-9]*$/);
    const stillApproved = await owner((trx) => trx.selectFrom('case_access_grant').select('id').where('support_case_id', '=', caseId).where('status', '=', 'approved').execute());
    assert.equal(stillApproved.length, 0);
  });
});
