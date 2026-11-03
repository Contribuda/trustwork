import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { RoleChangePreviewSchema, StaffActivationViewSchema, StaffEligibleRoleViewSchema, type RoleChangePreview } from '../../../packages/contracts/src/staff-lifecycle.js';
import { Client, SKIP_REASON, startHarness } from '../../backend/helpers/app.js';
import { buildHttpWorld, command, expectRefusal, type AdminWorldHttp } from '../helpers.js';

const h = await startHarness('staff_eligible_roles_api');

/** Field names that would describe what a staff member does rather than who they are and what they may do. */
const ACTIVITY = /(activ(e|ity)At|last|seen|signIn|login|elevat|count|decision|response|productiv|behavio|duration|minutes|hours|score|rank)/i;
function fieldNames(schema: z.ZodType, out: string[] = []): string[] {
  const def = (schema as unknown as { def: { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; innerType?: z.ZodType; options?: z.ZodType[] } }).def;
  if (def.type === 'object' && def.shape) for (const [k, v] of Object.entries(def.shape)) { out.push(k); fieldNames(v, out); }
  if (def.type === 'array' && def.element) fieldNames(def.element, out);
  if ((def.type === 'nullable' || def.type === 'optional') && def.innerType) fieldNames(def.innerType, out);
  if (def.type === 'union' && def.options) for (const o of def.options) fieldNames(o, out);
  return out;
}

/**
 * ADM-004 part 3 through the HTTP API with real sessions and elevated staff: eligibility granted and activated with a
 * fresh second factor, the second person for a sensitive role (a different role in full separation-of-duties mode), the
 * role-change preview, a stale preview refused, a blocking conflict refused, a sensitive addition that needs an approval,
 * and two concurrent applies of one preview. Ten staff people cover the hub, so it runs in full mode. Every person is synthetic.
 */
