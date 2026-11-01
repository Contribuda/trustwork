import { installSyntheticServingHub } from '../../agent-modules/serving-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../helpers/app.js';
import { EMAILS, login, seedPersonas, type PersonaKey } from '../helpers/personas.js';
import { auditCount, count } from '../hardening/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS, IDEMPOTENT_ROUTES } from '../../../apps/api/src/common/idempotency/index.js';
import { installCrashPoints, recordState } from './helpers.js';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { budgets } from '../../../packages/data/src/repositories/billing.js';
import { principalFor } from '../../data/helpers/seed.js';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';
import { screenEveryoneClear } from '../../screening-gates/helpers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemBlobStore } from '../../../packages/data/src/files/index.js';
import { randomUUID } from 'node:crypto';
import { elevate, enrol } from '../second-factor/helpers.js';
import { crashAdminRoutes } from '../../admin/crash-routes.js';
import { artifactOn, buildAgreement, businessDate } from '../../trust/helpers.js';
import { runs, serviceBacklog } from '../../../packages/data/src/repositories/assistant.js';
import { assistantService, mandateStore } from '../../assistant/helpers.js';
import { loadCrashCases } from './cases.js';

// FILE-001: the files routes are mounted only with a blob store; the storage fake keeps everything local.
const h = await startHarness('idem_crash', { files: { store: new FilesystemBlobStore({ root: mkdtempSync(join(tmpdir(), 'trustwork-crash-files-')) }) } });

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
  await installSyntheticServingHub(h);
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
    const mail = (await h.mail.lastTo(EMAILS.petr, 'membership_invitation'))!;
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

  await t.test('plans (PLAN-001): versions, changes, shares, item state, location, permits, diary', async () => {
    const reference = await kernelReference.fromRepository();
    await withMaintenance(h.db.admin, (trx) => kernelSync.apply(trx, reference));
    const project = await newProject('Exactly-once plan project');
    const P = `/v1/projects/${project.id}/plan`;
    const milestone = (key: string) => ({
      key, parentKey: null, kind: 'milestone', title: `Milestone ${key}`, description: null, stepTerms: [], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null,
      riskLevel: null, decisionQuestion: null, sources: [], attachments: [], privateNotes: null,
    });
    const content = { summary: null, assumptions: [], budget: null, timeline: null, items: [milestone('m'), milestone('n')], dependencies: [{ predecessorKey: 'm', successorKey: 'n', type: 'fs', lagDays: 0 }] };
    type Version = { id: string; revision: number; digest: { value: string } | null };
    const plan = (await exactlyOnce({ action: 'plan.create', client: petr, url: P, body: { timeZone: 'America/Los_Angeles', actor: { via: 'person' }, content }, effects: () => auditCount(h.db.admin, 'plan.created') })).body as { draft: Version };
    const saved = (await exactlyOnce({
      action: 'plan.draft_save', client: petr, url: `${P}/versions/${plan.draft.id}/content`, body: { expectedRevision: plan.draft.revision, content: { ...content, summary: 'saved once' }, actor: { via: 'person' } },
      effects: () => auditCount(h.db.admin, 'plan.draft_saved'),
    })).body as Version;
    const proposed = (await exactlyOnce({
      action: 'plan.version_propose', client: petr, url: `${P}/versions/${plan.draft.id}/propose`, body: { expectedRevision: saved.revision, actor: { via: 'person' } },
      effects: () => auditCount(h.db.admin, 'plan.version_proposed'),
    })).body as Version;
    const approved = (await exactlyOnce({
      action: 'plan.version_approve', client: petr, url: `${P}/versions/${plan.draft.id}/approve`, body: { expectedRevision: proposed.revision, digest: proposed.digest },
      effects: () => auditCount(h.db.admin, 'plan.version_approved'),
    })).body as Version;
    const v2 = (await exactlyOnce({ action: 'plan.draft_create', client: petr, url: `${P}/versions`, body: { basedOnVersionId: null, actor: { via: 'person' } }, effects: () => auditCount(h.db.admin, 'plan.draft_created') })).body as Version;
    const v2proposed = (await petr.post(`${P}/versions/${v2.id}/propose`, { expectedRevision: v2.revision, actor: { via: 'person' } })).body as Version;
    const change = (await exactlyOnce({
      action: 'plan.change_record', client: petr, url: `${P}/changes`,
      body: { fromVersionId: approved.id, toVersionId: v2.id, reason: 'Exactly-once change', cause: 'owner_request', requestedBy: { kind: 'person', id: seed.people.petr }, accountable: { kind: 'person', id: seed.people.petr }, agreementId: null, scheduleImpactDays: null },
      effects: () => auditCount(h.db.admin, 'plan.change_recorded'),
    })).body as { id: string; revision: number };
    await exactlyOnce({
      action: 'plan.change_decide', client: petr, url: `${P}/changes/${change.id}/decide`, body: { decision: 'approve', expectedRevision: change.revision, digest: v2proposed.digest },
      effects: () => auditCount(h.db.admin, 'plan.change_approved'),
    });
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.plan_version WHERE id = $1 AND status = 'approved'", [v2.id]), 1);
    const v3 = await created(await petr.post(`${P}/versions`, { basedOnVersionId: null, actor: { via: 'person' } }));
    const v3proposed = (await petr.post(`${P}/versions/${v3.id}/propose`, { expectedRevision: v3.revision, actor: { via: 'person' } })).body as Version;
    await exactlyOnce({
      action: 'plan.version_return', client: petr, url: `${P}/versions/${v3.id}/return`, body: { expectedRevision: v3proposed.revision, reason: 'Exactly-once return' },
      effects: () => auditCount(h.db.admin, 'plan.version_returned'),
    });
    await exactlyOnce({
      action: 'project.location_set', client: petr, url: `/v1/projects/${project.id}/location`,
      body: { address: null, regionCode: 'US-CA', cadastralRef: null, siteContact: null, siteAccessNotes: null, expectedRevision: null },
      effects: () => auditCount(h.db.admin, 'project.location_set'),
    });
    const shareRequest = { itemKey: 'm', audience: 'invited', invitee: { kind: 'person', id: seed.people.carl }, fields: ['scope', 'locality'], acceptanceRef: null };
    const preview = (await petr.post(`${P}/shares/preview`, shareRequest)).body as { previewDigest: unknown };
    const share = (await exactlyOnce({
      action: 'plan.item_share', client: petr, url: `${P}/shares`, body: { ...shareRequest, validUntil: null, previewDigest: preview.previewDigest },
      effects: () => auditCount(h.db.admin, 'plan.item_shared'),
    })).body as { id: string; revision: number };
    await exactlyOnce({
      action: 'plan.share_revoke', client: petr, url: `${P}/shares/${share.id}/revoke`, body: { expectedRevision: share.revision, reason: 'Exactly-once revoke' },
      effects: () => auditCount(h.db.admin, 'plan.share_revoked'),
    });
    await exactlyOnce({
      action: 'plan.item_state', client: petr, url: `${P}/items/m/state`, body: { status: 'accepted', path: 'self', link: null, actualStart: null, actualEnd: null, expectedRevision: null },
      effects: () => auditCount(h.db.admin, 'plan.item_state_changed'),
    });
    await exactlyOnce({
      action: 'project.permit_record', client: petr, url: `/v1/projects/${project.id}/permits`,
      body: { planItemKey: null, jurisdiction: 'US-CA', permitType: 'permit.building', authority: 'Demo County Building Department', number: null, appliedAt: null, issuedAt: null, expiresAt: null, inspectionResults: [], evidence: [], status: 'planned' },
      effects: () => auditCount(h.db.admin, 'project.permit_recorded'),
    });
    await exactlyOnce({
      action: 'project.diary_add', client: petr, url: `/v1/projects/${project.id}/diary`,
      body: { entryDate: '2027-03-02', text: 'Exactly-once diary entry', evidence: [], planItemKey: null, visibility: 'owner_private' },
      effects: () => auditCount(h.db.admin, 'project.diary_entry_added'),
    });
  });

  await t.test('commerce (COM-001): catalogue, needs, RFQs, invitations', async () => {
    const reference = await kernelReference.fromRepository();
    await withMaintenance(h.db.admin, (trx) => kernelSync.apply(trx, reference));
    const me = { kind: 'person', id: seed.people.petr };
    const person = { via: 'person' };
    type Offering = { offering: { id: string; revision: number }; versions: { id: string; version: number }[] };
    const offeringPayload = (title: string) => ({ title, description: null, specification: { size: '60 mm' }, unit: 'm2', listPrice: null, options: [], availability: { state: 'unknown', capacity: null, observedAt: '2026-10-31T10:00:00.000Z' }, components: [] });
    const draft = (title: string) => ({ payload: offeringPayload(title), publicFields: ['title'], privateKnowledge: { costBasis: null, marginTarget: null, notes: null } });
    let offering = (await exactlyOnce({ action: 'offering.create', client: petr, url: '/v1/catalogue', body: { owner: me, kind: 'goods', draft: draft('Exactly-once pavers'), actor: person }, effects: () => auditCount(h.db.admin, 'offering.created') })).body as Offering;
    const O = `/v1/catalogue/${offering.offering.id}`;
    offering = (await exactlyOnce({ action: 'offering.version_publish', client: petr, url: `${O}/versions/${offering.versions[0]!.id}/publish`, body: { expectedRevision: offering.offering.revision, actor: person }, effects: () => auditCount(h.db.admin, 'offering.version_published') })).body as Offering;
    offering = (await exactlyOnce({ action: 'offering.draft_open', client: petr, url: `${O}/versions`, body: { expectedRevision: offering.offering.revision, actor: person }, effects: () => auditCount(h.db.admin, 'offering.draft_opened') })).body as Offering;
    const v2 = offering.versions.find((v) => v.version === 2)!;
    offering = (await exactlyOnce({ action: 'offering.draft_save', client: petr, url: `${O}/versions/${v2.id}`, body: { expectedRevision: offering.offering.revision, draft: draft('Exactly-once pavers v2'), actor: person }, effects: () => auditCount(h.db.admin, 'offering.draft_saved') })).body as Offering;
    offering = (await exactlyOnce({ action: 'offering.private_save', client: petr, url: `${O}/versions/${v2.id}/private`, body: { expectedRevision: offering.offering.revision, privateKnowledge: { costBasis: null, marginTarget: null, notes: 'once' } }, effects: () => auditCount(h.db.admin, 'offering.private_knowledge_saved') })).body as Offering;
    await exactlyOnce({ action: 'offering.archive', client: petr, url: `${O}/archive`, body: { expectedRevision: offering.offering.revision, reason: 'Exactly-once archive' }, effects: () => auditCount(h.db.admin, 'offering.archived') });

    const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
    const fields = { title: 'Exactly-once need', description: null, region: 'US-CA', window: { from: bdate('2027-04-01'), to: bdate('2027-04-30') }, acceptanceCriteria: 'Owner check', lines: [{ kind: 'goods', description: 'Pavers', quantity: { value: '30', unit: 'm2' }, specification: {}, alternativesAllowed: false, evidence: null }] };
    let need = (await exactlyOnce({ action: 'need.create', client: petr, url: '/v1/needs', body: { owner: me, projectId: null, source: 'manual', fields, actor: person }, effects: () => auditCount(h.db.admin, 'need.created') })).body as { id: string; revision: number };
    need = (await exactlyOnce({ action: 'need.save', client: petr, url: `/v1/needs/${need.id}`, body: { expectedRevision: need.revision, fields: { ...fields, title: 'Saved once' }, actor: person }, effects: () => auditCount(h.db.admin, 'need.saved') })).body as { id: string; revision: number };
    await exactlyOnce({
      action: 'need.convert', client: petr, url: `/v1/needs/${need.id}/convert`, effects: () => auditCount(h.db.admin, 'need.converted'),
      body: { expectedRevision: need.revision, rfq: { currency: 'USD', responseDeadline: '2027-03-01T00:00:00.000Z', paymentTermsRequested: null, attachments: [], category: null }, privateConstraint: null, actor: person },
    });

    type Rfq = { rfq: { id: string; revision: number; currentVersionId: string | null }; versions: { id: string; version: number; status: string }[]; privateConstraint: { revision: number }; invitations: { id: string; revision: number; party: { id: string } }[] };
    const payload = (quantity: string) => ({
      title: 'Exactly-once RFQ', lines: [{ lineId: 'l1', kind: 'goods', description: 'Pavers', specification: {}, quantity: { value: quantity, unit: 'm2' }, alternativesAllowed: false }],
      deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } }, acceptanceCriteria: 'Owner check', paymentTermsRequested: null, currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [],
    });
    let rfq = (await exactlyOnce({
      action: 'rfq.create', client: petr, url: '/v1/rfqs', effects: () => auditCount(h.db.admin, 'rfq.created'),
      body: { owner: me, projectId: null, payload: payload('10'), category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: person },
    })).body as Rfq;
    const R = `/v1/rfqs/${rfq.rfq.id}`;
    rfq = (await exactlyOnce({ action: 'rfq.draft_save', client: petr, url: `${R}/versions/${rfq.versions[0]!.id}`, body: { expectedRevision: rfq.rfq.revision, payload: payload('12'), actor: person }, effects: () => auditCount(h.db.admin, 'rfq.draft_saved') })).body as Rfq;
    rfq = (await exactlyOnce({
      action: 'rfq.private_save', client: petr, url: `${R}/private`, effects: () => auditCount(h.db.admin, 'rfq.private_constraint_saved'),
      body: { expectedRevision: rfq.privateConstraint.revision, budgetCeiling: { minorUnits: '500000', currency: 'USD' }, evaluationWeights: {}, internalNotes: 'once', shortlist: [] },
    })).body as Rfq;
    rfq = (await exactlyOnce({ action: 'rfq.version_publish', client: petr, url: `${R}/publish`, body: { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: person }, effects: () => auditCount(h.db.admin, 'rfq.version_published') })).body as Rfq;
    const invitation = (await exactlyOnce({
      action: 'rfq.invite', client: petr, url: `${R}/invitations`, effects: () => auditCount(h.db.admin, 'rfq.invitation_sent'),
      body: { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party: { kind: 'person', id: seed.people.carl }, channel: 'platform', actor: person },
    })).body as { id: string; revision: number };
    await exactlyOnce({ action: 'rfq.invitation_respond', client: carl, url: `/v1/rfq-invitations/${invitation.id}/respond`, body: { status: 'viewed' }, effects: () => auditCount(h.db.admin, 'rfq.invitation_viewed') });
    rfq = (await petr.get(R)).body as Rfq;
    rfq = (await exactlyOnce({ action: 'rfq.amendment_open', client: petr, url: `${R}/versions`, body: { expectedRevision: rfq.rfq.revision, amendmentReason: 'Exactly-once amendment', actor: person }, effects: () => auditCount(h.db.admin, 'rfq.amendment_opened') })).body as Rfq;
    rfq = (await created(await petr.post(`${R}/publish`, { rfqId: rfq.rfq.id, version: 2, expectedRevision: rfq.rfq.revision, amendmentReason: 'Exactly-once amendment', actor: person }))) as unknown as Rfq;
    const renewed = (await exactlyOnce({ action: 'rfq.invitation_revalidate', client: petr, url: `${R}/invitations/${invitation.id}/revalidate`, body: { actor: person }, effects: () => auditCount(h.db.admin, 'rfq.invitation_revalidated') })).body as { id: string; revision: number };
    await exactlyOnce({ action: 'rfq.invitation_withdraw', client: petr, url: `${R}/invitations/${renewed.id}/withdraw`, body: { reason: 'Exactly-once withdrawal' }, effects: () => auditCount(h.db.admin, 'rfq.invitation_withdrawn') });
    rfq = (await petr.get(R)).body as Rfq;
    rfq = (await exactlyOnce({ action: 'rfq.projection_set', client: petr, url: `${R}/projection`, body: { expectedRevision: rfq.rfq.revision, publicProjection: { enabled: true, fields: ['title'] }, category: null }, effects: () => auditCount(h.db.admin, 'rfq.projection_set') })).body as Rfq;
    await exactlyOnce({ action: 'rfq.close', client: petr, url: `${R}/close`, body: { expectedRevision: rfq.rfq.revision, outcome: 'closed', reason: 'Exactly-once close' }, effects: () => auditCount(h.db.admin, 'rfq.closed') });
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.rfq_invitation WHERE rfq_id = $1 AND stale_reason IS NOT NULL", [rfq.rfq.id]), 2, 'both invitations are flagged once');
  });

  await t.test('files (FILE-001): upload start and completion, copy, move and deletion requests', async () => {
    const owner = { kind: 'person', id: seed.people.petr };
    const project = (await newProject('Exactly-once files')).id;
    const other = (await newProject('Exactly-once files target')).id;
    const started = (await exactlyOnce({
      action: 'file.upload_start', client: petr, url: '/v1/files/uploads', effects: () => auditCount(h.db.admin, 'file.upload_started'),
      body: { owner, parent: { kind: 'project', id: project }, mediaType: 'text/plain', bytes: 12, sha256: 'c'.repeat(64), uploadKey: 'crash-upload-key-0001' },
    })).body as { file: { id: string } };
    const id = started.file.id;
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.evidence_artifact WHERE uploaded_by = $1 AND sha256 = $2", [seed.people.petr, 'c'.repeat(64)]), 1, 'one artifact');
    await exactlyOnce({ action: 'file.upload_complete', client: petr, url: `/v1/files/${id}/complete`, body: {}, effects: () => auditCount(h.db.admin, 'file.upload_completed') });
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('evidence_artifact').set({ scan_state: 'clean' }).where('id', '=', id).execute());
    await exactlyOnce({ action: 'file.copy', client: petr, url: `/v1/files/${id}/copy`, body: { parent: { kind: 'project', id: other } }, effects: () => auditCount(h.db.admin, 'file.copied') });
    const moved = (await exactlyOnce({ action: 'file.move', client: petr, url: `/v1/files/${id}/move`, body: { parent: { kind: 'project', id: other } }, effects: () => auditCount(h.db.admin, 'file.moved') })).body as { id: string };
    await exactlyOnce({ action: 'file.delete', client: petr, url: `/v1/files/${moved.id}/delete`, body: {}, effects: () => auditCount(h.db.admin, 'file.deletion_requested') });
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.outbox_event WHERE type = 'file.deletion_requested' AND aggregate_id = $1", [moved.id]), 1, 'one deletion intent');
  });

  await t.test('commerce (COM-002): quotes, negotiation, agreements, orders and changes', async () => {
    const reference = await kernelReference.fromRepository();
    await withMaintenance(h.db.admin, (trx) => kernelSync.apply(trx, reference));
    // SANC-004: quotes, acceptance and orders need every party screened clear against fresh baseline lists.
    await screenEveryoneClear(h.db.admin);
    const person = { via: 'person' };
    const consent = { consented: true, disclosureKey: 'trustwork.electronic-records.v1' };
    const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
    const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
    const rfqPayload = { title: 'Exactly-once deal', lines: [{ lineId: 'l1', kind: 'goods', description: 'Pavers', specification: {}, quantity: { value: '10', unit: 'm2' }, alternativesAllowed: false }], deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } }, acceptanceCriteria: 'Owner check', paymentTermsRequested: null, currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [] };
    const quotePayload = (price: string) => {
      const total = (10n * BigInt(price)).toString();
      return {
        currency: 'USD', paymentTerms: 'Net 30', validity: { until: '2027-06-01T00:00:00.000Z' }, exclusions: [], attachments: [], deliveryTerms: { milestones: [], location: 'Site' },
        totals: { net: usd(total), tax: usd('0'), gross: usd(total) },
        lines: [{ lineId: 'q1', rfqLineId: 'l1', kind: 'goods', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '10', unit: 'm2' }, unitPrice: usd(price), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd(total), substitution: null, options: [] }],
      };
    };
    type Ref = { id: string; version: number; digest: { algorithm: string; value: string } };
    type Quote = { quote: { id: string; revision: number }; versions: (Ref & { status: string })[]; privateConstraint: { revision: number }; amendmentRequests: { id: string; status: string }[] };
    type Deal = { agreement: { id: string; revision: number; acceptedTerms: { quoteVersion: Ref; rfqVersion: Ref; digest: Ref['digest'] } }; privateRevision: number; orders: { id: string; revision: number }[]; orderChanges: { id: string; revision: number }[] };
    const ref = (v: Ref) => ({ id: v.id, version: v.version, digest: v.digest });
    const grant = async (limit: string) => withPrincipal(h.pool, await principalFor(h.db.admin, seed.people.petr), (trx) => budgets.grant(trx, {
      kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, periodFrom: '2026-01-01T00:00:00Z', periodTo: '2030-01-01T00:00:00Z', limitMinor: limit, currency: 'USD',
    }));
    const publish = async () => {
      let rfq = (await created(await petr.post('/v1/rfqs', { owner: { kind: 'person', id: seed.people.petr }, projectId: null, payload: rfqPayload, category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: person }))) as unknown as { rfq: { id: string; revision: number; currentVersionId: string } };
      rfq = (await created(await petr.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: person }))) as unknown as typeof rfq;
      await created(await petr.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party: { kind: 'person', id: seed.people.carl }, channel: 'platform', actor: person }));
      const versions = ((await petr.get(`/v1/rfqs/${rfq.rfq.id}`)).body as { versions: Ref[] }).versions;
      return { id: rfq.rfq.id, current: ref(versions[0]!) };
    };
    const carlQuote = async (id: string) => (await carl.get(`/v1/quotes/${id}`)).body as Quote;
    const buyerDeal = async (id: string) => (await petr.get(`/v1/agreements/${id}`)).body as Deal;

    const rfq = await publish();
    let quote = (await exactlyOnce({ action: 'quote.create', client: carl, url: '/v1/quotes', body: { rfqId: rfq.id, rfqVersionId: rfq.current.id, seller: { kind: 'person', id: seed.people.carl }, payload: quotePayload('3000'), privateConstraint: null, actor: person }, effects: () => auditCount(h.db.admin, 'quote.drafted') })).body as Quote;
    const Q = `/v1/quotes/${quote.quote.id}`;
    quote = (await exactlyOnce({ action: 'quote.draft_save', client: carl, url: `${Q}/versions/${quote.versions[0]!.id}`, body: { expectedRevision: quote.quote.revision, payload: quotePayload('3100'), actor: person }, effects: () => auditCount(h.db.admin, 'quote.draft_saved') })).body as Quote;
    quote = (await exactlyOnce({ action: 'quote.private_save', client: carl, url: `${Q}/private`, body: { expectedRevision: quote.privateConstraint.revision, floorPrices: {}, marginTargets: {}, costBasis: {}, negotiationNotes: 'once' }, effects: () => auditCount(h.db.admin, 'quote.private_constraint_saved') })).body as Quote;
    quote = (await exactlyOnce({ action: 'quote.send', client: carl, url: `${Q}/send`, body: { quoteId: quote.quote.id, version: 1, expectedRevision: quote.quote.revision, actor: person }, effects: () => auditCount(h.db.admin, 'quote.sent') })).body as Quote;
    const v1 = quote.versions[0]!;
    await exactlyOnce({ action: 'quote.amendment_request', client: petr, url: `${Q}/amendment-requests`, body: { quoteVersionId: v1.id, changes: [{ lineId: 'q1', quantity: null, targetUnitPrice: usd('2900'), reason: null }], targetTotal: null, actor: person }, effects: () => auditCount(h.db.admin, 'quote.amendment_requested') });
    quote = await carlQuote(quote.quote.id);
    const request = quote.amendmentRequests.find((r) => r.status === 'open')!;
    quote = (await exactlyOnce({ action: 'quote.version_open', client: carl, url: `${Q}/versions`, body: { expectedRevision: quote.quote.revision, rfqVersionId: rfq.current.id, payload: quotePayload('2900'), answersAmendmentRequestId: request.id, actor: person }, effects: () => auditCount(h.db.admin, 'quote.version_opened') })).body as Quote;
    quote = (await created(await carl.post(`${Q}/send`, { quoteId: quote.quote.id, version: 2, expectedRevision: quote.quote.revision, actor: person }))) as unknown as Quote;
    const v2 = quote.versions.find((v) => v.status === 'sent')!;
    await created(await petr.post(`${Q}/amendment-requests`, { quoteVersionId: v2.id, changes: [{ lineId: 'q1', quantity: null, targetUnitPrice: usd('2800'), reason: null }], targetTotal: null, actor: person }));
    const second = (await carlQuote(quote.quote.id)).amendmentRequests.find((r) => r.status === 'open')!;
    await exactlyOnce({ action: 'quote.amendment_request_withdraw', client: petr, url: `${Q}/amendment-requests/${second.id}/withdraw`, body: { reason: 'Exactly-once withdrawal' }, effects: () => auditCount(h.db.admin, 'quote.amendment_request_withdrawn') });
    quote = await carlQuote(quote.quote.id);
    let deal = (await exactlyOnce({
      action: 'agreement.accept_terms', client: petr, url: '/v1/agreements', effects: () => auditCount(h.db.admin, 'agreement.accepted_by_buyer'),
      body: { rfqId: rfq.id, quoteVersion: ref(v2), rfqVersion: rfq.current, expectedRevision: quote.quote.revision, electronicRecords: consent, actor: person },
    })).body as Deal;
    const A = `/v1/agreements/${deal.agreement.id}`;
    deal = (await exactlyOnce({ action: 'agreement.private_save', client: petr, url: `${A}/private`, body: { side: 'buyer', expectedRevision: deal.privateRevision, approvalRefs: [], notes: 'once' }, effects: () => auditCount(h.db.admin, 'agreement.buyer_private_saved') })).body as Deal;
    const budgetId = await grant('100000000');
    deal = (await exactlyOnce({
      action: 'order.place', client: petr, url: `${A}/orders`, effects: () => auditCount(h.db.admin, 'order.placed'),
      body: { action: 'place_order', context: { kind: 'rfq', id: rfq.id }, agreementId: deal.agreement.id, quoteVersion: deal.agreement.acceptedTerms.quoteVersion, rfqVersion: deal.agreement.acceptedTerms.rfqVersion, expectedRevision: deal.agreement.revision, transactionBudgetId: budgetId, platformBudgetId: null, externalReference: null, actor: person },
    })).body as Deal;
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.reservation WHERE action_intent_id = $1', [deal.agreement.id]), 1, 'one reservation for the order');
    await exactlyOnce({ action: 'agreement.seller_accept', client: carl, url: `${A}/accept`, body: { expectedRevision: deal.agreement.revision, acceptedTermsDigest: deal.agreement.acceptedTerms.digest, electronicRecords: consent, actor: person }, effects: () => auditCount(h.db.admin, 'agreement.accepted_by_both') });
    quote = await carlQuote(quote.quote.id);
    quote = (await created(await carl.post(`${Q}/versions`, { expectedRevision: quote.quote.revision, rfqVersionId: rfq.current.id, payload: quotePayload('3200'), answersAmendmentRequestId: null, actor: person }))) as unknown as Quote;
    quote = (await created(await carl.post(`${Q}/send`, { quoteId: quote.quote.id, version: 3, expectedRevision: quote.quote.revision, actor: person }))) as unknown as Quote;
    deal = await buyerDeal(deal.agreement.id);
    const orderId = deal.orders[0]!.id;
    deal = (await exactlyOnce({ action: 'order.change_propose', client: carl, url: `/v1/orders/${orderId}/changes`, body: { expectedRevision: deal.orders[0]!.revision, quoteVersion: ref(quote.versions.at(-1)!), transactionBudgetId: null, actor: person }, effects: () => auditCount(h.db.admin, 'order.change_proposed') })).body as Deal;
    deal = await buyerDeal(deal.agreement.id);
    const change = deal.orderChanges[0]!;
    await exactlyOnce({ action: 'order.change_decide', client: petr, url: `/v1/orders/${orderId}/changes/${change.id}`, body: { expectedRevision: change.revision, decision: 'accept', transactionBudgetId: budgetId, reason: null, actor: person }, effects: () => auditCount(h.db.admin, 'order.change_accepted') });
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.agreement WHERE rfq_id = $1 AND status = 'accepted_by_both'", [rfq.id]), 1, 'one superseding agreement');

    // Withdrawal, decline, cancellation and agreement withdrawal on a second RFQ.
    const other = await publish();
    let q2 = (await created(await carl.post('/v1/quotes', { rfqId: other.id, rfqVersionId: other.current.id, seller: { kind: 'person', id: seed.people.carl }, payload: quotePayload('3000'), privateConstraint: null, actor: person }))) as unknown as Quote;
    const Q2 = `/v1/quotes/${q2.quote.id}`;
    q2 = (await created(await carl.post(`${Q2}/send`, { quoteId: q2.quote.id, version: 1, expectedRevision: q2.quote.revision, actor: person }))) as unknown as Quote;
    q2 = (await exactlyOnce({ action: 'quote.withdraw', client: carl, url: `${Q2}/withdraw`, body: { expectedRevision: q2.quote.revision, reason: 'Exactly-once withdrawal', actor: person }, effects: () => auditCount(h.db.admin, 'quote.withdrawn') })).body as Quote;
    q2 = (await created(await carl.post(`${Q2}/versions`, { expectedRevision: q2.quote.revision, rfqVersionId: other.current.id, payload: quotePayload('3000'), answersAmendmentRequestId: null, actor: person }))) as unknown as Quote;
    q2 = (await created(await carl.post(`${Q2}/send`, { quoteId: q2.quote.id, version: 2, expectedRevision: q2.quote.revision, actor: person }))) as unknown as Quote;
    const accept = async () => {
      const current = await carlQuote(q2.quote.id);
      return (await created(await petr.post('/v1/agreements', { rfqId: other.id, quoteVersion: ref(current.versions.find((v) => v.status === 'sent')!), rfqVersion: other.current, expectedRevision: current.quote.revision, electronicRecords: consent, actor: person }))) as unknown as Deal;
    };
    let d2 = await accept();
    d2 = (await created(await petr.post(`/v1/agreements/${d2.agreement.id}/orders`, { action: 'place_order', context: { kind: 'rfq', id: other.id }, agreementId: d2.agreement.id, quoteVersion: d2.agreement.acceptedTerms.quoteVersion, rfqVersion: d2.agreement.acceptedTerms.rfqVersion, expectedRevision: d2.agreement.revision, transactionBudgetId: budgetId, platformBudgetId: null, externalReference: null, actor: person }))) as unknown as Deal;
    await exactlyOnce({ action: 'agreement.seller_decline', client: carl, url: `/v1/agreements/${d2.agreement.id}/decline`, body: { expectedRevision: d2.agreement.revision, reason: 'Exactly-once decline', actor: person }, effects: () => auditCount(h.db.admin, 'agreement.declined') });
    d2 = await buyerDeal(d2.agreement.id);
    await exactlyOnce({ action: 'order.cancel', client: petr, url: `/v1/orders/${d2.orders[0]!.id}/cancel`, body: { expectedRevision: d2.orders[0]!.revision, reason: 'Exactly-once release', actor: person }, effects: () => auditCount(h.db.admin, 'order.reservation_released') });
    const d3 = await accept();
    await exactlyOnce({ action: 'agreement.withdraw', client: petr, url: `/v1/agreements/${d3.agreement.id}/withdraw`, body: { expectedRevision: d3.agreement.revision, reason: 'Exactly-once withdrawal', actor: person }, effects: () => auditCount(h.db.admin, 'agreement.withdrawn') });
  });

  await t.test('profiles (PPL-001): profile, visibility, consent, licences, portraits, experience and private records', async () => {
    const me = seed.people.petr;
    const rows = (table: string, where = '') => () => count(h.db.admin, `SELECT 1 FROM trustwork.${table} WHERE ${table === 'follow' ? 'follower_person_id' : 'person_id'} = $1 ${where}`, [me]);
    const profile = { headline: 'Exactly-once estimator', expertise: [], roleLine: 'Estimator', regionCode: 'US-CA', showEmployer: false, topics: [], languages: [], publicFields: ['roleLine'] };
    await exactlyOnce({ action: 'profile.save', client: petr, url: '/v1/me/profile', body: { expectedRevision: null, ...profile }, effects: () => auditCount(h.db.admin, 'profile.saved') });
    await exactlyOnce({ action: 'profile.visibility', client: petr, url: '/v1/me/profile/visibility', body: { visibility: 'public', noticeVersion: 'profile_public.v1' }, effects: () => auditCount(h.db.admin, 'profile.published') });
    const consent = (await exactlyOnce({ action: 'consent.grant', client: petr, url: '/v1/me/consents', body: { purpose: 'marketing', target: null, noticeVersion: 'marketing.v1' }, effects: () => auditCount(h.db.admin, 'consent.granted') })).body as { id: string };
    await exactlyOnce({ action: 'consent.withdraw', client: petr, url: `/v1/me/consents/${consent.id}/withdraw`, body: { reason: 'Exactly-once withdrawal' }, effects: () => auditCount(h.db.admin, 'consent.withdrawn') });
    const asset = (await withMaintenance(h.db.admin, (trx) => trx.insertInto('evidence_artifact').values({
      owner_person_id: me, owner_company_id: null, parent_kind: 'person', parent_id: me, classification: 'public', storage_key: 'person/petr/crash-portrait.png', sha256: 'e'.repeat(64), bytes: 512,
      media_type: 'image/png', uploaded_by: me, scan_state: 'clean',
    }).returning('id').executeTakeFirstOrThrow())).id;
    const licence = (await exactlyOnce({ action: 'media_licence.record', client: petr, url: '/v1/me/media-licences', body: { assetId: asset, licensor: 'Fixture Petr', licenceKind: 'own_work', scope: 'profile portrait', validUntil: null }, effects: () => auditCount(h.db.admin, 'media_licence.recorded') })).body as { id: string };
    const portraitConsent = (await created(await petr.post('/v1/me/consents', { purpose: 'portrait_display', target: null, noticeVersion: 'portrait_display.v1' }))) as unknown as { id: string };
    const portrait = (await exactlyOnce({ action: 'portrait.set', client: petr, url: '/v1/me/portrait', body: { assetId: asset, mediaLicenceId: licence.id, consentRecordId: portraitConsent.id }, effects: () => auditCount(h.db.admin, 'portrait.set') })).body as { id: string; revision: number };
    await exactlyOnce({ action: 'portrait.remove', client: petr, url: `/v1/me/portraits/${portrait.id}/remove`, body: { expectedRevision: portrait.revision }, effects: () => auditCount(h.db.admin, 'portrait.removed') });
    await exactlyOnce({ action: 'media_licence.revoke', client: petr, url: `/v1/me/media-licences/${licence.id}/revoke`, body: { reason: 'Exactly-once revocation' }, effects: () => auditCount(h.db.admin, 'media_licence.revoked') });
    const entryBody = { organisation: { companyId: null, name: 'Exactly-once Roofing' }, role: 'Estimator', summary: null, from: '2024-01-01', to: null, visibility: 'public' };
    const entry = (await exactlyOnce({ action: 'experience.add', client: petr, url: '/v1/me/experience', body: entryBody, effects: () => auditCount(h.db.admin, 'experience.added') })).body as { id: string; revision: number };
    const updated = (await exactlyOnce({ action: 'experience.update', client: petr, url: `/v1/me/experience/${entry.id}`, body: { ...entryBody, role: 'Senior estimator', expectedRevision: entry.revision }, effects: () => auditCount(h.db.admin, 'experience.updated') })).body as { revision: number };
    await exactlyOnce({ action: 'experience.archive', client: petr, url: `/v1/me/experience/${entry.id}/archive`, body: { expectedRevision: updated.revision }, effects: () => auditCount(h.db.admin, 'experience.archived') });
    // Private attention records are not audited: their effect is the row itself.
    await exactlyOnce({ action: 'preferences.save', client: petr, url: '/v1/me/preferences', body: { intents: ['read'], topics: [], regions: [], onboardingCompleted: false, expectedRevision: null }, effects: rows('person_preference') });
    const follow = (await exactlyOnce({ action: 'follow.add', client: petr, url: '/v1/me/follows', body: { target: { kind: 'topic', code: 'materials' } }, effects: rows('follow') })).body as { id: string };
    await exactlyOnce({ action: 'follow.end', client: petr, url: `/v1/me/follows/${follow.id}/end`, body: {}, effects: rows('follow', 'AND ended_at IS NOT NULL') });
    const publication = '0198b1d0-0000-7000-8000-0000000000dd';
    const bookmark = (await exactlyOnce({ action: 'bookmark.add', client: petr, url: '/v1/me/bookmarks', body: { target: { kind: 'publication', id: publication } }, effects: rows('bookmark') })).body as { id: string };
    await exactlyOnce({ action: 'bookmark.remove', client: petr, url: `/v1/me/bookmarks/${bookmark.id}/remove`, body: {}, effects: rows('bookmark', 'AND removed_at IS NOT NULL') });
    await exactlyOnce({ action: 'reading_progress.record', client: petr, url: '/v1/me/reading-progress', body: { publicationVersionId: publication, progress: '0.5' }, effects: rows('reading_progress') });
  });

  await t.test('tasks (TASK-001): requests, offers, agreements, assignment, records and reviews', async () => {
    await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
    const person = { via: 'person' };
    const consent = { consented: true, disclosureKey: 'trustwork.electronic-records.v1' };
    const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
    const planItem = (key: string, title: string) => ({ key, parentKey: null, kind: 'task', title, description: null, stepTerms: ['work.envelope.roofing'], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null, decisionQuestion: null, sources: [], attachments: [], privateNotes: null });
    type Ref = { id: string; version: number; digest: { algorithm: string; value: string }; revision: number; status: string };
    type Request = { request: { id: string; revision: number; currentVersionId: string | null }; versions: Ref[]; privateConstraint: { revision: number }; agreements: { id: string; revision: number; status: string; acceptedTermsDigest: unknown }[] };
    type Offer = { versions: Ref[]; agreements: { id: string; revision: number; status: string; acceptedTermsDigest: unknown }[] };
    type Assignment = { assignment: { id: string; revision: number }; milestoneStates: { claimId: string | null }[] };
    const project = await newProject('Exactly once tasks');
    const P = `/v1/projects/${project.id}/plan`;
    const plan = (await created(await petr.post(P, { timeZone: 'America/Los_Angeles', actor: person, content: { summary: null, assumptions: [], budget: null, timeline: null, dependencies: [], items: [planItem('roof', 'Roof'), planItem('fence', 'Fence')] } }))) as unknown as { draft: { id: string; revision: number } };
    const proposed = (await created(await petr.post(`${P}/versions/${plan.draft.id}/propose`, { expectedRevision: plan.draft.revision, actor: person }))) as unknown as { revision: number; digest: unknown };
    await created(await petr.post(`${P}/versions/${plan.draft.id}/approve`, { expectedRevision: proposed.revision, digest: proposed.digest }));
    const terms = (key: string) => ({ title: `Exactly once ${key}`, fields: ['scope'], scopeNote: null, milestoneItemKeys: [key], acceptanceCriteria: [], responseDeadline: '2027-02-15T17:00:00.000Z', currency: 'USD' });
    const offerPayload = (key: string, price: string) => ({ price: usd(price), start: '2027-03-01', durationDays: 2, exclusions: [], validUntil: '2027-06-01T00:00:00.000Z', note: null, milestones: [{ key: 'all', title: 'Done', planItemKey: key, amount: usd(price), due: '2027-03-03' }] });
    let request = (await exactlyOnce({ action: 'task.request_create', client: petr, url: '/v1/task-requests', body: { source: { projectId: project.id, itemKey: 'roof' }, audience: 'invited', terms: terms('roof'), privateConstraint: null, actor: person }, effects: () => auditCount(h.db.admin, 'task.request_created') })).body as Request;
    const R = `/v1/task-requests/${request.request.id}`;
    request = (await exactlyOnce({ action: 'task.draft_save', client: petr, url: `${R}/draft`, body: { expectedRevision: request.request.revision, terms: { ...terms('roof'), scopeNote: 'saved once' }, actor: person }, effects: () => auditCount(h.db.admin, 'task.draft_saved') })).body as Request;
    request = (await exactlyOnce({ action: 'task.private_save', client: petr, url: `${R}/private`, body: { expectedRevision: request.privateConstraint.revision, budgetCeiling: usd('900000'), ownerNotes: null }, effects: () => auditCount(h.db.admin, 'task.private_saved') })).body as Request;
    request = (await exactlyOnce({ action: 'task.version_publish', client: petr, url: `${R}/publish`, body: { version: 1, expectedRevision: request.request.revision, amendmentReason: null, actor: person }, effects: () => auditCount(h.db.admin, 'task.version_published') })).body as Request;
    await exactlyOnce({ action: 'task.invite', client: petr, url: `${R}/invitations`, body: { party: { kind: 'person', id: seed.people.carl }, actor: person }, effects: () => auditCount(h.db.admin, 'task.invitation_sent') });
    await created(await petr.post(`${R}/invitations`, { party: { kind: 'person', id: seed.people.xenia }, actor: person }));
    const offerBody = (offerorId: string, price: string) => ({ taskRequestId: request.request.id, requestVersionId: request.request.currentVersionId, offeror: { kind: 'person', id: offerorId }, payload: offerPayload('roof', price), privateConstraint: null, actor: person });
    let carlOffer = (await exactlyOnce({ action: 'task.offer_create', client: carl, url: '/v1/task-offers', body: offerBody(seed.people.carl, '500000'), effects: () => auditCount(h.db.admin, 'task.offer_drafted') })).body as Offer;
    let v = carlOffer.versions.at(-1)!;
    carlOffer = (await exactlyOnce({ action: 'task.offer_save', client: carl, url: `/v1/task-offers/${v.id}`, body: { expectedRevision: v.revision, payload: offerPayload('roof', '510000'), privateConstraint: null, actor: person }, effects: () => auditCount(h.db.admin, 'task.offer_draft_saved') })).body as Offer;
    v = carlOffer.versions.at(-1)!;
    carlOffer = (await exactlyOnce({ action: 'task.offer_send', client: carl, url: `/v1/task-offers/${v.id}/send`, body: { expectedRevision: v.revision, actor: person }, effects: () => auditCount(h.db.admin, 'task.offer_sent') })).body as Offer;
    const current = () => request.versions.find((x) => x.id === request.request.currentVersionId)!;
    const acceptBody = (offer: Ref) => ({ offer: { id: offer.id, version: offer.version, digest: offer.digest }, requestVersion: { id: current().id, version: current().version, digest: current().digest }, expectedRevision: request.request.revision, electronicRecords: consent, actor: person });
    request = (await exactlyOnce({ action: 'task.offer_accept', client: petr, url: `${R}/acceptances`, body: acceptBody(carlOffer.versions.at(-1)!), effects: () => auditCount(h.db.admin, 'task.offer_accepted') })).body as Request;
    const first = request.agreements[0]!;
    request = (await exactlyOnce({ action: 'task.agreement_withdraw', client: petr, url: `/v1/task-agreements/${first.id}/withdraw`, body: { expectedRevision: first.revision, reason: 'Exactly-once withdrawal', actor: person }, effects: () => auditCount(h.db.admin, 'task.acceptance_withdrawn') })).body as Request;
    request = (await created(await petr.post(`${R}/acceptances`, acceptBody(carlOffer.versions.at(-1)!)))) as unknown as Request;
    const second = request.agreements.find((a) => a.status === 'accepted_by_buyer')!;
    await exactlyOnce({ action: 'task.agreement_decline', client: carl, url: `/v1/task-agreements/${second.id}/decline`, body: { expectedRevision: second.revision, reason: 'Exactly-once decline', actor: person }, effects: () => auditCount(h.db.admin, 'task.agreement_declined') });
    let xeniaOffer = (await created(await xenia.post('/v1/task-offers', offerBody(seed.people.xenia, '520000')))) as unknown as Offer;
    v = xeniaOffer.versions.at(-1)!;
    xeniaOffer = (await created(await xenia.post(`/v1/task-offers/${v.id}/send`, { expectedRevision: v.revision, actor: person }))) as unknown as Offer;
    v = xeniaOffer.versions.at(-1)!;
    await exactlyOnce({ action: 'task.offer_withdraw', client: xenia, url: `/v1/task-offers/${v.id}/withdraw`, body: { expectedRevision: v.revision, reason: 'Exactly-once withdrawal', actor: person }, effects: () => auditCount(h.db.admin, 'task.offer_withdrawn') });
    xeniaOffer = (await created(await xenia.post('/v1/task-offers', offerBody(seed.people.xenia, '530000')))) as unknown as Offer;
    v = xeniaOffer.versions.at(-1)!;
    xeniaOffer = (await created(await xenia.post(`/v1/task-offers/${v.id}/send`, { expectedRevision: v.revision, actor: person }))) as unknown as Offer;
    request = (await petr.get(R)).body as Request;
    request = (await created(await petr.post(`${R}/acceptances`, acceptBody(xeniaOffer.versions.at(-1)!)))) as unknown as Request;
    const third = request.agreements.find((a) => a.status === 'accepted_by_buyer')!;
    let assignment = (await exactlyOnce({ action: 'task.agreement_confirm', client: xenia, url: `/v1/task-agreements/${third.id}/confirm`, body: { expectedRevision: third.revision, acceptedTermsDigest: third.acceptedTermsDigest, electronicRecords: consent, actor: person }, effects: () => auditCount(h.db.admin, 'task.assigned') })).body as Assignment;
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.task_assignment WHERE task_request_id = $1', [request.request.id]), 1, 'one assignment');
    const A = `/v1/task-assignments/${assignment.assignment.id}`;
    const evidence = [{ evidenceArtifactId: 'artifact-demo-once', hash: 'e'.repeat(64), audience: 'shared' }];
    assignment = (await exactlyOnce({ action: 'task.record', client: xenia, url: `${A}/records`, body: { kind: 'delivery_claim', expectedRevision: assignment.assignment.revision, milestoneKey: 'all', evidence, note: null, actor: person }, effects: () => auditCount(h.db.admin, 'task.delivery_claim') })).body as Assignment;
    await created(await petr.post(`${A}/records`, { kind: 'acceptance', expectedRevision: assignment.assignment.revision, milestoneKey: 'all', claimId: assignment.milestoneStates[0]!.claimId, note: null }));
    await exactlyOnce({ action: 'task.review', client: petr, url: `${A}/reviews`, body: { rating: 5, text: 'Exactly once' }, effects: () => auditCount(h.db.admin, 'task.reviewed') });
    const fence = (await created(await petr.post('/v1/task-requests', { source: { projectId: project.id, itemKey: 'fence' }, audience: 'open', terms: terms('fence'), privateConstraint: null, actor: person }))) as unknown as Request;
    await exactlyOnce({ action: 'task.request_cancel', client: petr, url: `/v1/task-requests/${fence.request.id}/cancel`, body: { expectedRevision: fence.request.revision, reason: 'Exactly-once cancellation', actor: person }, effects: () => auditCount(h.db.admin, 'task.request_cancelled') });
  });

  await t.test('execution and trust (EXE-001): claims, evidence, decisions, defects, disputes, reviews, appeals and snapshots', async () => {
    const hubId = '00000000-0000-4000-8000-0000000e0c01';
    process.env.TRUSTWORK_HUB_ID = hubId;
    const f = { admin: h.db.admin, app: h.db.app, people: { petr: seed.people.petr, boris: seed.people.boris, carl: seed.people.carl, xenia: seed.people.xenia, anna: seed.people.anna }, supplier: seed.companies.supplier, project: seed.project };
    // The ADM-001 block below builds the administration world of this database, so the dispute is decided here by the
    // owner role (the reviewer commands themselves are covered in tests/trust).
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('hub').values({ id: hubId, slug: 'synthetic-exe-crash', lifecycle: 'public' }).execute());
    const boris = await as('boris');
    const person = { via: 'person' };
    const petrParty = { kind: 'person', id: seed.people.petr };
    const supplierParty = { kind: 'company', id: seed.companies.supplier };
    type View = { claims: { id: string }[]; defects: { id: string }[]; disputes: { id: string; revision: number }[] };
    const A = await buildAgreement(f, businessDate(-2), 'Synthetic exactly once');
    const E = `/v1/execution/agreements/${A.agreement.id}`;
    const claim = (obligationId: string, kind: string, lines: unknown[]) => ({ obligationId, defectId: null, kind, claimant: supplierParty, lines, period: null, performedAt: new Date().toISOString(), statement: null, supersedesClaimId: null, actor: person });
    const accept = { onBehalfOf: petrParty, decision: 'accepted', lines: [], note: null, stageCode: null };
    let view = (await exactlyOnce({ action: 'execution.claim_record', client: boris, url: `${E}/claims`, body: claim(A.byKind.deliver.id, 'goods_delivery', [{ ref: 'q1', quantity: { value: '40', unit: 'm2' } }]), effects: () => auditCount(h.db.admin, 'execution.claim_recorded') })).body as View;
    const claimId = view.claims[0]!.id;
    const photo = await artifactOn(f, A.agreement.id, { company: seed.companies.supplier }, seed.people.boris);
    await exactlyOnce({ action: 'execution.evidence_attach', client: boris, url: `${E}/evidence`, body: { target: { kind: 'claim', id: claimId }, artifactId: photo.id, artifactSha256: photo.sha256, kind: 'photo', observedAt: null, note: null, actor: person }, effects: () => auditCount(h.db.admin, 'execution.evidence_attached') });
    await exactlyOnce({ action: 'execution.claim_decide', client: petr, url: `/v1/execution/claims/${claimId}/decision`, body: accept, effects: () => auditCount(h.db.admin, 'execution.claim_decided') });
    view = (await exactlyOnce({ action: 'execution.defect_report', client: petr, url: `${E}/defects`, body: { reporter: petrParty, obligationId: null, claimId: null, severity: 'minor', location: null, description: 'Synthetic chipped edge', observedAt: new Date().toISOString(), actor: person }, effects: () => auditCount(h.db.admin, 'execution.defect_reported') })).body as View;
    view = (await exactlyOnce({ action: 'execution.dispute_open', client: boris, url: `${E}/disputes`, body: { target: { kind: 'defect', id: view.defects[0]!.id }, opener: supplierParty, reason: 'Synthetic dispute' }, effects: () => auditCount(h.db.admin, 'execution.dispute_opened') })).body as View;
    const decided = await withMaintenance(h.db.admin, (trx) => trx.updateTable('execution_dispute').set({ status: 'decided', decision: 'upheld', decided_by: seed.people.anna, decided_at: new Date(), decision_reason: 'Synthetic decision' })
      .where('id', '=', view.disputes[0]!.id).returning(['id', 'revision']).executeTakeFirstOrThrow());
    await exactlyOnce({ action: 'execution.dispute_appeal', client: petr, url: `/v1/execution/disputes/${decided.id}/appeal`, body: { expectedRevision: decided.revision, reason: 'Synthetic appeal' }, effects: () => auditCount(h.db.admin, 'execution.dispute_appealed') });
    view = (await created(await boris.post(`${E}/claims`, claim(A.byKind.perform.id, 'work_performed', [])))) as unknown as View;
    assert.equal((await petr.post(`/v1/execution/claims/${view.claims.at(-1)!.id}/decision`, accept)).status, 201);
    const R = `/v1/trust/agreements/${A.agreement.id}/reviews`;
    const reviews = (await exactlyOnce({ action: 'trust.review_submit', client: petr, url: R, body: { author: petrParty, ratings: { overall: 5 }, text: 'Exactly once', language: 'en', correctsReviewId: null }, effects: () => auditCount(h.db.admin, 'trust.review_published') })).body as { reviews: { id: string }[] };
    const reviewId = reviews.reviews[0]!.id;
    await exactlyOnce({ action: 'trust.review_respond', client: boris, url: `/v1/trust/reviews/${reviewId}/response`, body: { responder: supplierParty, text: 'Thank you' }, effects: () => auditCount(h.db.admin, 'trust.review_answered') });
    await exactlyOnce({ action: 'trust.appeal_file', client: boris, url: '/v1/trust/appeals', body: { subject: { kind: 'review', id: reviewId }, reason: 'Synthetic appeal' }, effects: () => auditCount(h.db.admin, 'trust.appeal_filed') });
    await exactlyOnce({ action: 'trust.snapshot_compute', client: boris, url: '/v1/reputation/snapshots', body: { subject: supplierParty }, effects: () => auditCount(h.db.admin, 'trust.snapshot_computed') });
    delete process.env.TRUSTWORK_HUB_ID;
  });

  let elevatedAnna: Client | undefined;
  // BE-004: the support reset routes are staff routes behind an elevated session. Runs last: it enrols and elevates
  // two staff members, and the subject (`pure`) is used by no other subtest.
  await t.test('support reset of a second factor: request, cancel, approve, execute', async () => {
    h.staff.set(seed.people.anna, ['support-agent']);
    h.staff.set(seed.people.boris, ['support-lead']);
    const agent = await as('anna');
    await elevate(h, agent, (await enrol(h, agent)).secret);
    elevatedAnna = agent;
    const lead = await as('boris');
    await elevate(h, lead, (await enrol(h, lead)).secret);
    const base = '/v1/admin/support/second-factor-resets';
    const body = () => ({ subjectPersonId: seed.people.pure, supportCaseId: randomUUID(), evidenceRefs: [randomUUID()], reason: 'Lost authenticator; identity checked on a recorded call' });
    const first = (await exactlyOnce({ action: 'support.second_factor_reset.request', client: agent, url: base, body: body(), effects: () => auditCount(h.db.admin, 'support.second_factor_reset_requested') })).body as { id: string };
    await exactlyOnce({ action: 'support.second_factor_reset.cancel', client: agent, url: `${base}/${first.id}/cancel`, body: {}, effects: () => auditCount(h.db.admin, 'support.second_factor_reset_cancelled') });
    const second = await agent.post(base, body());
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const id = (second.body as { id: string }).id;
    await exactlyOnce({ action: 'support.second_factor_reset.approve', client: lead, url: `${base}/${id}/approve`, body: {}, effects: () => auditCount(h.db.admin, 'support.second_factor_reset_approved') });
    await h.db.admin.query("UPDATE trustwork.second_factor_reset SET requested_at = requested_at - interval '73 hours', approved_at = approved_at - interval '73 hours', effective_at = effective_at - interval '73 hours' WHERE id = $1", [id]);
    await exactlyOnce({ action: 'support.second_factor_reset.execute', client: lead, url: `${base}/${id}/execute`, body: {}, effects: () => auditCount(h.db.admin, 'support.second_factor_reset_completed') });
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.outbox_event WHERE type = 'identity.second_factor_reset_completed' AND aggregate_id = $1", [seed.people.pure]), 1, 'one completion intent');
  });

  let adminWorld: Awaited<ReturnType<typeof crashAdminRoutes>> | undefined;
  await t.test('platform administration (ADM-001): staff, approvals, case grants, moderation, appeals, flags', async () => {
    adminWorld = await crashAdminRoutes(h, exactlyOnce);
  });

  // SANC-001: clearing a jurisdiction hold is a staff route behind an elevation. Runs after ADM-001, whose setup holds
  // the node and the two founding administrators; anna (elevated above) becomes the node's compliance officer through
  // the second-person path and clears a synthetic hold of `pure`.
  await t.test('clearing a jurisdiction hold (staff route)', async () => {
    assert.ok(adminWorld && elevatedAnna, 'the ADM-001 and support subtests ran first');
    const { world, actors: staffActors } = adminWorld;
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('staff_role_definition_version').values({ role: 'compliance-officer', version: 1, scopes: ['node'], permissions: ['admin.claims.read'], grant_max_hours: 72, sod_mode: 'reduced' }).onConflict((oc) => oc.doNothing()).execute());
    await staffActors.assignSensitive({ personId: seed.people.anna, role: 'compliance-officer', scope: { kind: 'node', nodeId: world.nodeId } });
    const holdId = await withMaintenance(h.db.admin, async (trx) => (await trx.insertInto('jurisdiction_hold').values({ person_id: seed.people.pure, place: 'CU', source: 'geolocation', dataset: 'fake' }).returning('id').executeTakeFirstOrThrow()).id);
    await exactlyOnce({ action: 'jurisdiction.hold.clear', client: elevatedAnna, url: `/v1/admin/jurisdiction/holds/${holdId}/clear`, body: { reason: 'Synthetic: confirmed at home by a call', evidence: 'call' }, effects: () => count(h.db.admin, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'jurisdiction.hold_cleared'") });
  });

  await t.test('assistant (AST-001): mandates, proposals, decisions, runs, stop control, conversation and backlog', async () => {
    const project = await newProject('Exactly once assistant');
    const draft = (moduleKey: string, actions: string[]) => ({
      onBehalfOf: null, grantee: { kind: 'own_agent' }, moduleKeys: [moduleKey], actions, contexts: [{ kind: 'project', id: project.id }],
      limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'pre_authorized' },
      approvers: [], escalation: { kind: 'ask_principal' }, validUntil: '2027-12-31T00:00:00.000Z',
    });
    const confirmed = () => auditCount(h.db.admin, 'assistant.mandate_confirmed');
    const mandate = await created(await exactlyOnce({ action: 'assistant.mandate_create', client: petr, url: '/v1/assistant/mandates', body: { draft: draft('project_planner', ['prepare']) }, effects: confirmed }));
    await exactlyOnce({ action: 'assistant.mandate_revise', client: petr, url: `/v1/assistant/mandates/${mandate.id}/confirm`, body: { expectedRevision: 1, draft: draft('project_planner', ['prepare', 'communicate']) }, effects: confirmed });
    await exactlyOnce({ action: 'assistant.mandate_suspend', client: petr, url: `/v1/assistant/mandates/${mandate.id}/suspend`, body: { expectedRevision: 2, reason: 'pause' }, effects: () => auditCount(h.db.admin, 'assistant.mandate_suspended') });
    await exactlyOnce({ action: 'assistant.mandate_revoke', client: petr, url: `/v1/assistant/mandates/${mandate.id}/revoke`, body: { expectedRevision: 3, reason: 'done' }, effects: () => auditCount(h.db.admin, 'assistant.mandate_revoked') });

    const principal = await principalFor(h.db.admin, seed.people.petr);
    const { service } = assistantService(h);
    const propose = () => withPrincipal(h.pool, principal, (trx) => service.proposeMandateChange(trx, { personId: seed.people.petr } as never, { kind: 'agent', runId: randomUUID() }, null, draft('project_planner', ['prepare']) as never));
    const proposal = await propose();
    await exactlyOnce({ action: 'assistant.proposal_confirm', client: petr, url: `/v1/assistant/mandate-proposals/${proposal.id}/confirm`, body: { digest: { algorithm: 'trustwork-digest-1', value: proposal.digest } }, effects: confirmed });
    const declined = await propose();
    await exactlyOnce({ action: 'assistant.proposal_decline', client: petr, url: `/v1/assistant/mandate-proposals/${declined.id}/decline`, body: {}, effects: () => auditCount(h.db.admin, 'assistant.mandate_proposal_declined') });

    const human = await created(await petr.post('/v1/assistant/mandates', { draft: draft('task_marketplace', ['confirm_execution']) }));
    const store = mandateStore(h);
    const decide = async () => {
      const result = await store.check({ personId: seed.people.petr, mandateId: human.id, action: 'confirm_execution', context: { kind: 'project', id: project.id }, at: new Date() }, ['task_marketplace']);
      assert.ok(!result.allowed && result.decisionId);
      const row = await h.db.admin.query<{ action_digest: string }>('SELECT action_digest FROM trustwork.action_intent WHERE id = $1', [result.decisionId]);
      return { id: result.decisionId, digest: { algorithm: 'trustwork-digest-1', value: row.rows[0]!.action_digest } };
    };
    const approve = await decide();
    await exactlyOnce({ action: 'assistant.decision_approve', client: petr, url: `/v1/assistant/decisions/${approve.id}/approve`, body: { digest: approve.digest }, effects: () => auditCount(h.db.admin, 'assistant.decision_approved') });
    await store.check({ personId: seed.people.petr, mandateId: human.id, action: 'confirm_execution', context: { kind: 'project', id: project.id }, at: new Date() }, ['task_marketplace']);
    const decline = await decide();
    await exactlyOnce({ action: 'assistant.decision_decline', client: petr, url: `/v1/assistant/decisions/${decline.id}/decline`, body: { reason: null }, effects: () => auditCount(h.db.admin, 'assistant.decision_declined') });

    const run = await withPrincipal(h.pool, principal, (trx) => runs.start(trx, { principal_person_id: seed.people.petr, kind: 'crash_test' }));
    await exactlyOnce({ action: 'assistant.run_cancel', client: petr, url: `/v1/assistant/runs/${run.id}/cancel`, body: { reason: null }, effects: () => auditCount(h.db.admin, 'assistant.run_cancelled') });
    await exactlyOnce({ action: 'assistant.conversation_turn', client: petr, url: '/v1/assistant/conversation', body: { text: 'What is waiting for me?' },
      effects: () => count(h.db.admin, "SELECT 1 FROM trustwork.conversation_turn WHERE role = 'person' AND person_id = $1", [seed.people.petr]) });
    const item = await withPrincipal(h.pool, principal, (trx) => serviceBacklog.propose(trx, { person_id: seed.people.petr, title: 'Ask three roofers for quotes', proposal: { kind: 'synthetic' } }));
    await exactlyOnce({ action: 'assistant.backlog_status', client: petr, url: `/v1/assistant/backlog/${item.id}/status`, body: { status: 'accepted', expectedRevision: 1 },
      effects: () => count(h.db.admin, "SELECT 1 FROM trustwork.service_backlog_item WHERE id = $1 AND status = 'accepted'", [item.id]) });
    await exactlyOnce({ action: 'assistant.stop_engage', client: petr, url: '/v1/assistant/stop', body: {}, effects: () => auditCount(h.db.admin, 'assistant.stop_engaged') });
    await exactlyOnce({ action: 'assistant.stop_release', client: petr, url: '/v1/assistant/stop/release', body: {}, effects: () => auditCount(h.db.admin, 'assistant.stop_released') });
  });

  // SANC-009: the deployment-location attestation is a staff route behind an elevation. Runs after the jurisdiction
  // hold subtest: anna (elevated above) becomes the node operator through the second-person path and attests.
  await t.test('attesting the deployment location (staff route)', async () => {
    assert.ok(adminWorld && elevatedAnna, 'the ADM-001 and support subtests ran first');
    const { world, actors: staffActors } = adminWorld;
    await staffActors.assignSensitive({ personId: seed.people.anna, role: 'node-operator', scope: { kind: 'node', nodeId: world.nodeId } });
    const body = { operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null, gateMode: 'upstream_gate', supersedes: null, statementVersion: 'deployment-location-1', confirmed: true, reason: 'Synthetic: exactly-once attestation' };
    await exactlyOnce({ action: 'jurisdiction.attestation.attest', client: elevatedAnna, url: '/v1/admin/jurisdiction/attestation', body, effects: () => count(h.db.admin, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'jurisdiction.location_attested'") });
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.deployment_location_attestation'), 1, 'one attestation');
  });

  // Modules added after this file was split register their crash cases in ./cases/*.ts (see cases/README.md).
  for (const crashCase of await loadCrashCases()) {
    await t.test(crashCase.name, () => crashCase.run({ h, seed, as, exactlyOnce }));
  }

  await t.test('every in-transaction route was crash-tested', () => {
    const expected = Object.entries(IDEMPOTENT_ROUTES).filter(([, mode]) => mode.kind === 'in_transaction').map(([action]) => action).sort();
    assert.deepEqual([...covered].sort(), expected);
  });
});
