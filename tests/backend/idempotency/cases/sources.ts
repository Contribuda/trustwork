import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import type { Client, Response } from '../../helpers/app.js';
import { count } from '../../hardening/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';

/** Test role definition over the console vocabulary (version 21, unused elsewhere), held at this case's own hub. */
const VERSION = 21;
const PERMISSIONS = [
  'admin.sources.read', 'admin.sources.manage', 'admin.sources.takedown', 'admin.sources.import.activate', 'admin.sources.dedupe.decide', 'admin.links.decide',
  'admin.publications.review', 'admin.sponsored.policy.edit',
];
const USES = {
  displayHeadlineAndLink: true, displaySummary: true, storeFullText: true, indexForSearch: true, sendToModelProviders: true, translate: true, rewriteWithAttribution: true,
  reuseImages: true, syndicateToPeers: true,
};

/**
 * SRC-001: every source registry route classified in_transaction, through the BE-005 crash sequence. Runs after the
 * ADM-001 case, whose founding platform owner grants two synthetic data stewards at this case's synthetic hub
 * (maintenance path, as the setup wizard would). Steward A registers, checks, stages and takes down; steward B activates
 * the source and the batch and decides items, so every separation-of-duties rule holds. The robots.txt, RSL and drafter
 * calls go to the synthetic fakes. Every person, hub and site is synthetic.
 */
