import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../helpers/app.js';
import { EMAILS, login, seedPersonas, type PersonaKey } from '../helpers/personas.js';
import { auditCount, count } from '../hardening/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS, IDEMPOTENT_ROUTES } from '../../../apps/api/src/common/idempotency/index.js';
import { installCrashPoints, recordState } from './helpers.js';
import { withMaintenance } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';

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

  await t.test('every in-transaction route was crash-tested', () => {
    const expected = Object.entries(IDEMPOTENT_ROUTES).filter(([, mode]) => mode.kind === 'in_transaction').map(([action]) => action).sort();
    assert.deepEqual([...covered].sort(), expected);
  });
});
