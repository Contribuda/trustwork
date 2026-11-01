import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { ConsoleCommandResultSchema, FORBIDDEN_CONTROL_WORDS, HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { defaultPolicyFetcher, defaultSummaryDrafter } from '../../apps/api/src/modules/sources/ports.js';
import { AdminSourcesController, PublicSourcesController } from '../../apps/api/src/modules/sources/sources.controller.js';
import {
  ImportBatchViewSchema, PublicProvenanceSchema, SourceItemViewSchema, SourceViewSchema, SponsoredPolicyViewSchema, TakedownViewSchema, toHubSource,
} from '../../packages/contracts/src/sources.js';
import { Client, SKIP_REASON, startHarness, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, expectRefusal, PASSWORD, signIn } from '../admin/helpers.js';
import { buildSourcesWorld, DISPLAY_ONLY, OPEN_USES, type SourcesWorld } from './helpers.js';

/**
 * SRC-001 through the HTTP API on real PostgreSQL under the runtime role, with real sessions, TOTP and elevated
 * sessions: a steward registers a source and another activates it, robots.txt and RSL checks go through the fake
 * adapter port (nothing is recorded when a site does not answer), a batch is staged and activated by two people, an
 * editor turns an item into a CNT-001 draft (never published here), a display-only item never reaches the summary
 * drafter, takedowns write tombstones, sponsored content needs a second person through the approvals route, and the
 * public sees only provenance and the labelled slot. Negative authorization for anonymous callers, participants,
 * unelevated staff and staff without the permission (with a denied audit row).
 */
const h = await startHarness('sources_api');
type Staff = 'stewardA' | 'stewardB' | 'editorA' | 'editorB' | 'officerA' | 'officerB' | 'moderator';
const STAFF: Staff[] = ['stewardA', 'stewardB', 'editorA', 'editorB', 'officerA', 'officerB', 'moderator'];
const email = (k: string) => `sources-${k.toLowerCase()}@example.invalid`;

function apiFor(hubId: string): Promise<CreatedApp> {
  return createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
    pool: h!.pool, clock: h!.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
}

test('sources API: registry, checks, review queue, egress, takedown and sponsored policy', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: SourcesWorld = await buildSourcesWorld(h.db.admin, h.pool).catch(async (error: unknown) => { await h.close(); throw error; });
  const ids = w.people as Record<Staff | 'outsider', string>;
  await addLogins(h, ([...STAFF, 'outsider'] as const).map((k) => [ids[k], email(k)]));
  const previousHub = process.env.TRUSTWORK_HUB_ID;
  process.env.TRUSTWORK_HUB_ID = w.hubId;
  const app = await apiFor(w.hubId);
  t.after(async () => {
    await app.close();
    if (previousHub === undefined) delete process.env.TRUSTWORK_HUB_ID; else process.env.TRUSTWORK_HUB_ID = previousHub;
    await h.close();
  });
  const c = {} as Record<Staff | 'outsider', Client>;
  const secrets = {} as Record<Staff, Buffer>;
  for (const key of [...STAFF, 'outsider'] as const) {
    c[key] = new Client(app);
    await signIn(c[key], email(key));
    if (key !== 'outsider') secrets[key] = await enrolNow(h, c[key]);
  }
  const elevate = async (...keys: Staff[]) => {
    h.clock.advance(30_000);
    for (const key of keys) {
      assert.equal((await c[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
      const r = await c[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]) } }, { idempotencyKey: null });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  };
  const command = (key: Staff | 'outsider', url: string, body: Record<string, unknown> = {}, idempotencyKey = `src-${randomUUID()}`): Promise<Response> =>
    c[key].post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic registry action', ...body }, { idempotencyKey });
  const ok = <T = Record<string, unknown>>(r: Response, status = 200): T => {
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r.body as T;
  };
  const base = `/v1/admin/hubs/${w.hubId}`;
  const registration = (over: Record<string, unknown> = {}) => ({
    kind: 'rss', name: 'Synthetic Trade Journal', url: 'https://allow.synthetic-journal.example/feed.xml', ownerPersonId: ids.stewardA, readerKind: 'industry_media',
    purposes: ['news_desk'], licence: { kind: 'open_licence', name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', agreementRef: null }, allowedUses: OPEN_USES,
    attributionTemplate: 'Source: Synthetic Trade Journal', takedownContact: 'rights@synthetic-journal.example', personalData: false, legalBasis: null, ...over,
  });
  type SourceBody = { result: { outcome: string; objectId: string; revision: number; approvalRequestId: string | null }; source: { id: string; revision: number; status: string; allowedUses: Record<string, boolean>; rsl: { status: string } } };
  const register = async (over: Record<string, unknown> = {}) => {
    const created = ok<SourceBody>(await command('stewardA', `${base}/sources`, registration(over)), 201);
    return ok<SourceBody>(await command('stewardB', `${base}/sources/${created.source.id}/status`, { expectedRevision: created.source.revision, to: 'active' })).source;
  };
  const stageAndActivate = async (sourceId: string, items: Record<string, unknown>[], fields: Record<string, unknown>[] = []) => {
    const staged = ok<{ batch: { id: string; revision: number } }>(await command('stewardA', `${base}/sources/${sourceId}/batches`, { items, fields, links: [] }), 201);
    ok(await command('stewardB', `${base}/import-batches/${staged.batch.id}/decide`, { expectedRevision: staged.batch.revision, decision: 'activate' }));
    return ok<{ items: Array<{ id: string; revision: number; externalId: string }> }>(await c.editorA.get(`${base}/import-batches/${staged.batch.id}`)).items;
  };
  const stagedItem = (n: string, over: Record<string, unknown> = {}) => ({ externalId: `api-${n}`, url: `https://allow.synthetic-journal.example/news/${n}`, title: `Synthetic news ${n}`, summary: null, fullText: null, sourceTime: '2026-10-28T08:00:00.000Z', sponsored: null, ...over });

  await t.test('negative: anonymous callers, participants and unelevated staff never reach the registry', async () => {
    expectRefusal(await new Client(app).get(`${base}/sources`), 401, 'auth.session_invalid');
    expectRefusal(await c.outsider.get(`${base}/sources`), 403, 'access.forbidden', 'staff');
    expectRefusal(await command('outsider', `${base}/sources`, registration()), 403, 'access.forbidden', 'staff');
    expectRefusal(await c.stewardA.get(`${base}/sources`), 403, 'access.forbidden', 'elevation');
    expectRefusal(await command('stewardA', `${base}/sources`, registration()), 403, 'access.forbidden', 'elevation');
  });

  await elevate(...STAFF);

  await t.test('a steward registers, another activates; staff without the permission are refused with a denied audit row', async () => {
    expectRefusal(await command('moderator', `${base}/sources`, registration()), 403, 'access.forbidden', 'forbidden');
    const denied = await h.db.admin.query("SELECT outcome, reason_code FROM trustwork.admin_audit_event WHERE actor_person_id = $1 AND action = 'source.registered'", [ids.moderator]);
    assert.deepEqual(denied.rows, [{ outcome: 'denied', reason_code: 'denied_forbidden' }]);
    expectRefusal(await command('stewardA', `${base}/sources`, { ...registration(), score: 5 }), 422, 'validation.unknown_field');
    expectRefusal(await command('stewardA', `${base}/sources`, registration({ licence: { kind: 'unknown', name: null, url: null, agreementRef: null } })), 422, 'validation.schema');
    const key = `src-${randomUUID()}`;
    const created = ok<SourceBody>(await command('stewardA', `${base}/sources`, registration(), key), 201);
    ConsoleCommandResultSchema.parse(created.result);
    assert.deepEqual(ok(await command('stewardA', `${base}/sources`, registration(), key), 201), created, 'a retry replays the result');
    expectRefusal(await command('stewardA', `${base}/sources/${created.source.id}/status`, { expectedRevision: created.source.revision, to: 'active' }), 403, 'access.forbidden', 'self_activation');
    const active = ok<SourceBody>(await command('stewardB', `${base}/sources/${created.source.id}/status`, { expectedRevision: created.source.revision, to: 'active' }));
    assert.equal(active.source.status, 'active');
    const detail = ok<{ source: unknown }>(await c.editorA.get(`${base}/sources/${created.source.id}`));
    const view = SourceViewSchema.parse(detail.source);
    assert.equal(toHubSource(view).status, 'active', 'the console HubSource form');
    expectRefusal(await c.moderator.get(`${base}/sources/${created.source.id}`), 404, 'access.not_found');
    expectRefusal(await c.stewardA.get(`/v1/admin/hubs/${w.otherHubId}/sources/${created.source.id}`), 404, 'access.not_found');
  });

  await t.test('robots.txt and RSL checks go through the adapter port; an unreachable site records nothing', async () => {
    const page = ok<SourceBody>(await command('stewardA', `${base}/sources`, registration({ kind: 'web_page', name: 'Synthetic Manufacturer Guides', url: 'https://restricted.synthetic-maker.example/guides/drainage' })), 201);
    const before = defaultPolicyFetcher.calls.length;
    const robots = ok<{ crawlPolicy: { allowed: boolean; status: string; crawlDelaySeconds: number; licenceUrls: string[]; robotsDigest: string } }>(await command('stewardA', `${base}/sources/${page.source.id}/robots-check`, { userAgent: 'TrustworkSourcesBot/1.0' }));
    assert.deepEqual([robots.crawlPolicy.allowed, robots.crawlPolicy.status, robots.crawlPolicy.crawlDelaySeconds], [true, 'restricted', 5]);
    assert.deepEqual(robots.crawlPolicy.licenceUrls, ['/license-search.xml']);
    assert.equal(defaultPolicyFetcher.calls.length, before + 1);
    const unreachable = ok<SourceBody>(await command('stewardA', `${base}/sources`, registration({ kind: 'web_page', url: 'https://offline.synthetic-maker.example/' })), 201);
    expectRefusal(await command('stewardA', `${base}/sources/${unreachable.source.id}/robots-check`, { userAgent: 'TrustworkSourcesBot' }), 409, 'validation.revision_conflict', 'source_unreachable');
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.crawl_policy WHERE source_id = $1', [unreachable.source.id])).rowCount, 0);
    // RSL: a search-only document narrows the flags at once; a broken one closes every flag.
    const feed = await register({ name: 'Synthetic RSL Journal' });
    const search = ok<SourceBody & { reading: { status: string; suggested: Record<string, boolean> } }>(await command('stewardA', `${base}/sources/${feed.id}/rsl-check`, { rslUrl: 'https://allow.synthetic-journal.example/license-search.xml' }));
    assert.equal(search.reading.status, 'parsed');
    assert.equal(search.source.allowedUses.sendToModelProviders, false);
    assert.equal(search.source.status, 'active');
    const broken = ok<SourceBody & { reading: { status: string } }>(await command('stewardA', `${base}/sources/${feed.id}/rsl-check`, { rslUrl: 'https://allow.synthetic-journal.example/license-broken.xml' }));
    assert.equal(broken.reading.status, 'failed');
    assert.ok(Object.values(broken.source.allowedUses).every((v) => v === false), 'acceptance: an RSL parsing failure leaves the most restrictive flags');
    const absent = ok<SourceBody & { reading: null }>(await command('stewardA', `${base}/sources/${feed.id}/rsl-check`, { rslUrl: 'https://allow.synthetic-journal.example/none.xml' }));
    assert.equal(absent.reading, null);
    assert.equal(absent.source.rsl.status, 'absent');
    assert.ok(Object.values(absent.source.allowedUses).every((v) => v === false), 'an absent document never widens the flags back');
    expectRefusal(await command('stewardA', `${base}/sources/${feed.id}/rsl-check`, { rslUrl: 'https://down.synthetic-journal.example/license-open.xml' }), 409, 'validation.revision_conflict', 'source_unreachable');
  });

  let draftedItemId = '';
  await t.test('acceptance: the review queue; only a person turns an item into a publication draft, which is not published', async () => {
    const feed = await register({ name: 'Synthetic Queue Journal' });
    const staged = ok<{ batch: { id: string; revision: number } }>(await command('stewardA', `${base}/sources/${feed.id}/batches`, { items: [stagedItem('q1', { summary: 'Synthetic summary of q1' }), stagedItem('q2')], fields: [], links: [] }), 201);
    ImportBatchViewSchema.parse(staged.batch);
    expectRefusal(await command('stewardA', `${base}/import-batches/${staged.batch.id}/decide`, { expectedRevision: staged.batch.revision, decision: 'activate' }), 403, 'access.forbidden', 'self_activation');
    const items = ok<{ items: Array<{ id: string; revision: number }> }>(await c.editorA.get(`${base}/import-batches/${staged.batch.id}`)).items;
    expectRefusal(await command('editorA', `${base}/source-items/${items[0]!.id}/decide`, { expectedRevision: items[0]!.revision, decision: 'discard', treatment: null, language: null, credit: null, eventTime: null, useAssistedSummary: false }), 409, 'validation.revision_conflict', 'batch_not_activated');
    ok(await command('stewardB', `${base}/import-batches/${staged.batch.id}/decide`, { expectedRevision: staged.batch.revision, decision: 'activate' }));
    const queue = ok<{ items: unknown[] }>(await c.editorA.get(`${base}/source-items/queue`)).items.map((i) => SourceItemViewSchema.parse(i));
    assert.ok(queue.some((i) => i.id === items[0]!.id) && queue.every((i) => i.status === 'queued'));
    expectRefusal(await command('editorA', `${base}/source-items/${items[0]!.id}/decide`, { expectedRevision: items[0]!.revision, decision: 'publish', treatment: 'summary', language: 'en', credit: 'Synthetic editorial office', eventTime: null, useAssistedSummary: false }), 422, 'validation.schema');
    const decided = ok<{ item: { status: string; publicationId: string; decidedBy: string }; publicationId: string }>(await command('editorA', `${base}/source-items/${items[0]!.id}/decide`, {
      expectedRevision: items[0]!.revision, decision: 'draft', treatment: 'summary', language: 'en', credit: 'Synthetic editorial office', eventTime: null, useAssistedSummary: false,
    }));
    assert.deepEqual([decided.item.status, decided.item.decidedBy, decided.item.publicationId], ['drafted', ids.editorA, decided.publicationId]);
    draftedItemId = items[0]!.id;
    const managed = ok<{ publication: { status: string }; draft: { treatment: string; sources: Array<{ allowedUses: Record<string, boolean>; kind: string }> } }>(await c.editorA.get(`/v1/publications/${decided.publicationId}/manage`));
    assert.equal(managed.publication.status, 'draft');
    assert.equal(managed.draft.treatment, 'summary');
    assert.deepEqual([managed.draft.sources[0]?.kind, managed.draft.sources[0]?.allowedUses.displaySummary], ['industry_media', true]);
    expectRefusal(await new Client(app).get(`/v1/publications/${decided.publicationId}`), 404, 'access.not_found');
    const replay = await command('editorA', `${base}/source-items/${items[1]!.id}/decide`, { expectedRevision: items[1]!.revision, decision: 'discard', treatment: null, language: null, credit: null, eventTime: null, useAssistedSummary: false });
    assert.equal(ok<{ item: { status: string } }>(replay).item.status, 'discarded');
    expectRefusal(await command('editorB', `${base}/source-items/${items[1]!.id}/decide`, { expectedRevision: items[1]!.revision + 1, decision: 'discard', treatment: null, language: null, credit: null, eventTime: null, useAssistedSummary: false }), 409, 'validation.revision_conflict', 'item_decided');
  });

  await t.test('acceptance: a display-only item never reaches the summary drafter (model provider)', async () => {
    const display = await register({ name: 'Synthetic Display-only Journal', allowedUses: DISPLAY_ONLY });
    const [item] = await stageAndActivate(display.id, [stagedItem('d1')]);
    const calls = defaultSummaryDrafter.calls.length;
    expectRefusal(await command('editorA', `${base}/source-items/${item!.id}/assisted-summary`, { expectedRevision: item!.revision, language: 'en' }), 422, 'validation.schema', 'licence_forbids_model_use');
    assert.equal(defaultSummaryDrafter.calls.length, calls, 'the drafter was never called');
    const open = await register({ name: 'Synthetic Open Journal' });
    const [openItem] = await stageAndActivate(open.id, [stagedItem('o1', { summary: 'Synthetic summary', fullText: 'Synthetic full text of o1' })]);
    const assisted = ok<{ item: { assistedSummary: { label: string; text: string } } }>(await command('editorA', `${base}/source-items/${openItem!.id}/assisted-summary`, { expectedRevision: openItem!.revision, language: 'en' }));
    assert.equal(assisted.item.assistedSummary.label, 'machine_assisted');
    assert.equal(defaultSummaryDrafter.calls.length, calls + 1);
    assert.equal(defaultSummaryDrafter.calls.at(-1)?.text, 'Synthetic full text of o1');
  });

  await t.test('takedown of an item and of a source writes tombstones and names the publications to retract', async () => {
    const feed = await register({ name: 'Synthetic Takedown Journal' });
    const record = randomUUID();
    const [first, second] = await stageAndActivate(feed.id, [stagedItem('t1'), stagedItem('t2')], [{ recordKind: 'company', recordId: record, field: 'legalName', value: 'Synthetic Takedown LLC', itemExternalId: 'api-t1' }]);
    const provenance = PublicProvenanceSchema.parse(ok(await new Client(app).get(`/v1/hubs/${w.hubId}/sourced-records/company/${record}/provenance`)));
    assert.deepEqual([provenance.label, provenance.fields[0]?.value], ['sourced', 'Synthetic Takedown LLC']);
    expectRefusal(await command('editorA', `${base}/source-items/${first!.id}/takedown`, { reasonCategory: 'legal_demand', note: 'Synthetic' }), 403, 'access.forbidden', 'forbidden');
    const one = TakedownViewSchema.parse(ok<{ takedown: unknown }>(await command('stewardA', `${base}/source-items/${first!.id}/takedown`, { reasonCategory: 'rights_holder_request', note: 'Synthetic rights holder request' })).takedown);
    assert.deepEqual([one.itemsTakenDown, one.fieldsDeactivated], [1, 1]);
    assert.deepEqual(one.tombstones.map((x) => `${x.channel}:${x.targetKind}`).sort(), ['federation:source_item', 'federation:sourced_record', 'retrieval:source_item', 'retrieval:sourced_record']);
    expectRefusal(await new Client(app).get(`/v1/hubs/${w.hubId}/sourced-records/company/${record}/provenance`), 404, 'access.not_found');
    const all = TakedownViewSchema.parse(ok<{ takedown: unknown }>(await command('stewardB', `${base}/sources/${feed.id}/takedown`, { reasonCategory: 'licence_ended', note: 'Synthetic licence ended' })).takedown);
    assert.equal(all.itemsTakenDown, 1, 'the remaining item');
    assert.ok(all.tombstones.every((x) => x.reason === 'licence_ended'));
    assert.equal(ok<{ item: { status: string } }>(await c.stewardA.get(`${base}/source-items/${second!.id}`)).item.status, 'taken_down');
    assert.deepEqual(ok<{ takedown: unknown }>(await c.stewardA.get(`${base}/source-takedowns/${all.id}`)).takedown, all);
    // The source of the draft made earlier: its takedown names that publication for the editor-in-chief.
    const drafted = ok<{ item: { sourceId: string; publicationId: string } }>(await c.stewardA.get(`${base}/source-items/${draftedItemId}`)).item;
    const named = TakedownViewSchema.parse(ok<{ takedown: unknown }>(await command('stewardA', `${base}/sources/${drafted.sourceId}/takedown`, { reasonCategory: 'court_order', note: 'Synthetic court order' })).takedown);
    assert.deepEqual(named.publicationIds, [drafted.publicationId]);
  });

  await t.test('sponsored content: off by default; switching it on asks a second person through the approvals route', async () => {
    const initial = SponsoredPolicyViewSchema.parse(ok<{ policy: unknown }>(await c.officerA.get(`${base}/sponsored-policy`)).policy);
    assert.deepEqual([initial.version, initial.allowed, initial.maxSlotsPerPage, initial.affectsRankingOrMatching], [0, false, 0, false]);
    assert.deepEqual(ok<{ items: unknown[]; label: string }>(await new Client(app).get(`/v1/hubs/${w.hubId}/sponsored-slot`)).items, []);
    expectRefusal(await command('stewardA', `${base}/sponsored-policy`, { allowed: false, maxSlotsPerPage: 0, requireVerifiedSponsor: true, approvalId: null }), 403, 'access.forbidden', 'forbidden');
    const body = { allowed: true, maxSlotsPerPage: 1, requireVerifiedSponsor: false };
    const pending = ok<{ result: { outcome: string; approvalRequestId: string }; approvalDigest: string }>(await command('officerA', `${base}/sponsored-policy`, { ...body, approvalId: null }));
    assert.equal(pending.result.outcome, 'pending_second_person');
    const approvalId = pending.result.approvalRequestId;
    expectRefusal(await command('officerA', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: pending.approvalDigest }), 403, 'access.second_approver_required');
    ok(await command('officerB', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: pending.approvalDigest }));
    expectRefusal(await command('officerB', `${base}/sponsored-policy`, { ...body, approvalId }), 403, 'access.approval_required', 'not_requester');
    const applied = ok<{ result: { outcome: string }; policy: { allowed: boolean; version: number; readerLabel: boolean } }>(await command('officerA', `${base}/sponsored-policy`, { ...body, approvalId }));
    assert.deepEqual([applied.result.outcome, applied.policy.allowed, applied.policy.version, applied.policy.readerLabel], ['applied', true, 1, true]);
    const feed = await register({ name: 'Synthetic Sponsor Feed' });
    const [sponsored] = await stageAndActivate(feed.id, [stagedItem('s1', { sponsored: { sponsorName: 'Synthetic Sponsor Inc.' } })]);
    ok(await command('editorA', `${base}/source-items/${sponsored!.id}/decide`, { expectedRevision: sponsored!.revision, decision: 'draft', treatment: 'headline_link', language: 'en', credit: 'Synthetic editorial office', eventTime: null, useAssistedSummary: false }));
    const slot = ok<{ label: string; items: Array<{ itemId: string; sponsorName: string }> }>(await new Client(app).get(`/v1/hubs/${w.hubId}/sponsored-slot`));
    assert.deepEqual([slot.label, slot.items.map((x) => x.itemId)], ['sponsored', [sponsored!.id]]);
    const item = SourceItemViewSchema.parse(ok<{ item: unknown }>(await c.editorA.get(`${base}/source-items/${sponsored!.id}`)).item);
    assert.deepEqual(item.sponsored, { sponsorName: 'Synthetic Sponsor Inc.', label: 'sponsored' });
    const off = ok<{ result: { outcome: string }; policy: { allowed: boolean } }>(await command('officerB', `${base}/sponsored-policy`, { allowed: false, maxSlotsPerPage: 0, requireVerifiedSponsor: true, approvalId: null }));
    assert.deepEqual([off.result.outcome, off.policy.allowed], ['applied', false]);
    assert.deepEqual(ok<{ items: unknown[] }>(await new Client(app).get(`/v1/hubs/${w.hubId}/sponsored-slot`)).items, []);
  });

  await t.test('record links through the API and no route path carries a ranking word', async () => {
    const proposed = ok<{ link: { id: string; revision: number; state: string } }>(await command('stewardA', `${base}/record-links`, { left: { kind: 'company', id: w.content.company }, rightLocalId: randomUUID(), rightGlobalId: null, evidence: 'identifier_match' }), 201);
    expectRefusal(await command('stewardA', `${base}/record-links/${proposed.link.id}/decide`, { expectedRevision: proposed.link.revision, decision: 'accept' }), 403, 'access.forbidden', 'self_review');
    assert.equal(ok<{ link: { state: string } }>(await command('stewardB', `${base}/record-links/${proposed.link.id}/decide`, { expectedRevision: proposed.link.revision, decision: 'accept' })).link.state, 'accepted');
    for (const controller of [AdminSourcesController, PublicSourcesController]) {
      const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
      for (const key of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as unknown as Record<string, unknown>)[key];
        if (typeof handler !== 'function' || key === 'constructor') continue;
        const path = `${prefix}/${(Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? ''}`;
        assert.ok(!FORBIDDEN_CONTROL_WORDS.test(path.replace(/\/v1\//, '/')), path);
      }
    }
  });
});
