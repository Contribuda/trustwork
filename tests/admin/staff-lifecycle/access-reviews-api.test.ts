import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AccessReviewCampaignSchema, AccessReviewItemSchema, type AccessReviewCampaign, type AccessReviewItem } from '../../../packages/contracts/src/staff-lifecycle.js';
import { Client, SKIP_REASON, startHarness } from '../../backend/helpers/app.js';
import { buildHttpWorld, command, expectRefusal, type AdminWorldHttp } from '../helpers.js';

const h = await startHarness('staff_access_reviews_api');

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
 * ADM-004 part 4 through the HTTP API with real sessions and elevated staff: a campaign over the hub's standing roles,
 * decisions by a reviewer who is not the holder, removal that revokes, reads by permission, withdrawal and the schema
 * walk. Every person and hub is synthetic.
 */
test('access reviews through the API (ADM-004 part 4)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: AdminWorldHttp = await buildHttpWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const hubId = w.world.hubId;
  const hub = { kind: 'hub', hubId } as const;
  const open = (client: Client, body: Record<string, unknown> = {}) => command(client, '/v1/admin/staff/access-reviews', { scope: hub, title: 'Synthetic review', roles: null, dueInSeconds: 30 * 86_400, ...body });
  const campaignOf = (r: { body: unknown }) => AccessReviewCampaignSchema.parse((r.body as { campaign: unknown }).campaign);
  const activeRoles = async (personId: string): Promise<string[]> => {
    const r = await c.hubOwner.get(`/v1/admin/staff/assignments?personId=${personId}&activeOnly=true`);
    return ((r.body as { assignments: Array<{ role: string }> }).assignments).map((a) => a.role).sort();
  };

  await t.test('negative: anonymous, participants and unelevated staff never open a review', async () => {
    expectRefusal(await new Client(w.app).post('/v1/admin/staff/access-reviews', {}, { idempotencyKey: 'anon-1' }), 401, 'auth.session_invalid');
    expectRefusal(await open(c.customer), 403, 'access.forbidden', 'staff');
    expectRefusal(await open(c.hubOwner), 403, 'access.forbidden', 'elevation');
  });

  await w.elevateAll();
  let campaign: AccessReviewCampaign;
  let items: AccessReviewItem[];

  await t.test('admin.staff.revoke opens a campaign over the hub\'s standing roles; staff without admin.staff.read see none', async () => {
    expectRefusal(await open(c.moderator), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await open(c.hubOwner, { dueInSeconds: 3600 }), 422, 'validation.schema');
    expectRefusal(await open(c.hubOwner, { roles: ['privacy-officer'] }), 404, 'access.not_found', 'review_empty');
    const opened = await open(c.hubOwner, { roles: ['moderator', 'support-lead', 'support-agent'] });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    campaign = campaignOf(opened);
    items = z.array(AccessReviewItemSchema).parse((opened.body as { items: unknown }).items);
    assert.deepEqual([campaign.status, campaign.openedBy, campaign.items], ['open', p.hubOwner, { total: 4, kept: 0, removed: 0, pending: 4, escalated: 0 }]);
    assert.deepEqual(items.map((i) => i.holderPersonId).sort(), [p.agent, p.lead, p.lead2, p.moderator].sort());
    assert.ok(items.every((i) => i.state === 'pending' && i.verdict === null));
    assert.deepEqual((await c.moderator.get(`/v1/admin/staff/access-reviews?hubId=${hubId}`)).body, { campaigns: [] });
    expectRefusal(await c.moderator.get(`/v1/admin/staff/access-reviews/${campaign.id}`), 404, 'access.not_found');
    const listed = (await c.admin.get(`/v1/admin/staff/access-reviews?hubId=${hubId}`)).body as { campaigns: Array<{ id: string }> };
    assert.ok(listed.campaigns.some((x) => x.id === campaign.id));
  });

  await t.test('a reviewer who is not the holder keeps or removes; remove revokes the role; the campaign closes with the last decision', async () => {
    const decide = (client: Client, id: string, verdict: string) => command(client, `/v1/admin/staff/access-reviews/items/${id}/decide`, { verdict });
    const ofLead = items.find((i) => i.holderPersonId === p.lead)!;
    expectRefusal(await decide(c.moderator, ofLead.id, 'keep'), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await decide(c.lead, ofLead.id, 'keep'), 403, 'access.forbidden', 'forbidden');
    const kept = await decide(c.hubOwner, ofLead.id, 'keep');
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    const keptItem = AccessReviewItemSchema.parse((kept.body as { item: unknown }).item);
    assert.deepEqual([keptItem.state, keptItem.verdict, keptItem.effect, keptItem.decidedBy, keptItem.reason], ['decided', 'keep', 'kept', p.hubOwner, 'Synthetic test action']);
    const ofLead2 = items.find((i) => i.holderPersonId === p.lead2)!;
    const removed = await decide(c.admin, ofLead2.id, 'remove');
    assert.equal(AccessReviewItemSchema.parse((removed.body as { item: unknown }).item).effect, 'revoked');
    assert.deepEqual(await activeRoles(p.lead2), []);
    expectRefusal(await decide(c.admin, ofLead2.id, 'keep'), 409, 'validation.revision_conflict', 'invalid_transition');
    for (const key of ['agent', 'moderator'] as const) assert.equal((await decide(c.admin, items.find((i) => i.holderPersonId === p[key])!.id, 'keep')).status, 200);
    const closed = campaignOf(await c.hubOwner.get(`/v1/admin/staff/access-reviews/${campaign.id}`));
    assert.deepEqual([closed.status, closed.closedBy, closed.items], ['closed', p.admin, { total: 4, kept: 3, removed: 1, pending: 0, escalated: 0 }]);
  });

  await t.test('a campaign opened by mistake is withdrawn; nothing changes for its holders', async () => {
    const mistaken = campaignOf(await open(c.admin, { title: 'Synthetic mistaken review' }));
    const withdrawn = await command(c.hubOwner, `/v1/admin/staff/access-reviews/${mistaken.id}/withdraw`);
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(campaignOf(withdrawn).status, 'withdrawn');
    assert.deepEqual(await activeRoles(p.moderator), ['moderator']);
  });

  await t.test('no field of these views describes what a staff member does (schema walk)', () => {
    const names = [...fieldNames(AccessReviewCampaignSchema), ...fieldNames(AccessReviewItemSchema)];
    assert.ok(names.length > 20);
    assert.deepEqual(names.filter((n) => ACTIVITY.test(n)), []);
  });
});
