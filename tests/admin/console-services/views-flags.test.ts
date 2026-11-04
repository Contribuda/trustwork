import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  CONSOLE_NOTIFICATION_CATEGORIES, CONSOLE_VIEW_SURFACES, CONSOLE_VIEW_VOCABULARY, ConsoleActionCodeSchema, ConsoleFlagSchema, ConsoleNotificationSettingsSchema, ConsoleSavedViewSchema, type ConsoleFlag, type ConsoleSavedView,
} from '../../../packages/contracts/src/console-services.js';
import { HubConfigDomainSchema, HubStaffRoleSchema } from '../../../packages/contracts/src/hub.js';
import { consoleFlags, consoleNotifications, consoleViews } from '../../../packages/data/src/repositories/console-services.js';
import { featureFlags, staffAssignments } from '../../../packages/data/src/repositories/admin.js';
import { flagBucket } from '../../../apps/api/src/modules/platform-admin/console-services/flag-buckets.js';
import { Client, SKIP_REASON, startHarness, type Response } from '../../backend/helpers/app.js';
import { auditRows, command, emailOf, expectRefusal, signIn } from '../helpers.js';
import { rejects } from '../../data/admin/helpers.js';
import { buildConsoleWorld, ids, type ConsoleWorld } from './helpers.js';

const h = await startHarness('console_views_flags');

/**
 * ADM-005: saved views per person and per team, a person's notification settings, and the rollout stages of a flag.
 * Acceptance here: "Turning a flag off is immediate; a flag stage cannot target individual people (tested)."
 */