test('eligible roles, activations and the role-change preview through the API (ADM-004 part 3)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: AdminWorldHttp = await buildHttpWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const hubId = w.world.hubId;
  const hub = { kind: 'hub', hubId } as const;
  const HOUR = 3600;
  const grant = (client: Client, personId: string, role: string, maxActivationSeconds = 4 * HOUR) =>
    command(client, '/v1/admin/staff/eligible-roles', { personId, role, scope: hub, definitionVersion: 1, maxActivationSeconds, validForSeconds: null });
  const activate = (client: Client, eligibleRoleId: string, windowSeconds = HOUR) => command(client, '/v1/admin/staff/activations', { eligibleRoleId, windowSeconds });
  const decide = (client: Client, id: string, decision: 'approve' | 'decline') => command(client, `/v1/admin/staff/activations/${id}/decide`, { decision });
  const activeRoles = async (personId: string): Promise<string[]> => {
    const r = await c.hubOwner.get(`/v1/admin/staff/assignments?personId=${personId}&activeOnly=true`);
    return ((r.body as { assignments: Array<{ role: string }> }).assignments).map((a) => a.role).sort();
  };
  const eligibleId = (r: { body: unknown }) => StaffEligibleRoleViewSchema.parse((r.body as { eligibleRole: unknown }).eligibleRole).id;
  const activation = (r: { body: unknown }) => StaffActivationViewSchema.parse((r.body as { activation: unknown }).activation);

  await t.test('negative: anonymous, participants and unelevated staff never grant or activate', async () => {
    expectRefusal(await new Client(w.app).post('/v1/admin/staff/eligible-roles', {}, { idempotencyKey: 'anon-1' }), 401, 'auth.session_invalid');
    expectRefusal(await grant(c.customer, p.lead, 'moderator'), 403, 'access.forbidden', 'staff');
    expectRefusal(await grant(c.hubOwner, p.lead, 'moderator'), 403, 'access.forbidden', 'elevation');
  });

  await w.elevateAll();

  await t.test('a staff administrator grants an eligibility; the eligible person activates it with their fresh second factor and ends it early', async () => {
    expectRefusal(await grant(c.moderator, p.lead, 'moderator'), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await grant(c.hubOwner, p.hubOwner, 'moderator'), 403, 'access.forbidden', 'self_grant');
    expectRefusal(await grant(c.hubOwner, p.lead, 'moderator', 13 * HOUR), 422, 'validation.schema');
    const granted = await grant(c.hubOwner, p.lead, 'moderator');
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    const view = StaffEligibleRoleViewSchema.parse((granted.body as { eligibleRole: unknown }).eligibleRole);
    assert.deepEqual([view.personId, view.role, view.grantedBy, view.sensitive, view.open], [p.lead, 'moderator', p.hubOwner, false, true]);
    assert.deepEqual(await activeRoles(p.lead), ['support-lead']);
    expectRefusal(await activate(c.lead2, view.id), 404, 'access.not_found');
    expectRefusal(await activate(c.lead, view.id, 5 * HOUR), 422, 'validation.schema', 'activation_too_long');
    const started = await activate(c.lead, view.id, 2 * HOUR);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal((started.body as { result: { outcome: string } }).result.outcome, 'active');
    const act = activation(started);
    assert.deepEqual([act.state, act.windowSeconds, act.approvalId], ['active', 2 * HOUR, null]);
    assert.deepEqual(await activeRoles(p.lead), ['moderator', 'support-lead']);
    // One's own eligible roles and activations without admin.staff.read; the hub owner sees everyone's.
    const mine = (await c.lead.get(`/v1/admin/staff/eligible-roles?hubId=${hubId}`)).body as { eligibleRoles: unknown[] };
    assert.equal(mine.eligibleRoles.length, 1);
    assert.deepEqual((await c.moderator.get(`/v1/admin/staff/activations?hubId=${hubId}`)).body, { activations: [] });
    const all = (await c.hubOwner.get(`/v1/admin/staff/activations?hubId=${hubId}`)).body as { activations: Array<{ id: string }> };
    assert.ok(all.activations.some((a) => a.id === act.id));
    expectRefusal(await command(c.moderator, `/v1/admin/staff/activations/${act.id}/end`), 403, 'access.forbidden', 'forbidden');
    const ended = await command(c.lead, `/v1/admin/staff/activations/${act.id}/end`);
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(activation(ended).state, 'ended');
    assert.deepEqual(await activeRoles(p.lead), ['support-lead']);
  });

  await t.test('a sensitive role waits for a second person who is neither the holder nor the grantor and, in full mode, acts through another role', async () => {
    const id = eligibleId(await grant(c.hubOwner, p.lead2, 'staff-admin', 3 * HOUR));
    const requested = await activate(c.lead2, id);
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    assert.equal((requested.body as { result: { outcome: string } }).result.outcome, 'pending_second_person');
    const act = activation(requested);
    assert.deepEqual([act.state, act.sensitive], ['pending', true]);
    assert.ok(act.approvalId);
    assert.deepEqual(await activeRoles(p.lead2), ['support-lead']);
    expectRefusal(await decide(c.lead2, act.id, 'approve'), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await decide(c.hubOwner, act.id, 'approve'), 403, 'access.second_approver_required', 'same_decider');
    const approved = await decide(c.admin, act.id, 'approve');
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual([activation(approved).state, activation(approved).approvedBy, activation(approved).decidedBy], ['active', p.admin, p.admin]);
    assert.deepEqual(await activeRoles(p.lead2), ['staff-admin', 'support-lead']);
    // Grantor and approver through the same role (staff-admin) is refused in full mode; the platform owner may approve.
    const other = eligibleId(await grant(c.admin, p.agent, 'hub-owner', 2 * HOUR));
    const second = activation(await activate(c.agent, other));
    expectRefusal(await decide(c.admin2, second.id, 'approve'), 403, 'access.second_approver_required', 'same_role');
    const declined = await decide(c.owner, second.id, 'decline');
    assert.equal(activation(declined).state, 'declined');
    assert.deepEqual(await activeRoles(p.agent), ['support-agent']);
  });

  const preview = async (client: Client, body: Record<string, unknown>): Promise<RoleChangePreview> => {
    const r = await client.post('/v1/admin/staff/role-changes/preview', body, { idempotencyKey: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return RoleChangePreviewSchema.parse((r.body as { preview: unknown }).preview);
  };
  const apply = (client: Client, body: Record<string, unknown>) => command(client, '/v1/admin/staff/role-changes/apply', body);

  await t.test('the role-change preview shows gained and lost permissions and conflicts; a blocking conflict is refused at apply', async () => {
    expectRefusal(await c.moderator.post('/v1/admin/staff/role-changes/preview', { personId: p.agent, scope: hub, add: [{ role: 'moderator', definitionVersion: 1, validForSeconds: null }], remove: [] }, { idempotencyKey: null }), 403, 'access.forbidden');
    const gained = await preview(c.hubOwner, { personId: p.agent, scope: hub, add: [{ role: 'moderator', definitionVersion: 1, validForSeconds: null }], remove: [] });
    assert.deepEqual([gained.before.roles, gained.after.roles, gained.sod.mode], [['support-agent'], ['moderator', 'support-agent'], 'full']);
    assert.ok(gained.gained.includes('admin.moderation.decide') && gained.lost.length === 0 && gained.sod.conflicts.length === 0 && gained.approvals.length === 0);
    const conflict = await preview(c.hubOwner, { personId: p.ops, scope: hub, add: [{ role: 'auditor', definitionVersion: 1, validForSeconds: null }], remove: [] });
    assert.deepEqual(conflict.sod.conflicts, [{ role: 'auditor', conflictsWith: 'ops-engineer', blocking: true }]);
    expectRefusal(await apply(c.hubOwner, { personId: p.ops, scope: hub, add: [{ role: 'auditor', definitionVersion: 1, validForSeconds: null }], remove: [], previewDigest: conflict.previewDigest, approvals: [] }), 422, 'validation.schema', 'sod_conflict');
    assert.deepEqual(await activeRoles(p.ops), ['ops-engineer']);
  });

  await t.test('a stale preview is refused; a fresh one applies removals and additions in one transaction', async () => {
    const change = { personId: p.agent, scope: hub, add: [{ role: 'moderator', definitionVersion: 1, validForSeconds: null }], remove: [] as string[] };
    const stale = await preview(c.hubOwner, change);
    // The person's roles change in between (an auditor role assigned the ADM-001 way).
    const extra = await command(c.hubOwner, '/v1/admin/staff/assignments', { personId: p.agent, role: 'auditor', scope: hub, definitionVersion: 1 });
    assert.equal(extra.status, 201, JSON.stringify(extra.body));
    const extraId = (extra.body as { assignment: { id: string } }).assignment.id;
    expectRefusal(await apply(c.hubOwner, { ...change, previewDigest: stale.previewDigest, approvals: [] }), 409, 'validation.revision_conflict', 'preview_stale');
    assert.deepEqual(await activeRoles(p.agent), ['auditor', 'support-agent']);
    const fresh = await preview(c.hubOwner, { ...change, remove: [extraId] });
    assert.deepEqual([fresh.before.roles, fresh.after.roles], [['auditor', 'support-agent'], ['moderator', 'support-agent']]);
    assert.ok(fresh.lost.includes('admin.audit.read'));
    const applied = await apply(c.hubOwner, { ...change, remove: [extraId], previewDigest: fresh.previewDigest, approvals: [] });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const body = applied.body as { revoked: Array<{ id: string }>; assigned: Array<{ role: string }> };
    assert.deepEqual([body.revoked.map((r) => r.id), body.assigned.map((a) => a.role)], [[extraId], ['moderator']]);
    assert.deepEqual(await activeRoles(p.agent), ['moderator', 'support-agent']);
    expectRefusal(await apply(c.hubOwner, { ...change, remove: [extraId], previewDigest: fresh.previewDigest, approvals: [] }), 409, 'validation.revision_conflict', 'preview_stale');
  });

  await t.test('a sensitive addition names the approval of exactly that assignment', async () => {
    const change = { personId: p.agent, scope: hub, add: [{ role: 'staff-admin', definitionVersion: 1, validForSeconds: null }], remove: [] };
    const first = await preview(c.hubOwner, change);
    assert.equal(first.approvals.length, 1);
    const [needed] = first.approvals;
    expectRefusal(await apply(c.hubOwner, { ...change, previewDigest: first.previewDigest, approvals: [] }), 403, 'access.approval_required', 'approval_required');
    const requested = await command(c.hubOwner, '/v1/admin/approvals', { subject: { action: 'staff.assign_sensitive_role', personId: p.agent, role: 'staff-admin', scope: hub, definitionVersion: 1 } });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const approval = (requested.body as { approval: { id: string; actionDigest: string } }).approval;
    assert.equal(approval.actionDigest, needed!.actionDigest, 'the preview names the digest the approval binds');
    assert.equal((await command(c.admin, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: approval.actionDigest })).status, 200);
    const applied = await apply(c.hubOwner, { ...change, previewDigest: first.previewDigest, approvals: [{ role: 'staff-admin', approvalId: approval.id }] });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal((applied.body as { assigned: Array<{ approvedBy: string }> }).assigned[0]!.approvedBy, p.admin);
    assert.deepEqual(await activeRoles(p.agent), ['moderator', 'staff-admin', 'support-agent']);
  });

  await t.test('two concurrent applies of one preview: exactly one changes the roles', async () => {
    const change = { personId: p.moderator, scope: hub, add: [{ role: 'support-lead', definitionVersion: 1, validForSeconds: null }], remove: [] };
    const seen = await preview(c.hubOwner, change);
    const [a, b] = await Promise.all([apply(c.hubOwner, { ...change, previewDigest: seen.previewDigest, approvals: [] }), apply(c.admin, { ...change, previewDigest: seen.previewDigest, approvals: [] })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
    assert.deepEqual(await activeRoles(p.moderator), ['moderator', 'support-lead']);
  });

  await t.test('no field of these views describes what a staff member does (schema walk)', () => {
    const names = [...fieldNames(StaffEligibleRoleViewSchema), ...fieldNames(StaffActivationViewSchema), ...fieldNames(RoleChangePreviewSchema)];
    assert.ok(names.length > 30);
    assert.deepEqual(names.filter((n) => ACTIVITY.test(n)), []);
  });
});
