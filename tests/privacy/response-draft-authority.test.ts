import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startHarness, SKIP_REASON, type Response } from '../backend/helpers/app.js';
import { privacyWorld } from './helpers.js';
import { caseGrants, supportCases } from '../../packages/data/src/repositories/admin.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { gate, waitFor } from '../worker/helpers/worker-db.js';

interface DraftBody { id: string; digest: string; package: { holds: { active: number } } }

// Outside the test: waiting for a shared cluster slot does not count against its timeout.
const h = await startHarness('privacy_draft_authority');

/**
 * PRV-001: a Draft names the holds on a subject, so it takes what a plan takes: a usable case grant naming the request
 * and independence from the subject. Each conflict below is isolated, so a refusal cannot be explained by another one.
 * Real PostgreSQL under the runtime role, through the API.
 */
test('PRV-001 response Drafts need the case grant and the conflict check, and both routes audit', { skip: h ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const w = await privacyWorld(h);
  const { officer, reviewer, subject } = w.people;
  const officerCtx = await w.context(officer); const reviewerCtx = await w.context(reviewer);
  const hubId = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.hub ORDER BY id LIMIT 1')).rows[0]!.id;
  const count = async (table: string, condition = 'true', values: unknown[] = []) => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM trustwork.${table} WHERE ${condition}`, values)).rows[0]!.n;
  const person = async (name: string) => (await h.db.admin.query<{ id: string }>('INSERT INTO trustwork.person(display_name) VALUES($1) RETURNING id', [name])).rows[0]!.id;
  const company = async () => (await h.db.admin.query<{ id: string }>("INSERT INTO trustwork.company(display_name) VALUES('Synthetic Draft Company') RETURNING id")).rows[0]!.id;
  const join = (who: string, where: string) => h.db.admin.query(`INSERT INTO trustwork.membership(person_id,company_id,role,permissions,status,valid_from)
    VALUES($1,$2,'administrator',ARRAY['company.members.manage'],'active',now())`, [who, where]);
  /** A request as stored, so the one who filed it and its subject can be set apart from every other fact. */
  const stored = async (requestedBy: string, kind: 'person' | 'company', id: string) => (await h.db.admin.query<{ id: string }>(`INSERT INTO trustwork.privacy_request(requested_by,subject_kind,subject_id,kind,country,policy_status)
    VALUES($1,$2,$3,'erasure','US','UNKNOWN') RETURNING id`, [requestedBy, kind, id])).rows[0]!.id;
  /** Opened by the reviewer, who stays independent; `requester` defaults to a third person. */
  const supportCase = async (party: { kind: 'person' | 'company'; id: string }, requester = subject) => (await w.as(reviewer, (trx) => supportCases.open(trx, reviewerCtx,
    { hubId, requesterPersonId: requester, subject: party, category: 'privacy', summary: 'Synthetic Draft authority' }))).id;
  const grantInput = (supportCaseId: string, objectIds: string[]) => ({ supportCaseId, objectType: 'privacy_request', objectIds, projectionClass: 'support_private_limited' as const, purpose: 'Synthetic Draft authority', expiresInSeconds: 3600 });
  const officerGrant = async (supportCaseId: string, objectIds: string[]) => {
    const requested = await w.as(officer, (trx) => caseGrants.request(trx, officerCtx, grantInput(supportCaseId, objectIds)));
    return (await w.as(reviewer, (trx) => caseGrants.decide(trx, reviewerCtx, requested.id, 'approve', requested.request_digest))).id;
  };
  const reviewerGrant = async (supportCaseId: string, objectIds: string[]) => {
    const requested = await w.as(reviewer, (trx) => caseGrants.request(trx, reviewerCtx, grantInput(supportCaseId, objectIds)));
    return (await w.as(officer, (trx) => caseGrants.decide(trx, officerCtx, requested.id, 'approve', requested.request_digest))).id;
  };
  /**
   * The commands refuse a grant request from a conflicted officer. Once a conflict arises an approved grant can still
   * exist, and these tests put one in place directly, so that what refuses below is the Draft's own check.
   */
  const standingGrant = async (supportCaseId: string, objectIds: string[]) => {
    const inserted = (await h.db.admin.query<{ id: string; request_digest: string }>(`INSERT INTO trustwork.case_access_grant(support_case_id,hub_id,requested_by,object_type,object_ids,projection_class,purpose,expires_in,request_digest)
      VALUES($1,$2,$3,'privacy_request',$4::uuid[],'support_private_limited','Synthetic standing grant',interval '1 hour',$5) RETURNING id, request_digest`, [supportCaseId, hubId, officer, objectIds, '0'.repeat(64)])).rows[0]!;
    return (await w.as(reviewer, (trx) => caseGrants.decide(trx, reviewerCtx, inserted.id, 'approve', inserted.request_digest))).id;
  };
  /** The officer cannot approve a grant about themselves, so the platform owner, who has no part in these cases, does. */
  const ownerApprovedGrant = async (supportCaseId: string, request: string) => {
    const owner = (await h.db.admin.query<{ person_id: string }>("SELECT person_id FROM trustwork.staff_role_assignment WHERE setup_bootstrap AND revoked_at IS NULL AND role='platform-owner' LIMIT 1")).rows[0]!.person_id;
    const ownerCtx = await w.context(owner);
    const requested = await w.as(reviewer, (trx) => caseGrants.request(trx, reviewerCtx, grantInput(supportCaseId, [request])));
    return (await w.as(owner, (trx) => caseGrants.decide(trx, ownerCtx, requested.id, 'approve', requested.request_digest))).id;
  };
  const prepare = (id: string, grantId: string, client = w.officer) => client.post(`/v1/admin/privacy/requests/${id}/response-draft`, { grantId });
  const read = (id: string, grantId: string, client = w.officer) => client.get(`/v1/admin/privacy/requests/${id}/response-drafts?grantId=${grantId}`);
  const refused = (r: Response, label: string) => {
    assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal((r.body as { details?: { reason?: string } }).details?.reason, 'privacy.case_grant_required', label);
    assert.doesNotMatch(JSON.stringify(r.body), /holds|package|digest/, `${label}: the refusal carries no Draft`);
  };
  const trail = async () => ({ audit: await count('audit_event', "action LIKE 'privacy.response_draft%'"), log: await count('access_log_entry', "object_type='privacy_request'"), drafts: await count('privacy_response_draft') });
  /** Both routes refused, with the same answer, and nothing written. */
  const bothRefused = async (id: string, grantId: string, label: string) => {
    const before = await trail();
    refused(await prepare(id, grantId), `${label}: prepare`);
    refused(await read(id, grantId), `${label}: read`);
    assert.deepEqual(await trail(), before, `${label}: a refusal writes nothing`);
  };

  await t.test('with the grant both routes work, and each use leaves an audit row and an access log entry', async () => {
    const request = await stored(subject, 'person', subject);
    const support = await supportCase({ kind: 'person', id: subject });
    const grantId = await officerGrant(support, [request]);
    const prepared = await prepare(request, grantId);
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    const draft = prepared.body as DraftBody;
    const audit = await h.db.admin.query<{ actor_person_id: string; object_kind: string; after_digest: string; basis: unknown; request_id: string | null }>(
      "SELECT actor_person_id, object_kind, after_digest, basis, request_id FROM trustwork.audit_event WHERE action='privacy.response_draft_prepared' AND object_id=$1", [request]);
    assert.equal(audit.rowCount, 1);
    const row = audit.rows[0]!;
    assert.equal(row.actor_person_id, officer); assert.equal(row.object_kind, 'privacy_request'); assert.equal(row.after_digest, draft.digest);
    assert.deepEqual(row.basis, { grantId, caseId: support }); assert.ok(row.request_id, 'the audit row names the API request');
    const listed = await read(request, grantId);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual((listed.body as { drafts: DraftBody[] }).drafts.map((d) => d.id), [draft.id]);
    assert.equal(await count('audit_event', "action='privacy.response_drafts_read' AND object_id=$1 AND actor_person_id=$2", [request, officer]), 1);
    const log = await h.db.admin.query<{ actor_person_id: string; grant_id: string; case_id: string; kind: string }>("SELECT actor_person_id, grant_id, case_id, kind FROM trustwork.access_log_entry WHERE object_type='privacy_request' AND object_id=$1", [request]);
    assert.deepEqual(log.rows, [{ actor_person_id: officer, grant_id: grantId, case_id: support, kind: 'case_read' }, { actor_person_id: officer, grant_id: grantId, case_id: support, kind: 'case_read' }]);
  });

  await t.test('the privacy read permission alone opens neither route', async () => {
    const request = await stored(subject, 'person', subject);
    const support = await supportCase({ kind: 'person', id: subject });
    const other = await stored(subject, 'person', subject);
    const elsewhere = await officerGrant(support, [other]);
    const theirs = await reviewerGrant(support, [request]);
    await bothRefused(request, randomUUID(), 'no such grant');
    await bothRefused(request, elsewhere, 'a grant naming another request');
    await bothRefused(request, theirs, 'a colleague\'s grant');
    assert.equal((await w.officer.post(`/v1/admin/privacy/requests/${request}/response-draft`, {})).status, 422, 'the grant is required');
    assert.equal((await w.officer.get(`/v1/admin/privacy/requests/${request}/response-drafts`)).status, 422, 'the grant is required');
    const revoked = await officerGrant(support, [request]);
    await w.as(reviewer, (trx) => caseGrants.revoke(trx, reviewerCtx, revoked));
    await bothRefused(request, revoked, 'a revoked grant');
    // A grant from a case about somebody else does not reach this subject, even when it names the request.
    const stranger = await person('Synthetic Unrelated Subject');
    await bothRefused(request, await officerGrant(await supportCase({ kind: 'person', id: stranger }), [request]), 'a grant from another subject\'s case');
  });

  await t.test('a staff subject: an officer never reads or prepares a Draft about themselves, and never learns of the hold', async () => {
    const request = await stored(subject, 'person', officer);
    const support = await supportCase({ kind: 'person', id: officer });
    await w.as(reviewer, (trx) => privacy.hold(trx, reviewerCtx, request, 'litigation', randomUUID()));
    const colleague = await prepare(request, await ownerApprovedGrant(support, request), w.reviewer);
    assert.equal(colleague.status, 201, JSON.stringify(colleague.body));
    assert.equal((colleague.body as DraftBody).package.holds.active, 1, 'the colleague\'s Draft names the hold');
    await bothRefused(request, await standingGrant(support, [request]), 'the subject');
  });

  await t.test('the person who filed the request is refused, even about somebody else', async () => {
    const request = await stored(officer, 'person', subject);
    const grantId = await standingGrant(await supportCase({ kind: 'person', id: subject }), [request]);
    await bothRefused(request, grantId, 'the filer');
  });

  await t.test('the requester of the case is refused', async () => {
    const request = await stored(subject, 'person', subject);
    const grantId = await standingGrant(await supportCase({ kind: 'person', id: subject }, officer), [request]);
    await bothRefused(request, grantId, 'the case requester');
  });

  await t.test('a member of the subject company: the grant works until the officer joins, and stops at once', async () => {
    const subjectCompany = await company();
    const request = await stored(subject, 'company', subjectCompany);
    const grantId = await officerGrant(await supportCase({ kind: 'company', id: subjectCompany }), [request]);
    assert.equal((await prepare(request, grantId)).status, 201);
    assert.equal((await read(request, grantId)).status, 200);
    await join(officer, subjectCompany);
    await bothRefused(request, grantId, 'the member');
  });

  await t.test('a declared conflict: refused while it stands, which also proves it is the cause', async () => {
    for (const party of [{ kind: 'person' as const, id: await person('Synthetic Declared Party') }, { kind: 'company' as const, id: await company() }]) {
      const request = await stored(subject, party.kind, party.id);
      const grantId = await officerGrant(await supportCase(party), [request]);
      assert.equal((await prepare(request, grantId)).status, 201, party.kind);
      const declared = (await h.db.admin.query<{ id: string }>(`INSERT INTO trustwork.staff_conflict_declaration(staff_person_id,${party.kind === 'person' ? 'conflict_person_id' : 'conflict_company_id'},reason)
        VALUES($1,$2,'Synthetic declared conflict') RETURNING id`, [officer, party.id])).rows[0]!.id;
      await bothRefused(request, grantId, `a declared conflict with a ${party.kind}`);
      await h.db.admin.query('UPDATE trustwork.staff_conflict_declaration SET ended_at=now() WHERE id=$1', [declared]);
      assert.equal((await read(request, grantId)).status, 200, `${party.kind}: the same grant works once the conflict has ended`);
    }
  });

  await t.test('revocation and preparation serialise on the grant: never a Draft under a revoked grant', async () => {
    const waiting = () => waitFor(async () => (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0]!.n > 0, 15_000, 'a blocked transaction');
    const request = await stored(subject, 'person', subject);
    const support = await supportCase({ kind: 'person', id: subject });
    const input = (grantId: string) => ({ requestId: request, grantId, coverage: [], delegation: null, auditRequestId: 'req-synthetic-race' });

    // Preparation first: the revocation waits for it, so the Draft was made under a live grant, and the next one is refused.
    const first = await officerGrant(support, [request]);
    const inside = gate(); const finish = gate();
    const preparing = w.as(officer, async (trx) => { const row = await privacy.prepareResponseDraft(trx, input(first)); inside.open(); await finish.promise; return row; });
    await inside.promise;
    const revoking = w.as(reviewer, (trx) => caseGrants.revoke(trx, reviewerCtx, first));
    await waiting();
    finish.open();
    assert.ok((await preparing).id); await revoking;
    await bothRefused(request, first, 'after the revocation');

    // Revocation first: preparation waits for its commit and then sees a revoked grant.
    const second = await officerGrant(support, [request]);
    const revoked = gate(); const commit = gate();
    const revocation = w.as(reviewer, async (trx) => { await caseGrants.revoke(trx, reviewerCtx, second); revoked.open(); await commit.promise; });
    await revoked.promise;
    const before = await trail();
    const late = w.as(officer, (trx) => privacy.prepareResponseDraft(trx, input(second))).then(() => 'prepared', (e: { hint?: string }) => e.hint);
    await waiting();
    commit.open(); await revocation;
    assert.equal(await late, 'privacy.case_grant_required');
    assert.deepEqual(await trail(), before);
  });
});