test('console views, notification settings and flag stages (ADM-005)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: ConsoleWorld = await buildConsoleWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const { hubId, otherHubId } = w;
  const hub = { kind: 'hub', hubId } as const;
  const otherHub = { kind: 'hub', hubId: otherHubId } as const;
  const configuration = { filters: { state: ['open'] }, columns: ['number', 'state'], sort: { column: 'openedAt', direction: 'descending' } };
  const flagView = { filters: { stage: ['off'] }, columns: ['key'], sort: null };
  const incidentView = { filters: { severity: ['sev1'] }, columns: ['severity'], sort: null };
  const viewOf = (r: Response): ConsoleSavedView => ConsoleSavedViewSchema.parse((r.body as { view: unknown }).view);
  const create = (client: Client, body: Record<string, unknown> = {}) => command(client, '/v1/admin/console/views', { scope: hub, surface: 'support:cases', name: 'Open cases', configuration, teamRole: null, isDefault: false, ...body });
  const list = async (client: Client, query = `hubId=${hubId}`): Promise<ConsoleSavedView[]> => {
    const response = await client.get(`/v1/admin/console/views?${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return (response.body as { views: unknown[] }).views.map((v) => ConsoleSavedViewSchema.parse(v));
  };

  await t.test('the database and the contract hold the same vocabularies, and the stage table has nowhere to put a person', async () => {
    const { rows: [vocab] } = await h.db.admin.query<{ surfaces: string[]; categories: string[]; views: unknown }>('SELECT trustwork.console_view_surfaces() AS surfaces, trustwork.console_notification_categories() AS categories, trustwork.console_view_vocabulary() AS views');
    assert.deepEqual(vocab?.views, JSON.parse(JSON.stringify(CONSOLE_VIEW_VOCABULARY)), 'the same filters, values and columns per surface');
    assert.deepEqual(vocab?.surfaces, [...CONSOLE_VIEW_SURFACES]);
    assert.deepEqual(vocab?.categories, [...CONSOLE_NOTIFICATION_CATEGORIES]);
    // The reads never select a column of free text, or what a person's id could reach an audit row through.
    const { rows: reads } = await h.db.admin.query<{ proname: string; prosrc: string }>("SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork' AND p.proname IN ('console_search', 'console_work_items')");
    assert.equal(reads.length, 2);
    for (const read of reads) assert.doesNotMatch(read.prosrc, /\.(payload|summary|title|reason|purpose|decline_reason|decision_reason|reason_text|detail|object_id|display_name)\b/, read.proname);
    // A stored value the contract cannot name would fail a whole list, so everything a hit or a row carries is in the contract.
    const { rows: [stored] } = await h.db.admin.query<{ actions: string[]; roles: string[]; domains: string[] }>('SELECT trustwork.admin_second_person_actions() AS actions, trustwork.admin_staff_roles() AS roles, trustwork.hubs_config_domains() AS domains');
    assert.deepEqual((stored?.actions ?? []).filter((a) => !ConsoleActionCodeSchema.safeParse(a).success), []);
    assert.deepEqual((stored?.roles ?? []).filter((r) => !HubStaffRoleSchema.safeParse(r).success), []);
    assert.deepEqual((stored?.domains ?? []).filter((d) => !HubConfigDomainSchema.safeParse(d).success), []);
    const { rows } = await h.db.admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = 'feature_flag_rollout' ORDER BY ordinal_position");
    assert.deepEqual(rows.map((r) => r.column_name), ['flag_id', 'stage', 'share_percent', 'revision', 'updated_at']);
  });

  await t.test('negative: only an elevated staff member reaches views, settings and stages', async () => {
    for (const url of [`/v1/admin/console/views?hubId=${hubId}`, '/v1/admin/console/notifications', `/v1/admin/console/flags?hubId=${hubId}`]) {
      expectRefusal(await new Client(w.app).get(url), 401, 'auth.session_invalid');
      expectRefusal(await c.customer.get(url), 403, 'access.forbidden', 'staff');
      expectRefusal(await c.moderator.get(url), 403, 'access.forbidden', 'elevation');
    }
    expectRefusal(await create(c.moderator), 403, 'access.forbidden', 'elevation');
    await w.elevateAll();
  });

  await t.test('a personal view is its owner\'s alone', async () => {
    const created = await create(c.lead, { name: 'Lead personal' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const view = viewOf(created);
    assert.deepEqual([view.mine, view.teamRole, view.revision, view.scope], [true, null, 1, hub]);
    assert.ok(ids(await list(c.lead)).includes(view.id));
    for (const reader of [c.lead2, c.agent, c.owner, c.hubOwner, c.auditor]) assert.ok(!ids(await list(reader)).includes(view.id), 'a personal view has no other reader');
    assert.deepEqual(await list(c.lead, `hubId=${otherHubId}`), [], 'another target');
    assert.deepEqual(await list(c.lead, `hubId=${hubId}&surface=flags`), [], 'another surface');
  });

  await t.test('a team view reaches the holders of the role covering the hub, and only them', async () => {
    const view = viewOf(await create(c.lead, { name: 'Team cases', teamRole: 'support-lead' }));
    const seen = (await list(c.lead2)).find((v) => v.id === view.id);
    assert.deepEqual([seen?.mine, seen?.teamRole, seen?.name], [false, 'support-lead', 'Team cases']);
    assert.ok(!JSON.stringify(seen).includes(p.lead), 'who owns it is not shown');
    for (const reader of [c.agent, c.moderator, c.hubOwner, c.owner]) assert.ok(!ids(await list(reader)).includes(view.id), 'another team');
    await w.actors.assign({ personId: p.otherAgent, role: 'support-lead', scope: otherHub });
    assert.deepEqual((await w.actors.as(p.otherAgent, (trx) => consoleViews.list(trx, hub))).map((v) => v.id), [], 'the same role at another hub');
    assert.deepEqual((await w.actors.as(p.otherAgent, (trx) => trx.selectFrom('console_saved_view').select('id').execute())), [], 'under row-level security, at any target');
    assert.deepEqual((await w.actors.as(p.customer, (trx) => trx.selectFrom('console_saved_view').select('id').execute())), [], 'a participant');
  });

  await t.test('negative: nobody shares into a team they are not in, or at a scope they do not cover', async () => {
    expectRefusal(await create(c.lead, { teamRole: 'moderator' }), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await create(c.lead, { scope: otherHub }), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await create(c.lead, { scope: { kind: 'platform' } }), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await create(c.lead, { scope: { kind: 'hub', hubId: 'not-an-id' } }), 422, 'validation.schema');
  });

  await t.test('negative: nothing a person typed reaches a team through a view, for any writer', async () => {
    const hexId = randomUUID().replaceAll('-', '');
    expectRefusal(await create(c.lead, { configuration: { ...configuration, query: 'maria' } }), 422, 'validation.unknown_field');
    for (const value of ['Maria.Petrova', 'maria.petrova', '1555-0100-123', 'maria:example.invalid', hexId, randomUUID()]) {
      expectRefusal(await create(c.lead, { configuration: { ...configuration, filters: { state: [value] } } }), 422, 'validation.schema');
    }
    expectRefusal(await create(c.lead, { name: 'maria@example.invalid' }), 422, 'validation.schema');
    const ctx = await w.actors.elevate(p.lead);
    const direct = (body: Partial<Parameters<typeof consoleViews.create>[2]>) => w.actors.as(p.lead, (trx) => consoleViews.create(trx, ctx, { scope: hub, surface: 'support:cases', name: 'Direct', configuration, teamRole: 'support-lead', isDefault: false, ...body }));
    await rejects(direct({ configuration: { ...configuration, query: 'maria' } }), '23514', 'admin.view_configuration');
    for (const value of ['Maria.Petrova', 'maria.petrova', '1555-0100-123', 'maria:example.invalid', 'maria@example.invalid', 'Maria Petrova', '15550100123', hexId, randomUUID()]) {
      await rejects(direct({ configuration: { ...configuration, filters: { state: [value] } } }), '23514', 'admin.view_configuration');
      await rejects(direct({ teamRole: null, configuration: { ...configuration, filters: { state: [value] } } }), '23514', 'admin.view_configuration');
    }
    await rejects(direct({ configuration: { ...configuration, filters: { mariaPetrova: ['open'] } } }), '23514', 'admin.view_configuration');
    await rejects(direct({ configuration: { ...configuration, columns: ['mariaPetrova'] } }), '23514', 'admin.view_configuration');
    await rejects(direct({ configuration: { ...configuration, sort: { column: 'mariaPetrova', direction: 'ascending' } } }), '23514', 'admin.view_configuration');
    await rejects(direct({ surface: 'flags' }), '23514', 'admin.view_configuration');
    await rejects(direct({ name: 'maria@example.invalid' }), '23514');
    await rejects(direct({ name: 'Call 555 0100 123' }), '23514');
    // The table holds it without the command too.
    await rejects(w.actors.owner((trx) => trx.insertInto('console_saved_view').values({ scope_kind: 'hub', hub_id: hubId, node_id: null, surface: 'support:cases', owner_person_id: p.lead, team_role: 'support-lead', name: 'Raw', configuration: JSON.stringify({ ...configuration, filters: { state: ['Maria.Petrova'] } }), removed_at: null }).execute()), '23514');
    // An update has the stored view's surface: the database answers, and the API says it as a shape error.
    const view = viewOf(await create(c.lead, { name: 'To edit' }));
    expectRefusal(await command(c.lead, `/v1/admin/console/views/${view.id}`, { expectedRevision: 1, name: 'To edit', configuration: { ...configuration, filters: { state: ['maria'] } }, teamRole: 'support-lead', isDefault: false }), 422, 'validation.schema', 'view_configuration');
    expectRefusal(await command(c.lead, `/v1/admin/console/views/${view.id}`, { expectedRevision: 1, name: 'To edit', configuration: { filters: { stage: ['off'] }, columns: ['key'], sort: null }, teamRole: null, isDefault: false }), 422, 'validation.schema', 'view_configuration');
  });

  await t.test('negative: only the owner changes a view, on the revision they saw', async () => {
    const view = viewOf(await create(c.lead, { name: 'Shared to change', teamRole: 'support-lead' }));
    const body = { expectedRevision: 1, name: 'Renamed', configuration, teamRole: 'support-lead', isDefault: false };
    expectRefusal(await command(c.lead2, `/v1/admin/console/views/${view.id}`, body), 404, 'access.not_found');
    expectRefusal(await command(c.lead2, `/v1/admin/console/views/${view.id}/remove`, { expectedRevision: 1 }), 404, 'access.not_found');
    expectRefusal(await command(c.owner, `/v1/admin/console/views/${view.id}/remove`, { expectedRevision: 1 }), 404, 'access.not_found');
    const renamed = viewOf(await command(c.lead, `/v1/admin/console/views/${view.id}`, body));
    assert.deepEqual([renamed.name, renamed.revision], ['Renamed', 2]);
    expectRefusal(await command(c.lead, `/v1/admin/console/views/${view.id}`, body), 409, 'validation.revision_conflict');
    expectRefusal(await command(c.lead, `/v1/admin/console/views/${view.id}/remove`, { expectedRevision: 1 }), 409, 'validation.revision_conflict');
    assert.equal((await command(c.lead, `/v1/admin/console/views/${view.id}/remove`, { expectedRevision: 2 })).status, 200);
    assert.ok(!ids(await list(c.lead)).includes(view.id));
    assert.ok(!ids(await list(c.lead2)).includes(view.id), 'gone for the team too');
    expectRefusal(await command(c.lead, `/v1/admin/console/views/${view.id}/remove`, { expectedRevision: 2 }), 404, 'access.not_found');
    const rows = await auditRows(h, "object_type = 'console_saved_view' AND object_id = $1", [view.id]);
    assert.deepEqual(rows.map((r) => r.action), ['console.view_created', 'console.view_updated', 'console.view_removed']);
  });

  await t.test('negative: a member who left the team neither reads nor keeps writing into it', async () => {
    const view = viewOf(await create(c.lead2, { name: 'Leaving', teamRole: 'support-lead' }));
    await w.actors.assign({ personId: p.lead2, role: 'moderator', scope: hub });
    const held = await w.actors.as(p.owner, (trx) => staffAssignments.list(trx, { personId: p.lead2, activeOnly: true }));
    const ctx = await w.actors.elevate(p.owner);
    await w.actors.as(p.owner, (trx) => staffAssignments.revoke(trx, ctx, held.find((a) => a.role === 'support-lead')?.id as string));
    const own = await w.actors.elevate(p.lead2);
    await rejects(w.actors.as(p.lead2, (trx) => consoleViews.update(trx, own, view.id, { expectedRevision: 1, name: 'Still mine', configuration, teamRole: 'support-lead', isDefault: false })), '42501', 'admin.forbidden');
    assert.equal((await w.actors.as(p.lead2, (trx) => consoleViews.update(trx, own, view.id, { expectedRevision: 1, name: 'Made personal', configuration, teamRole: null, isDefault: false }))).team_role, null, 'they can take it back');
    await w.actors.assign({ personId: p.lead2, role: 'support-lead', scope: hub });
  });

  await t.test('concurrency: one default per surface and at most 100 views, whatever arrives together', async () => {
    const defaults = await Promise.all([0, 1, 2, 3].map((i) => create(c.agent, { name: `Default ${i}`, surface: 'flags', configuration: flagView, isDefault: true })));
    assert.deepEqual(defaults.map((r) => r.status), [201, 201, 201, 201]);
    assert.equal((await list(c.agent, `hubId=${hubId}&surface=flags`)).filter((v) => v.isDefault).length, 1);
    const ctx = await w.actors.elevate(p.ops);
    await w.actors.owner(async (trx) => {
      for (let i = 0; i < 99; i += 1) await trx.insertInto('console_saved_view').values({ scope_kind: 'hub', hub_id: hubId, node_id: null, surface: 'incidents', owner_person_id: p.ops, team_role: null, name: `Filled ${i}`, configuration: JSON.stringify(incidentView), removed_at: null }).execute();
    });
    const raced = await Promise.allSettled([1, 2].map((i) => w.actors.as(p.ops, (trx) => consoleViews.create(trx, { ...ctx, requestId: `req-${randomUUID()}` }, { scope: hub, surface: 'incidents', name: `Race ${i}`, configuration: incidentView, teamRole: null, isDefault: false }))));
    assert.deepEqual(raced.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    await rejects(w.actors.as(p.ops, (trx) => consoleViews.create(trx, ctx, { scope: hub, surface: 'incidents', name: 'Over', configuration: incidentView, teamRole: null, isDefault: false })), '23514', 'admin.view_limit');
  });

  await t.test('notification settings: nothing by default, and each person reads and writes only their own', async () => {
    const empty = await c.lead.get('/v1/admin/console/notifications');
    assert.deepEqual(ConsoleNotificationSettingsSchema.parse(empty.body), { emailCategories: [], quietHours: null, revision: 0 });
    const body = { scope: hub, expectedRevision: 0, emailCategories: ['approvals', 'incidents'], quietHours: { fromMinute: 1320, untilMinute: 420, timeZone: 'Europe/Madrid' } };
    const set = await command(c.lead, '/v1/admin/console/notifications', body);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(ConsoleNotificationSettingsSchema.parse(set.body), { emailCategories: ['approvals', 'incidents'], quietHours: body.quietHours, revision: 1 });
    assert.deepEqual(ConsoleNotificationSettingsSchema.parse((await c.lead2.get('/v1/admin/console/notifications')).body).emailCategories, [], 'not someone else\'s');
    assert.deepEqual(await w.actors.as(p.lead2, (trx) => consoleNotifications.get(trx)), undefined, 'under row-level security too');
    assert.equal(await w.actors.owner(async (trx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM trustwork.console_notification_setting`.execute(trx)).rows[0]?.n), 1);
    expectRefusal(await command(c.lead, '/v1/admin/console/notifications', body), 409, 'validation.revision_conflict');
    expectRefusal(await command(c.lead, '/v1/admin/console/notifications', { ...body, expectedRevision: 1, emailCategories: ['everything'] }), 422, 'validation.schema');
    expectRefusal(await command(c.lead, '/v1/admin/console/notifications', { ...body, expectedRevision: 1, emailCategories: ['approvals', 'approvals'] }), 422, 'validation.schema');
    expectRefusal(await command(c.lead, '/v1/admin/console/notifications', { ...body, expectedRevision: 1, quietHours: { fromMinute: 60, untilMinute: 60, timeZone: 'UTC' } }), 422, 'validation.schema');
    expectRefusal(await command(c.lead, '/v1/admin/console/notifications', { ...body, expectedRevision: 1, quietHours: { fromMinute: 60, untilMinute: 120, timeZone: 'Mars/Olympus' } }), 422, 'validation.schema');
    expectRefusal(await command(c.lead, '/v1/admin/console/notifications', { ...body, expectedRevision: 1, personId: p.lead2 }), 422, 'validation.unknown_field');
    expectRefusal(await command(c.lead, '/v1/admin/console/notifications', { ...body, expectedRevision: 1, scope: otherHub }), 403, 'access.forbidden', 'forbidden');
    const cleared = await command(c.lead, '/v1/admin/console/notifications', { ...body, expectedRevision: 1, emailCategories: [], quietHours: null });
    assert.deepEqual(ConsoleNotificationSettingsSchema.parse(cleared.body), { emailCategories: [], quietHours: null, revision: 2 });
    const races = await Promise.all([1, 2].map(() => command(c.agent, '/v1/admin/console/notifications', { ...body, emailCategories: ['alerts'] })));
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409], 'the first write of a person is not lost to a race');
  });

  /* ---------- Flags ---------- */

  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const flagIn = async (key: string, scope: typeof hub | typeof otherHub = hub): Promise<string> => {
    const response = await command(c.owner, '/v1/admin/flags', { scope, key, value: 'variant_b', description: 'Synthetic flag', declaredEffect: 'ui', expiresAt });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return (response.body as { flag: { id: string } }).flag.id;
  };
  const flag = async (id: string, reader: Client = c.hubOwner, query = `hubId=${hubId}`): Promise<ConsoleFlag> => {
    const response = await reader.get(`/v1/admin/console/flags?${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const found = (response.body as { flags: unknown[] }).flags.map((f) => ConsoleFlagSchema.parse(f)).find((f) => f.id === id);
    assert.ok(found, 'the flag is listed');
    return found;
  };
  const stage = (client: Client, id: string, stageName: string, expectedRevision: number, sharePercent: number | null = null) => command(client, `/v1/admin/console/flags/${id}/stage`, { stage: stageName, sharePercent, expectedRevision });
  const active = async (client: Client): Promise<string[]> => {
    const response = await client.get('/v1/flags/active');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return (response.body as { flags: { key: string }[] }).flags.map((f) => f.key);
  };

  await t.test('a new flag starts off and moves through its stages; off is immediate for every session', async () => {
    const id = await flagIn('ui.stage_walk');
    assert.deepEqual([(await flag(id)).stage, (await flag(id)).sharePercent, (await flag(id)).revision], ['off', null, 1]);
    assert.ok(!(await active(c.customer)).includes('ui.stage_walk'));
    assert.ok(!(await active(c.lead)).includes('ui.stage_walk'));

    assert.equal((await stage(c.hubOwner, id, 'staff_only', 1)).status, 200);
    assert.ok((await active(c.lead)).includes('ui.stage_walk'), 'staff covering the hub');
    assert.ok(!(await active(c.customer)).includes('ui.stage_walk'), 'not a participant');
    assert.ok(!(await active(c.otherAgent)).includes('ui.stage_walk'), 'not staff of another hub');

    assert.equal((await stage(c.hubOwner, id, 'on', 2)).status, 200);
    const value = (await c.customer.get('/v1/flags/active')).body as { flags: { key: string; value: unknown }[] };
    assert.deepEqual(value.flags.find((f) => f.key === 'ui.stage_walk')?.value, 'variant_b');

    const off = await stage(c.hubOwner, id, 'off', 1);
    assert.equal(off.status, 200, 'off takes no revision: a stale one does not stop it');
    assert.ok(!(await active(c.customer)).includes('ui.stage_walk'), 'off in the very next read');
    assert.ok(!(await active(c.lead)).includes('ui.stage_walk'));
    assert.deepEqual((await auditRows(h, "object_type = 'feature_flag' AND object_id = $1 AND action LIKE 'flags.stage_%'", [id])).map((r) => r.action), ['flags.stage_staff_only', 'flags.stage_on', 'flags.stage_off']);
  });

  await t.test('a share follows the person: signing in again does not reach it', async () => {
    // A flag for which the customer falls outside half of everyone; a new sign-in must not change that.
    let id = '';
    for (let n = 0; !id || flagBucket(id, p.customer) < 50; n += 1) id = await flagIn(`ui.share_walk_${n}`);
    const key = (await flag(id)).key;
    assert.equal((await stage(c.hubOwner, id, 'share', 1, 50)).status, 200);
    const shown = await flag(id);
    assert.deepEqual([shown.stage, shown.sharePercent], ['share', 50]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const again = new Client(w.app);
      await signIn(again, emailOf('customer'));
      assert.ok(!(await active(again)).includes(key), `sign-in ${attempt}`);
    }
    // Someone inside stays inside, on every session; staff are in a share by their own bucket like anyone else.
    let inside = '';
    for (let n = 0; !inside || flagBucket(inside, p.customer) >= 50; n += 1) inside = await flagIn(`ui.share_in_${n}`);
    const insideKey = (await flag(inside)).key;
    assert.equal((await stage(c.hubOwner, inside, 'share', 1, 50)).status, 200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = new Client(w.app);
      await signIn(again, emailOf('customer'));
      assert.ok((await active(again)).includes(insideKey), `sign-in ${attempt}`);
    }
    assert.equal((await active(c.lead)).includes(insideKey), flagBucket(inside, p.lead) < 50);
  });

  await t.test('negative: a stage is decided on the revision it saw, so a widening cannot undo an off', async () => {
    const id = await flagIn('ui.race_walk');
    assert.equal((await stage(c.hubOwner, id, 'staff_only', 1)).status, 200);
    assert.equal((await stage(c.hubOwner, id, 'off', 2)).status, 200);
    expectRefusal(await stage(c.owner, id, 'on', 2), 409, 'validation.revision_conflict');
    assert.equal((await flag(id)).stage, 'off');
    // Off on a flag already off still ends what was decided before it.
    const before = (await flag(id)).revision;
    assert.equal((await stage(c.hubOwner, id, 'off', before)).status, 200);
    expectRefusal(await stage(c.owner, id, 'on', before), 409, 'validation.revision_conflict');
    for (let round = 0; round < 5; round += 1) {
      const { revision } = await flag(id);
      const raced = await Promise.all([stage(c.owner, id, 'on', revision), stage(c.hubOwner, id, 'off', revision)]);
      assert.equal(raced[1]?.status, 200, 'off always applies');
      assert.equal((await flag(id)).stage, 'off', 'whichever came first, off is where it ends');
    }
  });

  await t.test('negative: who may move a stage, at which scope', async () => {
    const here = await flagIn('ui.scope_walk');
    const there = await flagIn('ui.scope_walk', otherHub);
    expectRefusal(await stage(c.moderator, here, 'on', 1), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await stage(c.lead, here, 'off', 1), 403, 'access.forbidden', 'forbidden');
    assert.equal((await auditRows(h, "outcome = 'denied' AND object_id = $1 AND actor_person_id = $2", [here, p.moderator])).length, 1, 'a refusal is audited at the flag\'s scope');
    expectRefusal(await stage(c.hubOwner, there, 'on', 1), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await stage(c.hubOwner, randomUUID(), 'on', 1), 404, 'access.not_found');
    assert.equal((await flag(there, c.owner, `hubId=${otherHubId}`)).stage, 'off');
    assert.equal(((await c.hubOwner.get(`/v1/admin/console/flags?hubId=${otherHubId}`)).body as { flags: unknown[] }).flags.length, 0, 'another hub\'s flags are not listed');
    assert.equal((await stage(c.owner, there, 'on', 1)).status, 200);
    assert.ok(!(await active(c.customer)).includes('ui.scope_walk'), 'on at another hub is not on here');
    expectRefusal(await c.customer.get(`/v1/flags/active?hubId=${otherHubId}`), 422, 'validation.unknown_field');
  });

  // The table's own check forbids an expiry before creation; a flag only gets there with time, which the tests do not have.
  await w.actors.owner((trx) => sql`ALTER TABLE trustwork.feature_flag DROP CONSTRAINT feature_flag_expiry`.execute(trx));

  await t.test('negative: an expired flag is in force for nobody, can be set off and cannot be widened', async () => {
    const id = await flagIn('ui.expiry_walk');
    assert.equal((await stage(c.hubOwner, id, 'on', 1)).status, 200);
    assert.ok((await active(c.customer)).includes('ui.expiry_walk'));
    await w.actors.owner(async (trx) => {
      await sql`UPDATE trustwork.feature_flag SET expires_at = now() - interval '1 minute' WHERE id = ${id}::uuid`.execute(trx);
    });
    assert.ok(!(await active(c.customer)).includes('ui.expiry_walk'));
    assert.equal((await flag(id)).expired, true, 'listed for removal from code');
    expectRefusal(await stage(c.hubOwner, id, 'share', 2, 5), 409, 'validation.revision_conflict');
    assert.equal((await stage(c.hubOwner, id, 'off', 2)).status, 200);
  });

  await t.test('negative: extending an expired flag brings it back at off with a new revision, for every writer', async () => {
    const expire = (flagId: string) => w.actors.owner((trx) => sql`UPDATE trustwork.feature_flag SET expires_at = now() - interval '1 minute' WHERE id = ${flagId}::uuid`.execute(trx));
    const extend = (key: string) => command(c.owner, '/v1/admin/flags', { scope: hub, key, value: true, description: 'Synthetic flag', declaredEffect: 'ui', expiresAt });
    const id = await flagIn('ui.revive_walk');
    assert.equal((await stage(c.hubOwner, id, 'on', 1)).status, 200);
    assert.ok((await active(c.customer)).includes('ui.revive_walk'));
    await expire(id);
    assert.ok(!(await active(c.customer)).includes('ui.revive_walk'));
    const { revision } = await flag(id);
    assert.equal((await extend('ui.revive_walk')).status, 200);
    const back = await flag(id);
    assert.deepEqual([back.stage, back.sharePercent, back.expired, back.revision], ['off', null, false, revision + 1], 'off, and the revision moved');
    assert.ok(!(await active(c.customer)).includes('ui.revive_walk'), 'not back for everyone');
    assert.ok(!(await active(c.lead)).includes('ui.revive_walk'), 'nor for staff');
    expectRefusal(await stage(c.hubOwner, id, 'on', revision), 409, 'validation.revision_conflict');
    assert.equal((await stage(c.hubOwner, id, 'staff_only', revision + 1)).status, 200, 'widening starts again, on purpose');

    // A share keeps nothing of its percent, and a raw writer is held to the same rule.
    const shared = await flagIn('ui.revive_share');
    assert.equal((await stage(c.hubOwner, shared, 'share', 1, 25)).status, 200);
    await expire(shared);
    await w.actors.owner((trx) => sql`UPDATE trustwork.feature_flag SET expires_at = now() + interval '1 day' WHERE id = ${shared}::uuid`.execute(trx));
    assert.deepEqual([(await flag(shared)).stage, (await flag(shared)).sharePercent], ['off', null]);

    // Changing the date of a live flag leaves its stage alone.
    const live = await flagIn('ui.revive_live');
    assert.equal((await stage(c.hubOwner, live, 'on', 1)).status, 200);
    assert.equal((await extend('ui.revive_live')).status, 200);
    assert.deepEqual([(await flag(live)).stage, (await flag(live)).revision], ['on', 2]);
  });

  await t.test('negative: no flag is about ranking, matching, reputation or payment, for any writer', async () => {
    const body = { scope: hub, value: true, description: 'Synthetic flag', declaredEffect: 'ui', expiresAt };
    const ctx = await w.actors.elevate(p.owner);
    for (const key of ['matching.v2', 'ranking.fresh_b', 'payment.new_form', 'reputation.decay_b', 'ui.payment_form', 'sponsored.slots_b', 'recommendations.rule_b']) {
      expectRefusal(await command(c.owner, '/v1/admin/flags', { ...body, key }), 422, 'validation.schema');
      await rejects(w.actors.as(p.owner, (trx) => featureFlags.set(trx, ctx, { scope: hub, key, value: true, description: 'Synthetic flag', declaredEffect: 'ui', expiresAt: new Date(expiresAt) })), '23514');
    }
    assert.equal((await command(c.owner, '/v1/admin/flags', { ...body, key: 'ops.dispatch_batching' })).status, 200, 'a word inside another word is not one of them');
  });

  await t.test('negative: a stage changes nothing about what a flag may be, and no writer outside the command moves it', async () => {
    expectRefusal(await command(c.owner, '/v1/admin/flags', { scope: hub, key: 'ui.access_widen', value: true, description: 'Synthetic', declaredEffect: 'ui', expiresAt }), 422, 'validation.schema');
    const id = await flagIn('ui.writer_walk');
    await rejects(w.actors.as(p.owner, (trx) => sql`UPDATE trustwork.feature_flag_rollout SET stage = 'on' WHERE flag_id = ${id}::uuid`.execute(trx)), '42501');
    await rejects(w.actors.as(p.owner, (trx) => sql`INSERT INTO trustwork.feature_flag_rollout (flag_id, stage) VALUES (${randomUUID()}::uuid, 'on')`.execute(trx)), '42501');
    await rejects(w.actors.owner((trx) => sql`UPDATE trustwork.feature_flag_rollout SET stage = 'share' WHERE flag_id = ${id}::uuid`.execute(trx)), '23514');
    await rejects(w.actors.owner((trx) => sql`DELETE FROM trustwork.feature_flag_rollout WHERE flag_id = ${id}::uuid`.execute(trx)), '23000');
    const ctx = await w.actors.elevate(p.hubOwner);
    await rejects(w.actors.as(p.hubOwner, (trx) => consoleFlags.setStage(trx, ctx, { flagId: id, stage: 'share', sharePercent: 7, expectedRevision: 1 })), '23514');
    // Setting a value through the flags route leaves the stage where it is.
    assert.equal((await command(c.owner, '/v1/admin/flags', { scope: hub, key: 'ui.writer_walk', value: 'variant_c', description: 'Synthetic flag', declaredEffect: 'ui', expiresAt })).status, 200);
    assert.equal((await flag(id)).stage, 'off');
  });

  await t.test('negative: the session read needs a session and names only what is in force', async () => {
    expectRefusal(await new Client(w.app).get('/v1/flags/active'), 401, 'auth.session_invalid');
    expectRefusal(await c.customer.get(`/v1/flags/active?personId=${p.lead}`), 422, 'validation.unknown_field');
    const id = await flagIn('ui.hidden_walk');
    assert.equal((await stage(c.hubOwner, id, 'staff_only', 1)).status, 200);
    assert.ok(!JSON.stringify((await c.customer.get('/v1/flags/active')).body).includes('ui.hidden_walk'), 'a staff-only flag is not named to anyone else');
  });
});