export default {
  name: 'SRC-001: hub source registry, import review, takedown and sponsored policy',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const hubId = '00000000-0000-4000-8000-00000000c501';
    const people = await withMaintenance(admin, async (trx) => {
      await trx.insertInto('hub').values({ id: hubId, slug: `synthetic-src-${randomBytes(2).toString('hex')}`, lifecycle: 'public' }).execute();
      await trx.insertInto('staff_role_definition_version').values({ role: 'data-steward', version: VERSION, scopes: ['hub'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' })
        .onConflict((oc) => oc.doNothing()).execute();
      const founder = await trx.selectFrom('staff_role_assignment').select('person_id').where('setup_bootstrap', '=', true).where('role', '=', 'platform-owner').executeTakeFirstOrThrow();
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      const out = { a: await person('Synthetic Crash Steward A'), b: await person('Synthetic Crash Steward B') };
      for (const id of [out.a, out.b]) {
        await trx.insertInto('staff_role_assignment').values({ person_id: id, role: 'data-steward', scope_kind: 'hub', hub_id: hubId, definition_version: VERSION, granted_by: founder.person_id, reason: 'Synthetic crash test' }).execute();
      }
      return out;
    });
    const email = (k: string) => `crash-sources-${k}@example.invalid`;
    await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
    const clients = {} as Record<'a' | 'b', Client>;
    for (const key of ['a', 'b'] as const) {
      h.staff.set(people[key], ['data-steward']);
      clients[key] = h.client();
      await signIn(clients[key], email(key));
      const secret = await enrolNow(h, clients[key]);
      h.clock.advance(30_000);
      assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
      const elevated = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
      assert.equal(elevated.status, 200, `elevate ${key}: ${JSON.stringify(elevated.body)}`);
      h.clock.reset();
    }
    const { a, b } = clients;
    const body = <T>(r: Response): T => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body)); return r.body as T; };
    const cmd = (action: string, rest: Record<string, unknown>) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const run = (action: string, client: Client, url: string, rest: Record<string, unknown>, effects: () => Promise<number>) => exactlyOnce({ action, client, url, body: cmd(action, rest), effects });
    const audits = (action: string, objectId?: string) => () => count(admin, `SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1 AND outcome = 'applied' AND hub_id = $2${objectId ? ' AND object_id = $3' : ''}`, objectId ? [action, hubId, objectId] : [action, hubId]);
    const base = `/v1/admin/hubs/${hubId}`;
    const terms = {
      readerKind: 'industry_media', purposes: ['news_desk'], licence: { kind: 'open_licence', name: 'CC BY 4.0', url: null, agreementRef: null }, allowedUses: USES,
      attributionTemplate: 'Source: Synthetic Crash Journal', takedownContact: 'rights@synthetic-crash.example', personalData: false, legalBasis: null,
    };
    type SourceBody = { source: { id: string; revision: number } };
    const sourceNow = async (id: string) => body<SourceBody>(await a.get(`${base}/sources/${id}`)).source;
    const itemNow = async (id: string) => body<{ item: { id: string; revision: number } }>(await b.get(`${base}/source-items/${id}`)).item;

    // Registry: register, terms, terms check, robots.txt check, activation by the other steward, RSL check.
    const created = body<SourceBody>(await run('sources.register', a, `${base}/sources`, { kind: 'rss', name: 'Synthetic Crash Journal', url: 'https://allow.synthetic-crash.example/feed.xml', ownerPersonId: people.a, ...terms },
      () => count(admin, 'SELECT 1 FROM trustwork.source WHERE hub_id = $1', [hubId])));
    const sourceId = created.source.id;
    await run('sources.terms_set', a, `${base}/sources/${sourceId}/terms`, { expectedRevision: created.source.revision, ...terms, attributionTemplate: 'Source: Synthetic Crash Journal (CC BY 4.0)' },
      audits('source.terms_set', sourceId));
    let s = await sourceNow(sourceId);
    await run('sources.terms_record', a, `${base}/sources/${sourceId}/terms-check`, { expectedRevision: s.revision, termsUrl: 'https://allow.synthetic-crash.example/terms', termsDigest: 'a'.repeat(64), automatedAccess: 'permitted', notes: 'Synthetic' },
      audits('source.terms_recorded', sourceId));
    await run('sources.robots_check', a, `${base}/sources/${sourceId}/robots-check`, { userAgent: 'TrustworkSourcesBot' },
      () => count(admin, 'SELECT 1 FROM trustwork.crawl_policy WHERE source_id = $1', [sourceId]));
    s = await sourceNow(sourceId);
    await run('sources.status', b, `${base}/sources/${sourceId}/status`, { expectedRevision: s.revision, to: 'active' }, audits('source.activated', sourceId));
    await run('sources.rsl_check', a, `${base}/sources/${sourceId}/rsl-check`, { rslUrl: 'https://allow.synthetic-crash.example/license-open.xml' }, audits('source.rsl_recorded', sourceId));

    // Import and review: stage, activate, assisted summary, decision, item takedown.
    const items = [1, 2, 3].map((n) => ({ externalId: `crash-${n}`, url: `https://allow.synthetic-crash.example/news/${n}`, title: `Synthetic crash item ${n}`, summary: n === 1 ? 'Synthetic summary' : null, fullText: n === 1 ? 'Synthetic full text' : null, sourceTime: null, sponsored: null }));
    const staged = body<{ batch: { id: string; revision: number } }>(await run('sources.batch_stage', a, `${base}/sources/${sourceId}/batches`, { items, fields: [], links: [] },
      () => count(admin, 'SELECT 1 FROM trustwork.import_batch WHERE source_id = $1', [sourceId])));
    await run('sources.batch_decide', b, `${base}/import-batches/${staged.batch.id}/decide`, { expectedRevision: staged.batch.revision, decision: 'activate' }, audits('import_batch.activated', staged.batch.id));
    const rows = body<{ items: Array<{ id: string; externalId: string }> }>(await b.get(`${base}/import-batches/${staged.batch.id}`)).items;
    const byExt = (ext: string) => rows.find((r) => r.externalId === ext)!.id;
    let i1 = await itemNow(byExt('crash-1'));
    await run('sources.item_assist', b, `${base}/source-items/${i1.id}/assisted-summary`, { expectedRevision: i1.revision, language: 'en' }, audits('source_item.assisted', i1.id));
    i1 = await itemNow(i1.id);
    await run('sources.item_decide', b, `${base}/source-items/${i1.id}/decide`, { expectedRevision: i1.revision, decision: 'draft', treatment: 'summary', language: 'en', credit: 'Synthetic editorial office', eventTime: '2026-10-28T08:00:00.000Z', useAssistedSummary: true },
      audits('source_item.drafted', i1.id));
    await run('sources.item_takedown', a, `${base}/source-items/${byExt('crash-2')}/takedown`, { reasonCategory: 'rights_holder_request', note: 'Synthetic rights holder request' },
      () => count(admin, "SELECT 1 FROM trustwork.source_takedown WHERE source_id = $1 AND target_kind = 'source_item'", [sourceId]));

    // Links and the sponsored policy (switching it off applies without a second person).
    const link = body<{ link: { id: string; revision: number } }>(await run('sources.link_propose', a, `${base}/record-links`, { left: { kind: 'company', id: randomUUID() }, rightLocalId: randomUUID(), rightGlobalId: null, evidence: 'identifier_match' },
      () => count(admin, 'SELECT 1 FROM trustwork.record_link_proposal WHERE hub_id = $1', [hubId])));
    await run('sources.link_decide', b, `${base}/record-links/${link.link.id}/decide`, { expectedRevision: link.link.revision, decision: 'accept' }, audits('record_link.accepted', link.link.id));
    await run('sources.sponsored_policy_set', a, `${base}/sponsored-policy`, { allowed: false, maxSlotsPerPage: 0, requireVerifiedSponsor: true, approvalId: null },
      () => count(admin, 'SELECT 1 FROM trustwork.sponsored_content_policy WHERE hub_id = $1', [hubId]));

    // Source takedown last: tombstones and the reason, once.
    await run('sources.takedown', b, `${base}/sources/${sourceId}/takedown`, { reasonCategory: 'licence_ended', note: 'Synthetic licence ended' },
      () => count(admin, "SELECT 1 FROM trustwork.source_takedown WHERE source_id = $1 AND target_kind = 'source'", [sourceId]));
    assert.equal(await count(admin, "SELECT 1 FROM trustwork.source_tombstone t JOIN trustwork.source_takedown d ON d.id = t.takedown_id WHERE d.source_id = $1 AND d.target_kind = 'source' AND t.target_kind = 'source'", [sourceId]), 1);
  },
} satisfies CrashCase;
