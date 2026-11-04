import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import { legalActivationDigestInput } from '../../packages/contracts/src/hub-core.js';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { legalDocuments } from '../../packages/data/src/repositories/hubs.js';
import type { LegalDocumentVersionRow } from '../../packages/data/src/schema/hubs.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { actors, buildHubWorld, rejects, syncKernel, US_HUB } from './helpers.js';

const db = await provisionTestDatabase('legal_drafter');

/**
 * HUB-001 audit fix on real PostgreSQL under the runtime role: the drafter of a legal document neither asks for its
 * activation nor executes it, as for a sensitive configuration version. Every person, hub and text is synthetic.
 */
test('a legal document is activated by someone other than its drafter (HUB-001)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await syncKernel(db.admin);
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 6 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w = await buildHubWorld(db.admin);
  const a = actors(db.admin, runtime, w);
  const p = w.people;
  await a.assignSensitive({ personId: p.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hub = (await a.createHub(`synthetic-legal-${randomBytes(3).toString('hex')}`, { ...US_HUB, countryPack: null })).hub_id;
  const scope = { kind: 'hub', hubId: hub } as const;
  await a.assignSensitive({ personId: p.owner, role: 'hub-owner', scope });
  await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope });

  const draft = (by: string, kind: 'terms' | 'privacy_notice' | 'community_rules') => a.cmd(by, (trx, ctx) => legalDocuments.draft(trx, ctx, hub, { kind, locale: 'en', body: `Synthetic ${kind} text` }));
  const counsel = (d: LegalDocumentVersionRow) => a.cmd(p.owner, (trx, ctx) => legalDocuments.recordCounselApproval(trx, ctx, hub, { documentVersionIds: [d.id], counselName: 'Synthetic Counsel', firm: 'Synthetic Firm LLP',
    approvedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), scopeNote: 'Synthetic scope' }));
  const digestOf = (d: LegalDocumentVersionRow, counselApprovalId: string) => computeDigest(legalActivationDigestInput({ id: d.id, hubId: hub, kind: d.kind as 'terms', locale: d.locale, version: d.version, bodyDigest: d.body_digest, counselApprovalId })).value;
  const ask = (by: string, actionDigest: string) => a.cmd(by, (trx, ctx) => approvals.request(trx, ctx, { action: 'legal.activate_document_version', scope, actionDigest }));

  await t.test('the drafter cannot ask for the activation of their own document, by any route', async () => {
    const d = await draft(p.owner, 'terms');
    const c = await counsel(d);
    await rejects(ask(p.owner, digestOf(d, c.id)), '42501', 'admin.self_approval');
    const none = await db.admin.query('SELECT 1 FROM trustwork.second_person_approval WHERE action_digest = $1', [digestOf(d, c.id)]);
    assert.equal(none.rowCount, 0);
  });

  await t.test('another staff member asks, the drafter may approve, and that staff member activates', async () => {
    const d = await draft(p.owner, 'privacy_notice');
    const c = await counsel(d);
    const digest = digestOf(d, c.id);
    const request = await ask(p.officer, digest);
    await a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    const active = await a.cmd(p.officer, (trx, ctx) => legalDocuments.activate(trx, ctx, d.id, null, request.id));
    assert.deepEqual([active.status, active.activated_by], ['active', p.officer]);
  });

  await t.test('an approval the drafter already holds cannot put the text into force', async () => {
    // Asked before any counsel approval existed, so no digest at the request could name the document as the drafter's.
    const d = await draft(p.owner, 'community_rules');
    const counselId = randomUUID();
    const digest = digestOf(d, counselId);
    const request = await ask(p.owner, digest);
    await a.cmd(p.officer, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    await withMaintenance(db.admin, (trx) => trx.insertInto('counsel_approval').values({ id: counselId, hub_id: hub, document_version_ids: [d.id], counsel_name: 'Synthetic Counsel', firm: 'Synthetic Firm LLP',
      approved_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), scope_note: 'Synthetic scope', recorded_by: p.owner } as never).execute());
    await rejects(a.cmd(p.owner, (trx, ctx) => legalDocuments.activate(trx, ctx, d.id, null, request.id)), '42501', 'admin.self_approval');
    const row = await db.admin.query<{ status: string }>('SELECT status FROM trustwork.legal_document_version WHERE id = $1', [d.id]);
    assert.equal(row.rows[0]!.status, 'draft');
    const still = await db.admin.query<{ status: string }>('SELECT status FROM trustwork.second_person_approval WHERE id = $1', [request.id]);
    assert.equal(still.rows[0]!.status, 'approved', 'nothing was consumed');
  });
});
